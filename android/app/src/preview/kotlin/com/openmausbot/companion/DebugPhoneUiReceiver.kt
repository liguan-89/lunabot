package com.openmausbot.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import com.openmausbot.companion.core.PhoneTool
import com.openmausbot.companion.phone.PhoneToolOutcome
import com.openmausbot.companion.phoneui.PhoneUiTaskExecutor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Preview-build only: runs phone-UI tool steps from a shell broadcast and
 * writes their outcomes to `files/phoneui-debug.json`.
 *
 * This is the on-device acceptance entry for the virtual-display slice when no
 * desktop server is attached: it drives exactly the executor the job channel
 * drives, so a successful LAUNCH followed by OBSERVE proves the shell helper,
 * the helper's own display and the per-display accessibility snapshot all
 * work. The *_LABEL steps re-observe and then tap, type or scroll an element
 * matched by its visible text or view id, the same observe-then-act loop a bot
 * runs, because refs die whenever the window changes. Declared only in the preview source set, refuses non-debuggable
 * builds, and is protected by android.permission.DUMP.
 */
class DebugPhoneUiReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return
        val app = context.applicationContext as? OpenMausApp ?: return
        val raw = intent.getStringExtra(EXTRA_STEPS) ?: return
        val steps = runCatching { Json.parseToJsonElement(raw).jsonArray }.getOrNull() ?: return
        val pending = goAsync()
        app.appScope.launch(Dispatchers.IO) {
            val executor = PhoneUiTaskExecutor(context)
            val results = buildJsonArray {
                for (step in steps.take(MAX_STEPS)) {
                    add(runStep(executor, step.jsonObject))
                }
            }
            runCatching {
                context.filesDir.resolve(RESULT_FILE).writeText(results.toString())
            }
            executor.release()
            pending.finish()
        }
    }

    private suspend fun runStep(executor: PhoneUiTaskExecutor, step: JsonObject) = buildJsonObject {
        val wire = step["tool"]?.jsonPrimitive?.content.orEmpty()
        put("tool", wire)
        when (wire) {
            WAIT_TOOL -> {
                val ms = step["args"]?.jsonObject?.get("ms")?.jsonPrimitive?.content?.toLongOrNull()
                    ?.coerceIn(0L, MAX_WAIT_MS) ?: 0L
                delay(ms)
                put("ok", true)
            }
            TAP_LABEL_TOOL -> tapLabel(executor, step, this)
            TYPE_LABEL_TOOL -> typeLabel(executor, step, this)
            SCROLL_LABEL_TOOL -> scrollLabel(executor, step, this)
            else -> runTool(executor, wire, step["args"]?.jsonObject ?: JsonObject(emptyMap()), this)
        }
    }

    private suspend fun runTool(
        executor: PhoneUiTaskExecutor,
        wire: String,
        arguments: JsonObject,
        out: JsonObjectBuilder,
    ) {
        val tool = PhoneTool.fromWire(wire)
        if (tool == null) {
            out.put("ok", false)
            out.put("error", "unknown tool")
            return
        }
        record(runCatching { executor.execute(tool, arguments) }.getOrNull(), out)
    }

    /**
     * Observe, find the element whose text, description or view id equals the
     * label, then run the real TAP tool against its fresh ref.
     */
    private suspend fun tapLabel(executor: PhoneUiTaskExecutor, step: JsonObject, out: JsonObjectBuilder) {
        val label = step["args"]?.jsonObject?.get("label")?.jsonPrimitive?.contentOrNull.orEmpty()
        if (label.isEmpty()) {
            out.put("ok", false)
            out.put("error", "missing label")
            return
        }
        out.put("label", label)
        val observed = runCatching {
            executor.execute(PhoneTool.UI_OBSERVE, JsonObject(emptyMap()))
        }.getOrNull()
        if (observed !is PhoneToolOutcome.Success) {
            out.put("ok", false)
            out.put("error", (observed as? PhoneToolOutcome.Failure)?.error ?: "observe failed")
            return
        }
        val match = observed.result["elements"]?.asArray()
            ?.firstOrNull { element ->
                val fields = element.jsonObject
                fields.matches(label, "text") ||
                    fields.matches(label, "description") ||
                    fields.matches(label, "viewId")
            }?.jsonObject
        val ref = match?.get("ref")?.jsonPrimitive?.contentOrNull
        if (match == null || ref == null) {
            out.put("ok", false)
            out.put("error", "label not found")
            return
        }
        out.put("matched", match)
        record(
            runCatching {
                executor.execute(PhoneTool.UI_TAP, buildJsonObject { put("ref", ref) })
            }.getOrNull(),
            out,
        )
    }

    /**
     * Observe, find an editable element by its view id or text, then run the
     * real TYPE tool. Password fields are refused by the tool itself.
     */
    private suspend fun typeLabel(executor: PhoneUiTaskExecutor, step: JsonObject, out: JsonObjectBuilder) {
        val args = step["args"]?.jsonObject
        val label = args?.get("label")?.jsonPrimitive?.contentOrNull.orEmpty()
        val text = args?.get("text")?.jsonPrimitive?.contentOrNull.orEmpty()
        if (label.isEmpty() || text.isEmpty()) {
            out.put("ok", false)
            out.put("error", "missing label or text")
            return
        }
        out.put("label", label)
        out.put("text", text)
        val observed = runCatching {
            executor.execute(PhoneTool.UI_OBSERVE, JsonObject(emptyMap()))
        }.getOrNull()
        if (observed !is PhoneToolOutcome.Success) {
            out.put("ok", false)
            out.put("error", (observed as? PhoneToolOutcome.Failure)?.error ?: "observe failed")
            return
        }
        val match = observed.result["elements"]?.asArray()
            ?.firstOrNull { element ->
                val fields = element.jsonObject
                fields.isEditable() &&
                    (fields.matches(label, "viewId") ||
                        fields.matches(label, "text") ||
                        fields.matches(label, "description"))
            }?.jsonObject
        val ref = match?.get("ref")?.jsonPrimitive?.contentOrNull
        if (match == null || ref == null) {
            out.put("ok", false)
            out.put("error", "editable label not found")
            return
        }
        out.put("matched", match)
        record(
            runCatching {
                executor.execute(
                    PhoneTool.UI_TYPE,
                    buildJsonObject {
                        put("ref", ref)
                        put("text", text)
                    },
                )
            }.getOrNull(),
            out,
        )
    }

    /**
     * Observe, find a scrollable element by its view id, text or description,
     * then run the real SCROLL tool on it.
     */
    private suspend fun scrollLabel(executor: PhoneUiTaskExecutor, step: JsonObject, out: JsonObjectBuilder) {
        val args = step["args"]?.jsonObject
        val label = args?.get("label")?.jsonPrimitive?.contentOrNull.orEmpty()
        val direction = args?.get("direction")?.jsonPrimitive?.contentOrNull.orEmpty().ifEmpty { "down" }
        if (label.isEmpty()) {
            out.put("ok", false)
            out.put("error", "missing label")
            return
        }
        out.put("label", label)
        out.put("direction", direction)
        val observed = runCatching {
            executor.execute(PhoneTool.UI_OBSERVE, JsonObject(emptyMap()))
        }.getOrNull()
        if (observed !is PhoneToolOutcome.Success) {
            out.put("ok", false)
            out.put("error", (observed as? PhoneToolOutcome.Failure)?.error ?: "observe failed")
            return
        }
        val match = observed.result["elements"]?.asArray()
            ?.firstOrNull { element ->
                val fields = element.jsonObject
                fields.isScrollable() &&
                    (fields.matches(label, "viewId") ||
                        fields.matches(label, "text") ||
                        fields.matches(label, "description"))
            }?.jsonObject
        val ref = match?.get("ref")?.jsonPrimitive?.contentOrNull
        if (match == null || ref == null) {
            out.put("ok", false)
            out.put("error", "scrollable label not found")
            return
        }
        out.put("matched", match)
        record(
            runCatching {
                executor.execute(
                    PhoneTool.UI_SCROLL,
                    buildJsonObject {
                        put("ref", ref)
                        put("direction", direction)
                    },
                )
            }.getOrNull(),
            out,
        )
    }

    private fun record(outcome: PhoneToolOutcome?, out: JsonObjectBuilder) {
        when (outcome) {
            is PhoneToolOutcome.Success -> {
                out.put("ok", true)
                out.put("result", outcome.result)
            }
            is PhoneToolOutcome.Failure -> {
                out.put("ok", false)
                out.put("error", outcome.error)
                out.put("code", outcome.code)
            }
            null -> {
                out.put("ok", false)
                out.put("error", "threw")
            }
        }
    }

    private fun kotlinx.serialization.json.JsonElement.asArray(): JsonArray? =
        runCatching { jsonArray }.getOrNull()

    private fun JsonObject.matches(label: String, field: String): Boolean =
        get(field)?.jsonPrimitive?.contentOrNull == label

    private fun JsonObject.isEditable(): Boolean =
        get("editable")?.jsonPrimitive?.booleanOrNull == true

    private fun JsonObject.isScrollable(): Boolean =
        get("scrollable")?.jsonPrimitive?.booleanOrNull == true

    companion object {
        const val ACTION = "com.openmausbot.companion.DEBUG_PHONE_UI"
        const val EXTRA_STEPS = "steps"
        private const val RESULT_FILE = "phoneui-debug.json"
        private const val MAX_STEPS = 10
        private const val WAIT_TOOL = "WAIT"
        private const val TAP_LABEL_TOOL = "TAP_LABEL"
        private const val TYPE_LABEL_TOOL = "TYPE_LABEL"
        private const val SCROLL_LABEL_TOOL = "SCROLL_LABEL"
        private const val MAX_WAIT_MS = 15_000L
    }
}