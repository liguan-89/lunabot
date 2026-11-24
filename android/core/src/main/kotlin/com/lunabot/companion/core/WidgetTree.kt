package com.lunabot.companion.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull


/**
 * The platform-neutral widget tree from `shared/widget.ts`, read-only on the
 * phone: the wire already carries the canonical shape (server-normalised), so
 * this file ports only the reading half — node access, the pressable-action
 * walk, fields and their values, and the press payload assembly. The server
 * re-validates every press (`resolveWidgetAction`), so the phone never parses
 * or normalises.
 */

const val WIDGET_FIELD_VALUE_LIMIT = 2_000
const val WIDGET_LABEL_LIMIT = 80

const val PHONE_PAIRING_ACTION = "open_phone_pairing"

val WIDGET_WEEKDAYS = listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")

private val FIELD_TYPES = setOf(
    "Select", "DatePicker", "TimePicker", "DayPicker",
    "Checkbox", "RadioGroup", "Input", "Textarea",
)

private val THREAD_ID = Regex("^[\\w-]{1,128}$")
private val ISO_DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
private val TIME_OF_DAY = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
private val CLOCK = Regex("^(\\d{1,2}):(\\d{2})$")
private const val DAY_MINUTES = 24 * 60

/** One canonical node: `type`, `id`, optional `children`, free-form props. */
class WidgetNode(val json: JsonObject) {
    val type: String get() = json["type"].asString() ?: ""
    val id: String get() = json["id"].asString() ?: ""
    val children: List<WidgetNode>
        get() = (json["children"] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { (it as? JsonObject)?.let(::WidgetNode) }
            ?: emptyList()

    fun str(key: String): String? = json[key].asString()
    fun num(key: String): Double? = (json[key] as? JsonPrimitive)?.doubleOrNull
    fun bool(key: String): Boolean = (json[key] as? JsonPrimitive)?.booleanOrNull == true
    operator fun get(key: String): JsonElement? = json[key]

    override fun toString(): String = json.toString()
}

private fun JsonElement?.asString(): String? = (this as? JsonPrimitive)?.contentOrNull

fun widgetString(node: WidgetNode, key: String): String? = node.str(key)
fun widgetNumber(node: WidgetNode, key: String): Double? = node.num(key)
fun kids(node: WidgetNode): List<WidgetNode> = node.children

/** A `{type, payload?}` action object, as stored on a canonical node. */
class WidgetAction(val json: JsonObject) {
    val type: String get() = json["type"].asString() ?: ""
    val payload: JsonElement? get() = json["payload"]
    val isClient: Boolean
        get() = type == "open_url" || type == "open_thread" || type == PHONE_PAIRING_ACTION
}

private fun WidgetNode.action(key: String): WidgetAction? =
    (json[key] as? JsonObject)?.let(::WidgetAction)

/** Where an `open_thread` action points: one of {botId, threadId} or {groupId, threadId}. */
sealed interface WidgetThreadTarget {
    val threadId: String
    data class Bot(val botId: String, override val threadId: String) : WidgetThreadTarget
    data class Group(val groupId: String, override val threadId: String) : WidgetThreadTarget
}

fun widgetThreadTarget(action: WidgetAction): WidgetThreadTarget? {
    if (action.type != "open_thread") return null
    val payload = action.payload as? JsonObject ?: return null
    val threadId = payload["threadId"].asString() ?: return null
    if (!THREAD_ID.matches(threadId)) return null
    val botId = payload["botId"].asString()
    val groupId = payload["groupId"].asString()
    return when {
        botId != null && THREAD_ID.matches(botId) && groupId == null -> WidgetThreadTarget.Bot(botId, threadId)
        groupId != null && THREAD_ID.matches(groupId) && botId == null -> WidgetThreadTarget.Group(groupId, threadId)
        else -> null
    }
}

/** The url an `open_url` action carries; only http(s) ever opens. */
fun widgetActionUrl(action: WidgetAction): String? {
    if (action.type != "open_url") return null
    val url = (action.payload as? JsonObject)?.get("url").asString() ?: return null
    return if (url.startsWith("http://", true) || url.startsWith("https://", true)) url else null
}

/** The `confirm`/`cancel` spec a Card or ListView root may carry. */
class WidgetButtonSpec(val label: String, val action: WidgetAction)

fun widgetButtonSpec(root: WidgetNode, key: String): WidgetButtonSpec? {
    val spec = root[key] as? JsonObject ?: return null
    val label = spec["label"].asString() ?: return null
    val action = (spec["action"] as? JsonObject)?.let(::WidgetAction) ?: return null
    return WidgetButtonSpec(label, action)
}

private fun walk(node: WidgetNode, ancestors: List<WidgetNode>, visit: (WidgetNode, List<WidgetNode>) -> Unit) {
    visit(node, ancestors)
    val next = ancestors + node
    for (child in node.children) walk(child, next, visit)
}

private fun walk(node: WidgetNode, visit: (WidgetNode, List<WidgetNode>) -> Unit) =
    walk(node, emptyList(), visit)

private inline fun <T> List<T>.lastOf(match: (T) -> Boolean): T? {
    for (index in indices.reversed()) if (match(this[index])) return this[index]
    return null
}

/** What a row is called: its first Title or Text, on one line, capped at the
 * label limit. A text held to a fixed width never names the row. */
fun firstText(node: WidgetNode): String {
    var found = ""
    walk(node) { inner, _ ->
        if (found.isNotEmpty()) return@walk
        if (inner.type != "Title" && inner.type != "Text") return@walk
        val value = inner.str("value") ?: return@walk
        if (inner["width"] is JsonPrimitive && inner.num("width") != null) return@walk
        found = value.replace(Regex("\\s+"), " ").trim().take(WIDGET_LABEL_LIMIT)
    }
    return found
}

/** One pressable thing on the card, in document order. */
class WidgetActionEntry(
    /** "confirm", "cancel", or the node id of the button or list item. */
    val ref: String,
    /** What the person is recorded as having said. */
    val label: String,
    val action: WidgetAction,
    /** Present when the press settles the widget. */
    val tone: String?,
    /** Handled on the device and never sent. */
    val client: Boolean,
    val kind: String,
)

fun widgetActions(root: WidgetNode): List<WidgetActionEntry> {
    data class Row(val entry: WidgetActionEntry, val row: String)
    val found = mutableListOf<Row>()
    walk(root) { node, ancestors ->
        if (node.type == "Button") {
            if (node.bool("disabled")) return@walk
            val form = ancestors.lastOf { it.type == "Form" }
            val own = node.action("onClickAction")
            val submitted = if (node.bool("submit")) form?.action("onSubmitAction") else null
            val picked = own ?: submitted ?: return@walk
            val row = ancestors.lastOf { it.type == "ListViewItem" || it.type == "Table.Row" || it.type == "Row" }
            found += Row(
                WidgetActionEntry(
                    ref = node.id,
                    label = widgetString(node, "label") ?: "",
                    action = picked,
                    tone = if (node.bool("submit")) "submit" else null,
                    client = picked.isClient,
                    kind = "button",
                ),
                row?.let(::firstText) ?: "",
            )
        } else if (node.type == "ListViewItem" && node.action("onClickAction") != null) {
            found += Row(
                WidgetActionEntry(
                    ref = node.id,
                    label = firstText(node),
                    action = node.action("onClickAction")!!,
                    tone = null,
                    client = node.action("onClickAction")!!.isClient,
                    kind = "item",
                ),
                "",
            )
        }
    }
    for (key in listOf("confirm", "cancel")) {
        val spec = widgetButtonSpec(root, key) ?: continue
        found += Row(
            WidgetActionEntry(key, spec.label, spec.action, key, spec.action.isClient, key),
            "",
        )
    }
    val counts = found.groupingBy { it.entry.label }.eachCount()
    return found.map { (entry, row) ->
        if (row.isNotEmpty() && entry.label.isNotEmpty() && (counts[entry.label] ?: 0) > 1) {
            WidgetActionEntry(entry.ref, "${entry.label}: $row".take(WIDGET_LABEL_LIMIT * 2), entry.action, entry.tone, entry.client, entry.kind)
        } else entry
    }
}

/** Where a press collects its values: the nearest Form around the pressed
 * node, or the whole widget. */
fun widgetScope(root: WidgetNode, ref: String): WidgetNode {
    var scope = root
    walk(root) { node, ancestors ->
        if (node.id == ref) scope = ancestors.lastOf { it.type == "Form" } ?: root
    }
    return scope
}

class WidgetField(
    val name: String,
    val type: String,
    /** Its Label's text, else a Checkbox's own label, else its name. */
    val label: String,
    val node: WidgetNode,
)

/** The named fields under `scope`. Labels are looked up across `root`. */
fun widgetFields(scope: WidgetNode, root: WidgetNode = scope): List<WidgetField> {
    val labels = mutableMapOf<String, String>()
    walk(root) { node, _ ->
        if (node.type == "Label") {
            val fieldName = node.str("fieldName")
            val value = node.str("value")
            if (fieldName != null && value != null) labels[fieldName] = value
        }
    }
    val fields = mutableListOf<WidgetField>()
    walk(scope) { node, _ ->
        val name = node.str("name") ?: return@walk
        if (node.type !in FIELD_TYPES && node.type != "ListView") return@walk
        val own = if (node.type == "ListView") widgetString(node, "title") else widgetString(node, "label")
        fields += WidgetField(name, node.type, labels[name] ?: own ?: name, node)
    }
    return fields
}

class WidgetOption(val label: String, val value: String)

/** What a choice field offers: a Select's or RadioGroup's options, or the
 * rows of a list with a name. */
fun widgetFieldOptions(node: WidgetNode): List<WidgetOption> {
    if (node.type == "ListView") {
        return node.children.map { row ->
            val value = row["value"].asString() ?: ""
            WidgetOption(firstText(row).ifEmpty { value }, value)
        }
    }
    return (node["options"] as? kotlinx.serialization.json.JsonArray)
        ?.mapNotNull { option ->
            (option as? JsonObject)?.let {
                WidgetOption(it["label"].asString() ?: "", it["value"].asString() ?: "")
            }
        }
        ?: emptyList()
}

/** What each field holds before the person touches it. */
fun widgetInitialValues(scope: WidgetNode): Map<String, Any> {
    val values = mutableMapOf<String, Any>()
    for (field in widgetFields(scope)) {
        values[field.name] = if (field.type == "Checkbox") field.node.bool("defaultChecked")
        else widgetString(field.node, "defaultValue") ?: ""
    }
    return values
}

/** Whether a field offers Other: the person may answer in their own words
 * instead of an option. A tree stored before this existed has no `allowOther`,
 * so it offers only its options. */
fun widgetTakesOther(node: WidgetNode): Boolean =
    node.bool("allowOther") &&
        (node.type == "Select" || node.type == "RadioGroup" || (node.type == "ListView" && node.str("name") != null))

/** Field names a `Label` points at (the Label is drawn beside the field, not inside it). */
fun labelledFields(node: WidgetNode, into: MutableSet<String> = mutableSetOf()): Set<String> {
    if (node.type == "Label") node.str("fieldName")?.let(into::add)
    for (child in node.children) labelledFields(child, into)
    return into
}

fun widgetFieldEmpty(field: WidgetField, values: Map<String, Any>, other: Map<String, String>): Boolean {
    if (other.containsKey(field.name)) return other[field.name].isNullOrBlank()
    val value = values[field.name]
    return if (field.type == "Checkbox") value != true else value !is String || value.isBlank()
}

/**
 * Assemble one press's `{values, other}` exactly as the desktop does before
 * POSTing `widgetAction`. Returns null when a confirm/submit press has a
 * required field still empty (the field name goes to [WidgetPress.missing]).
 */
class WidgetPress(
    val values: JsonObject?,
    val other: JsonObject?,
    val missing: WidgetField?,
)

fun widgetPress(root: WidgetNode, entry: WidgetActionEntry, values: Map<String, Any>, other: Map<String, String>): WidgetPress {
    if (entry.tone == "cancel") return WidgetPress(null, null, null)
    val scope = widgetFields(widgetScope(root, entry.ref), root)
    if (entry.tone != null) {
        val empty = scope.firstOrNull { it.node.bool("required") && widgetFieldEmpty(it, values, other) }
        if (empty != null) return WidgetPress(null, null, empty)
    }
    val typed = scope.filter { other[it.name]?.isNotBlank() == true }
    val sending = kotlinx.serialization.json.buildJsonObject {
        for (field in scope) {
            val value = if (other.containsKey(field.name)) "" else values[field.name]
            when (value) {
                is Boolean -> put(field.name, JsonPrimitive(value))
                is String -> put(field.name, JsonPrimitive(value))
                else -> put(field.name, if (field.type == "Checkbox") JsonPrimitive(false) else JsonPrimitive(""))
            }
        }
    }
    val sendingOther = if (typed.isEmpty()) null else kotlinx.serialization.json.buildJsonObject {
        for (field in typed) put(field.name, JsonPrimitive(other[field.name]!!))
    }
    return WidgetPress(sending, sendingOther, null)
}

/** `a/b` weekday csv kept in tree order; anything off the list drops the lot. */
fun widgetWeekdays(raw: String): String? {
    val picked = raw.split(",").map { it.trim().lowercase().take(3) }.toSet()
    val days = WIDGET_WEEKDAYS.filter(picked::contains)
    return if (days.isNotEmpty() && days.size == raw.split(",").count { it.isNotBlank() }) days.joinToString(",") else null
}

/** Normalise "H:MM"/"HH:MM" to "HH:MM"; anything else is "". */
fun widgetTime(value: String): String {
    val match = CLOCK.matchEntire(value.trim()) ?: return ""
    val minutes = match.groupValues[1].toInt() * 60 + match.groupValues[2].toInt()
    if (minutes >= DAY_MINUTES || match.groupValues[2].toInt() >= 60) return ""
    return timeOf(minutes)
}

private fun minutesOf(time: String?): Int? {
    val match = time?.let(CLOCK::matchEntire) ?: return null
    val minutes = match.groupValues[1].toInt() * 60 + match.groupValues[2].toInt()
    return if (minutes < DAY_MINUTES && match.groupValues[2].toInt() < 60) minutes else null
}

private fun timeOf(minutes: Int): String = "%02d:%02d".format(minutes / 60, minutes % 60)

/** The times a TimePicker offers: min→max by step (default 15), plus the held
 * value when it lands off the grid. */
fun widgetTimeSlots(node: WidgetNode, held: String = ""): List<String> {
    val from = minutesOf(widgetString(node, "min")) ?: 0
    val to = minutesOf(widgetString(node, "max")) ?: (DAY_MINUTES - 1)
    val step = (widgetNumber(node, "step") ?: 15.0).toInt().coerceIn(1, 60)
    val slots = (from..to step step).map(::timeOf).toMutableList()
    val value = minutesOf(held)
    if (value != null && value in from..to && timeOf(value) !in slots) {
        slots += timeOf(value)
        slots.sort()
    }
    return slots
}

fun widgetIsoDate(value: String): Boolean = ISO_DATE.matches(value)
fun widgetTimeOfDay(value: String): Boolean = TIME_OF_DAY.matches(value)

/** Days as a person says them, zh: 每天 / 工作日 / 周末 / 周一… */
fun widgetDaysCaption(value: String): String {
    val picked = WIDGET_WEEKDAYS.filter { day -> value.split(",").contains(day) }
    val key = picked.joinToString(",")
    if (picked.size == 7) return "每天"
    if (key == "mon,tue,wed,thu,fri") return "工作日"
    if (key == "sat,sun") return "周末"
    if (picked.isEmpty()) return "未选择日期"
    val names = mapOf("mon" to "周一", "tue" to "周二", "wed" to "周三", "thu" to "周四", "fri" to "周五", "sat" to "周六", "sun" to "周日")
    return picked.joinToString("、") { names[it] ?: it }
}
