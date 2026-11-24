package com.lunabot.companion.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 服务器卡片本地化：与 `shared/widget-text.ts` + `src/lib/widget-text.ts` 同语义。
 * 节点的 `i18n` 字段给出 {key, params}，key 命中 `WIDGET_TEXT_ZH` 时用词条
 * 模板填参替换 value/label/title/caption；任何一步查不到或填不齐都保留英文。
 * 只允许 brief.* / chat.notice.* 词条（server.meetings.* 与桌面对齐同样不生效）。
 */

private val WIDGET_TEXT_KEY = Regex("^(?:brief|chat\\.notice|server\\.meetings)\\.[\\w.]{1,80}$")
private val PARAM_NAME = Regex("^\\w{1,32}$")
private val PARAM_FILL = Regex("\\{(\\w+)\\}")
private val MOMENT_STYLES = setOf("clock", "bareClock", "longDate", "shortDate")
private const val MAX_PARAMS = 8
private const val MAX_DEPTH = 3
private const val MAX_STRING = 400

private val FIELDS = listOf("value", "label", "title", "caption")

/** `i18n` 的一个字段：key + 可选参数表。参数可以是字符串、数字、时刻或嵌套 key。 */
private class I18nText(val key: String, val params: Map<String, JsonElement>)

private fun readI18nText(raw: JsonElement?, depth: Int): I18nText? {
    val obj = raw as? JsonObject ?: return null
    val key = (obj["key"] as? JsonPrimitive)?.contentOrNull ?: return null
    if (!WIDGET_TEXT_KEY.matches(key) || depth > MAX_DEPTH) return null
    val paramsObj = obj["params"] ?: return I18nText(key, emptyMap())
    val params = (paramsObj as? JsonObject) ?: return null
    if (params.size > MAX_PARAMS) return null
    val out = mutableMapOf<String, JsonElement>()
    for ((name, value) in params) {
        if (!PARAM_NAME.matches(name) || !validParam(value, depth)) return null
        out[name] = value
    }
    return I18nText(key, out)
}

private fun validParam(value: JsonElement, depth: Int): Boolean {
    if (value is JsonPrimitive) {
        if (value.isString) return value.contentOrNull?.length ?: 0 <= MAX_STRING
        return value.doubleOrNull != null || value.contentOrNull == "true" || value.contentOrNull == "false"
    }
    val obj = value as? JsonObject ?: return false
    val at = (obj["at"] as? JsonPrimitive)?.doubleOrNull
    val style = (obj["style"] as? JsonPrimitive)?.contentOrNull
    if (at != null && style in MOMENT_STYLES) {
        val zone = (obj["zone"] as? JsonPrimitive)?.contentOrNull
        return zone == null || zone.length <= 64
    }
    return readI18nText(value, depth + 1) != null
}

private fun momentText(at: Double, style: String, zone: String?): String {
    val timeZone = zone?.let(TimeZone::getTimeZone) ?: TimeZone.getTimeZone("UTC")
    val pattern = when (style) {
        "longDate" -> "M月d日EEEE"
        "shortDate" -> "M月d日E"
        else -> "HH:mm"
    }
    val format = SimpleDateFormat(pattern, Locale.CHINA)
    format.timeZone = timeZone
    val words = format.format(Date(at.toLong()))
    return if (style == "clock" && zone == null) "$words UTC" else words
}

private fun paramText(param: JsonElement, depth: Int): String? {
    if (param is JsonPrimitive) {
        return if (param.isString) param.contentOrNull else param.contentOrNull
    }
    val obj = param as? JsonObject ?: return null
    val at = (obj["at"] as? JsonPrimitive)?.doubleOrNull
    val style = (obj["style"] as? JsonPrimitive)?.contentOrNull
    if (at != null && style != null && style in MOMENT_STYLES) {
        val zone = (obj["zone"] as? JsonPrimitive)?.contentOrNull
        return momentText(at, style, zone)
    }
    val nested = readI18nText(param, depth + 1) ?: return null
    return wordsOf(nested, depth + 1)
}

private val DEADLINE_DATE = Regex("^\\d{4}-\\d{2}-\\d{2}(?:T.*)?$")

/** 词条查词填参；失败返回 null，调用方保留英文。 */
private fun wordsOf(text: I18nText, depth: Int): String? {
    if (text.key.startsWith("chat.notice.")) {
        if (text.params.values.any { it !is JsonPrimitive }) return null
    } else if (!text.key.startsWith("brief.") || text.key !in WIDGET_TEXT_ZH) {
        return null
    }
    val params = mutableMapOf<String, String>()
    for ((name, value) in text.params) {
        params[name] = paramText(value, depth) ?: return null
    }
    if (text.key.startsWith("brief.inbox.")) {
        params["amountValue"]?.toDoubleOrNull()?.let { amount ->
            params["amount"] = java.text.NumberFormat.getInstance(Locale.CHINA).format(amount)
        }
        params["deadline"]?.let { deadline ->
            if (DEADLINE_DATE.matches(deadline)) {
                val millis = runCatching {
                    if (deadline.length == 10) SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
                        timeZone = TimeZone.getTimeZone("UTC")
                    }.parse(deadline)?.time
                    else listOf("yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm")
                        .firstNotNullOfOrNull { pattern ->
                            runCatching { SimpleDateFormat(pattern, Locale.US).parse(deadline)?.time }.getOrNull()
                        }
                }.getOrNull()
                if (millis != null) {
                    params["deadline"] = SimpleDateFormat("yyyy年M月d日", Locale.CHINA).format(Date(millis))
                }
            }
        }
    }
    val template = WIDGET_TEXT_ZH[text.key] ?: return null
    val slots = PARAM_FILL.findAll(template).map { it.groupValues[1] }.toList()
    if (slots.any { it !in params }) return null
    return PARAM_FILL.replace(template) { match -> params[match.groupValues[1]]!! }
}

private fun localizeNode(node: JsonObject, depth: Int): JsonObject {
    val i18n = node["i18n"] as? JsonObject
    return buildJsonObject {
        for ((key, value) in node) {
            when {
                key == "children" && value is JsonArray -> put(key, JsonArray(value.map { child ->
                    (child as? JsonObject)?.let { localizeNode(it, depth) } ?: child
                }))
                i18n != null && key in FIELDS -> {
                    val localized = (i18n[key] as? JsonObject)
                        ?.let { readI18nText(it, 0) }
                        ?.let { wordsOf(it, 0) }
                    if (localized != null) put(key, localized) else put(key, value)
                }
                else -> put(key, value)
            }
        }
    }
}

/** 服务器卡片翻译成中文；非 serverCard 或查不到词的都原样保留。 */
fun localizeWidgetRoot(root: JsonObject, serverCard: Boolean): JsonObject =
    if (!serverCard) root else localizeNode(root, 0)
