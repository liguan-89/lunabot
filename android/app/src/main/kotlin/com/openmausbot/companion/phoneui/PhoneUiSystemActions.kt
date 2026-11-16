package com.openmausbot.companion.phoneui

import android.app.ActivityOptions
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.AlarmClock
import com.openmausbot.companion.phone.PhoneToolOutcome
import java.util.Calendar
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * The four phone tools that use Android's own standard intents instead of
 * driving an app's screen: an alarm, a timer, a link, and text for another
 * app's compose screen.
 *
 * The split is the same one [PhoneUiRun] makes. Parsing an argument object into
 * a [AlarmRequest] (and the other request types) and building the intent from
 * it are plain functions over data, so [PhoneUiSystemActionsTest] pins which
 * extra a call sets without launching anything. Only [setAlarm], [setTimer],
 * [openLink] and [shareText] touch the device: they resolve nothing ahead of
 * time (package visibility can hide a handler that is there) and answer
 * `not_supported` when the system finds none, so the model falls back to the
 * screen tools. Links and shared text open on the helper's display, never the
 * person's; an alarm and a timer carry EXTRA_SKIP_UI, so the Clock app records
 * them without showing an editor anywhere.
 */
internal object PhoneUiSystemActions {
    /** The server's schema bounds, checked again here. Kept here rather than in PhoneUiRules.kt. */
    private const val MAX_LABEL = 200
    private const val MAX_URL = 2_000
    private const val MAX_TEXT = 5_000
    private const val MAX_PACKAGE = 200
    private const val MIN_TIMER_SECONDS = 1
    private const val MAX_TIMER_SECONDS = 86_400

    private const val CODE_DENIED = "denied"
    private const val CODE_UNSUPPORTED = "unsupported"
    /** No app on this phone handles the intent: the model should drive the screen instead. */
    private const val CODE_NOT_SUPPORTED = "not_supported"

    /** The wire's seven day names and the `Calendar` constant each one means; SUNDAY is 1 and SATURDAY 7. */
    private val DAYS: Map<String, Int> = linkedMapOf(
        "MON" to Calendar.MONDAY,
        "TUE" to Calendar.TUESDAY,
        "WED" to Calendar.WEDNESDAY,
        "THU" to Calendar.THURSDAY,
        "FRI" to Calendar.FRIDAY,
        "SAT" to Calendar.SATURDAY,
        "SUN" to Calendar.SUNDAY,
    )

    private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.\\-]*):")
    private val ALLOWED_SCHEMES = setOf("http", "https")

    /** An alarm as parsed; null [days] is a one-time alarm, and null [vibrate] leaves the Clock app's own setting. */
    internal data class AlarmRequest(
        val hour: Int,
        val minute: Int,
        val label: String? = null,
        val days: List<String>? = null,
        val vibrate: Boolean? = null,
    )

    /** A countdown timer as parsed. */
    internal data class TimerRequest(val seconds: Int, val label: String? = null)

    /** A link to open, optionally in one named app. */
    internal data class LinkRequest(val url: String, val app: String? = null)

    /** Text for another app's compose screen, optionally one named app. */
    internal data class ShareRequest(val text: String, val app: String? = null)

    /** The parsed request, or the sentence saying why it cannot run. */
    internal sealed interface Parsed<out T> {
        data class Ready<T>(val request: T) : Parsed<T>
        data class Refused(val message: String) : Parsed<Nothing>
    }

    // MARK: - Arguments

    fun parseAlarm(arguments: JsonObject): Parsed<AlarmRequest> {
        val hour = arguments.intValue("hour") ?: return Parsed.Refused("缺少参数 hour。")
        if (hour !in 0..23) return Parsed.Refused("hour 只能是 0 到 23。")
        val minute = arguments.intValue("minute") ?: return Parsed.Refused("缺少参数 minute。")
        if (minute !in 0..59) return Parsed.Refused("minute 只能是 0 到 59。")
        val label = arguments.textValue("label")
        if ((label?.length ?: 0) > MAX_LABEL) return Parsed.Refused("label 最长 $MAX_LABEL 字符。")
        val days = when (val element = arguments["days"]) {
            null, JsonNull -> null
            is JsonArray -> {
                if (element.size > DAYS.size) return Parsed.Refused("days 最多 ${DAYS.size} 个。")
                // An empty list is the same as none: a one-time alarm, no extra.
                if (element.isEmpty()) null else element.map { day ->
                    val name = (day as? JsonPrimitive)
                        ?.takeIf { it !is JsonNull }
                        ?.contentOrNull
                        ?.trim()
                        ?.uppercase()
                    if (name == null || name !in DAYS) {
                        return Parsed.Refused("days 只支持 ${DAYS.keys.joinToString("、")}。")
                    }
                    name
                }
            }
            else -> return Parsed.Refused("days 必须是数组。")
        }
        return Parsed.Ready(AlarmRequest(hour, minute, label, days, arguments.booleanValue("vibrate")))
    }

    fun parseTimer(arguments: JsonObject): Parsed<TimerRequest> {
        val seconds = arguments.intValue("seconds") ?: return Parsed.Refused("缺少参数 seconds。")
        if (seconds !in MIN_TIMER_SECONDS..MAX_TIMER_SECONDS) {
            return Parsed.Refused("seconds 只能是 $MIN_TIMER_SECONDS 到 $MAX_TIMER_SECONDS。")
        }
        val label = arguments.textValue("label")
        if ((label?.length ?: 0) > MAX_LABEL) return Parsed.Refused("label 最长 $MAX_LABEL 字符。")
        return Parsed.Ready(TimerRequest(seconds, label))
    }

    fun parseLink(arguments: JsonObject): Parsed<LinkRequest> {
        val url = arguments.textValue("url") ?: return Parsed.Refused("缺少参数 url。")
        if (url.length > MAX_URL) return Parsed.Refused("url 最长 $MAX_URL 字符。")
        val scheme = schemeOf(url)
            ?: return Parsed.Refused("链接缺少协议，只支持 http 和 https。")
        if (scheme !in ALLOWED_SCHEMES) {
            return Parsed.Refused("只支持 http 和 https 链接，收到的是 $scheme。")
        }
        val app = packageValue(arguments)
        if (app is Parsed.Refused) return app
        return Parsed.Ready(LinkRequest(url, (app as Parsed.Ready).request))
    }

    fun parseShare(arguments: JsonObject): Parsed<ShareRequest> {
        // Shared text keeps its own whitespace: it is going into someone else's field.
        val text = arguments.rawText("text")?.takeIf { it.isNotBlank() }
            ?: return Parsed.Refused("缺少参数 text。")
        if (text.length > MAX_TEXT) return Parsed.Refused("text 最长 $MAX_TEXT 字符。")
        val app = packageValue(arguments)
        if (app is Parsed.Refused) return app
        return Parsed.Ready(ShareRequest(text, (app as Parsed.Ready).request))
    }

    /** The scheme before the first colon, lowercased; null when the text does not start with one. */
    fun schemeOf(url: String): String? = SCHEME.find(url.trim())?.groupValues?.get(1)?.lowercase()

    /** The `Calendar` day constants EXTRA_DAYS takes: SUNDAY=1 … SATURDAY=7. */
    fun dayConstants(days: List<String>): ArrayList<Int> = ArrayList(days.map { DAYS.getValue(it) })

    // MARK: - Intents

    fun alarmIntent(request: AlarmRequest): Intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
        putExtra(AlarmClock.EXTRA_HOUR, request.hour)
        putExtra(AlarmClock.EXTRA_MINUTES, request.minute)
        request.label?.let { putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        // The alarm is already set: the Clock app must not open its editor.
        putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        request.vibrate?.let { putExtra(AlarmClock.EXTRA_VIBRATE, it) }
        request.days?.let { putExtra(AlarmClock.EXTRA_DAYS, dayConstants(it)) }
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun timerIntent(request: TimerRequest): Intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
        putExtra(AlarmClock.EXTRA_LENGTH, request.seconds)
        request.label?.let { putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun linkIntent(request: LinkRequest): Intent = Intent(Intent.ACTION_VIEW, Uri.parse(request.url)).apply {
        request.app?.let { setPackage(it) }
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun shareIntent(request: ShareRequest): Intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, request.text)
        request.app?.let { setPackage(it) }
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    // MARK: - The tools

    fun setAlarm(context: Context, displayId: Int?, arguments: JsonObject): PhoneToolOutcome {
        val parsed = parseAlarm(arguments)
        if (parsed is Parsed.Refused) return PhoneToolOutcome.Failure(parsed.message, CODE_UNSUPPORTED)
        val request = (parsed as Parsed.Ready).request
        start(context, alarmIntent(request), displayId, "手机上没有能设置闹钟的应用，请改用手机屏幕工具。")?.let { return it }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("alarm", buildJsonObject {
                    put("hour", request.hour)
                    put("minute", request.minute)
                    request.label?.let { put("label", it) }
                    request.days?.let { days -> put("days", JsonArray(days.map { JsonPrimitive(it) })) }
                    request.vibrate?.let { put("vibrate", it) }
                })
            },
        )
    }

    fun setTimer(context: Context, displayId: Int?, arguments: JsonObject): PhoneToolOutcome {
        val parsed = parseTimer(arguments)
        if (parsed is Parsed.Refused) return PhoneToolOutcome.Failure(parsed.message, CODE_UNSUPPORTED)
        val request = (parsed as Parsed.Ready).request
        start(context, timerIntent(request), displayId, "手机上没有能设置计时器的应用，请改用手机屏幕工具。")?.let { return it }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("timer", buildJsonObject {
                    put("seconds", request.seconds)
                    request.label?.let { put("label", it) }
                })
            },
        )
    }

    fun openLink(context: Context, displayId: Int, arguments: JsonObject): PhoneToolOutcome {
        val parsed = parseLink(arguments)
        if (parsed is Parsed.Refused) return PhoneToolOutcome.Failure(parsed.message, CODE_UNSUPPORTED)
        val request = (parsed as Parsed.Ready).request
        start(context, linkIntent(request), displayId, "手机上没有能打开这个链接的应用，请改用手机屏幕工具。")?.let { return it }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("opened", true)
                put("url", request.url)
                request.app?.let { put("package", it) }
            },
        )
    }

    fun shareText(context: Context, displayId: Int, arguments: JsonObject): PhoneToolOutcome {
        val parsed = parseShare(arguments)
        if (parsed is Parsed.Refused) return PhoneToolOutcome.Failure(parsed.message, CODE_UNSUPPORTED)
        val request = (parsed as Parsed.Ready).request
        val send = shareIntent(request)
        // With no app named, the matching apps decide the shape: one opens as it
        // is, several get the chooser (which opens on the helper's display too),
        // and none is a handler this phone does not have. A named app is started
        // as it is: package visibility can hide a handler that is there, and the
        // start answers not_supported when it cannot find one.
        val packages = if (request.app == null) {
            runCatching { context.packageManager.queryIntentActivities(send, 0) }
                .getOrNull()
                .orEmpty()
                .mapNotNull { it.activityInfo?.packageName }
                .distinct()
        } else {
            emptyList()
        }
        if (request.app == null && packages.isEmpty()) {
            return PhoneToolOutcome.Failure("手机上没有能接收文字的分享入口，请改用手机屏幕工具。", CODE_NOT_SUPPORTED)
        }
        val outgoing = if (packages.size > 1) {
            Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        } else {
            send
        }
        val noHandler = request.app?.let { "「$it」没有能接收文字的分享入口。" } ?: "手机上没有能接收文字的分享入口。"
        start(context, outgoing, displayId, noHandler)?.let { return it }
        return PhoneToolOutcome.Success(
            buildJsonObject {
                put("shared", true)
                put("package", (request.app ?: packages.singleOrNull())?.let { JsonPrimitive(it) } ?: JsonNull)
            },
        )
    }

    /**
     * Starts [intent] on [displayId] (the person's own screen when null). Null
     * means it started; otherwise the failure to answer. A handler is not
     * resolved ahead of time: package visibility can hide one that is there,
     * and ActivityNotFoundException is the system's own verdict.
     */
    private fun start(context: Context, intent: Intent, displayId: Int?, noHandler: String): PhoneToolOutcome.Failure? =
        try {
            if (displayId == null) {
                context.startActivity(intent)
            } else {
                val options = ActivityOptions.makeBasic().setLaunchDisplayId(displayId).toBundle()
                context.startActivity(intent, options)
            }
            null
        } catch (_: ActivityNotFoundException) {
            PhoneToolOutcome.Failure(noHandler, CODE_NOT_SUPPORTED)
        } catch (error: SecurityException) {
            PhoneToolOutcome.Failure(
                "手机不允许在后台打开应用：${error.message ?: "系统拒绝了这次启动"}。",
                CODE_DENIED,
            )
        }

    // MARK: - Shared argument readers

    private fun packageValue(arguments: JsonObject): Parsed<String?> {
        val app = arguments.textValue("app") ?: return Parsed.Ready(null)
        if (app.length > MAX_PACKAGE || !PhoneUiRules.isValidPackageName(app)) {
            return Parsed.Refused("包名不合法。")
        }
        return Parsed.Ready(app)
    }
}

private fun JsonObject.intValue(key: String): Int? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.intOrNull

private fun JsonObject.booleanValue(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.booleanOrNull

/** A trimmed, non-empty string; labels, urls and package names read this way. */
private fun JsonObject.textValue(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

/** The string as sent, whitespace included. */
private fun JsonObject.rawText(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
