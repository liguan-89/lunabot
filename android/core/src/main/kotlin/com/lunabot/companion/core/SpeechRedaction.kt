package com.lunabot.companion.core

/** 保持重复打码字节级稳定。 */
private fun maskSecret(value: String): String =
    if (Regex("^«redacted \\d+ chars»$").matches(value)) value else "«redacted ${value.length} chars»"

private val keyPrefixes = listOf(
    Regex("\\bom[dg]_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])"),
    Regex("\\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}"),
    Regex("\\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}"),
    Regex("\\bxai-[A-Za-z0-9_-]{20,}"),
    Regex("\\bgsk_[A-Za-z0-9]{40,}"),
    Regex("\\bcsk-[A-Za-z0-9]{32,}"),
    Regex("\\bLLM\\|\\d{6,}\\|[A-Za-z0-9_-]{16,}"),
    Regex("\\bhf_[A-Za-z0-9]{30,}"),
    Regex("\\bpypi-AgE[A-Za-z0-9_-]{82,}"),
    Regex("\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    Regex("\\bgithub_pat_[A-Za-z0-9_]{20,}"),
    Regex("\\bgl(?:pat|dt|rtr?)-[A-Za-z0-9_-]{20,}(?:\\.[A-Za-z0-9_-]+)*"),
    Regex("\\bxox[abposr]-[A-Za-z0-9-]{20,}"),
    Regex("\\bxapp-\\d-[A-Za-z0-9-]{20,}"),
    Regex("\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b"),
    Regex("\\bAIza[0-9A-Za-z_-]{30,}"),
    Regex("\\bnpm_[A-Za-z0-9]{20,}"),
    Regex("\\bntn_[A-Za-z0-9]{46}(?![A-Za-z0-9_-])"),
    Regex("\\bpplx-[A-Za-z0-9]{48}(?![A-Za-z0-9_-])"),
    Regex("\\bwhsec_[A-Za-z0-9_-]{20,}"),
    Regex("\\bSG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])"),
    Regex("\\bbak_[A-Za-z0-9_-]{20,}"),
)

private val bearer = Regex("(\\bBearer\\s+)([A-Za-z0-9._~+/=-]{12,})")
private val basicAuth = Regex("(\\bAuthorization[\"']?\\s*[:=]\\s*[\"']?Basic\\s+)([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9._~+/=-])", RegexOption.IGNORE_CASE)
private val keyValue = Regex("(?<![A-Za-z0-9])((?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)([\"']?\\s*[=:]\\s*)([\"']?)([A-Za-z0-9._~+/=-]{8,})\\3", RegexOption.IGNORE_CASE)
private val keySuffixAssignment = Regex("(?<=[A-Za-z0-9_-])([_-]key)s?(=)([\"']?)([A-Za-z0-9._~+/=-]+)\\3", RegexOption.IGNORE_CASE)
private val secretFlag = Regex("(--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)(?:=|\\s+))([\"']?)(?!-)([A-Za-z0-9._~+/=-]+)\\2", RegexOption.IGNORE_CASE)
private val urlUserinfo = Regex("([a-z][a-z0-9+.-]{0,31}://[^\\s/:@'\"]+:)([^\\s/@'\"«»]+)(@)", RegexOption.IGNORE_CASE)
private val pemBegin = Regex("-----BEGIN [A-Z ]*PRIVATE KEY-----")
private val pemEnd = Regex("-----END [A-Z ]*PRIVATE KEY-----")

private fun maskPemBlocks(text: String): String {
    var out = ""
    var last = 0
    var searchFrom = 0
    while (true) {
        val begin = pemBegin.find(text, searchFrom) ?: break
        val end = pemEnd.find(text, begin.range.last + 1) ?: break
        val body = text.substring(begin.range.last + 1, end.range.first).trim()
        out += text.substring(last, begin.range.first) + begin.value + "\n" + maskSecret(body) + "\n" + end.value
        last = end.range.last + 1
        searchFrom = last
    }
    return if (last == 0) text else out + text.substring(last)
}

private fun isWord(char: Char): Boolean = char.isLetterOrDigit() || char == '_'
private fun runEnd(text: String, from: Int): Int {
    var at = from
    while (at < text.length && (text[at].isLetterOrDigit() || text[at] == '_' || text[at] == '-')) at++
    return at
}

private fun jwtSpans(text: String): List<IntRange> {
    val spans = mutableListOf<IntRange>()
    var from = 0
    while (true) {
        val at = text.indexOf("eyJ", from)
        if (at < 0) return spans
        if (at > 0 && isWord(text[at - 1])) {
            from = at + 1
            continue
        }
        val first = runEnd(text, at)
        if (first - at - 3 < 8 || first >= text.length || text[first] != '.') {
            from = maxOf(first, at + 1)
            continue
        }
        val second = runEnd(text, first + 1)
        if (second - first - 1 < 8 || second >= text.length || text[second] != '.') {
            from = first
            continue
        }
        var third = runEnd(text, second + 1)
        while (third > second + 1 && text[third - 1] == '-') third--
        if (third - second - 1 < 8) {
            from = first
            continue
        }
        spans += at until third
        from = third
    }
}

private fun maskJwts(text: String): String {
    val spans = jwtSpans(text)
    if (spans.isEmpty()) return text
    var out = ""
    var last = 0
    for (span in spans) {
        val value = text.substring(span)
        out += text.substring(last, span.first) + maskSecret(value)
        last = span.last + 1
    }
    return out + text.substring(last)
}

/** 与桌面 `redactSecretsInText` 对应的朗读前打码；服务器已持有值的打码仍由 `/api/tts/prepare` 承担。 */
fun redactSecretsForSpeech(text: String): String {
    if (text.length < 8) return text
    var out = maskPemBlocks(text)
    for (re in keyPrefixes) out = re.replace(out) { maskSecret(it.value) }
    out = maskJwts(out)
    out = bearer.replace(out) { m -> m.groupValues[1] + maskSecret(m.groupValues[2]) }
    out = basicAuth.replace(out) { m -> m.groupValues[1] + maskSecret(m.groupValues[2]) }
    out = keyValue.replace(out) { m -> m.groupValues[1] + m.groupValues[2] + m.groupValues[3] + maskSecret(m.groupValues[4]) + m.groupValues[3] }
    out = keySuffixAssignment.replace(out) { m -> m.groupValues[1] + m.groupValues[2] + m.groupValues[3] + maskSecret(m.groupValues[4]) + m.groupValues[3] }
    out = secretFlag.replace(out) { m -> m.groupValues[1] + m.groupValues[2] + maskSecret(m.groupValues[3]) + m.groupValues[2] }
    out = urlUserinfo.replace(out) { m -> m.groupValues[1] + maskSecret(m.groupValues[2]) + m.groupValues[3] }
    return out
}

/**
 * 流式文本的保守兜底：只要像凭证或半个凭证，就把后续内容留到权威完成帧。
 * 误报只是晚些朗读，漏报则可能把密钥送去语音服务。
 */
fun holdsPotentialCredential(text: String): Boolean {
    if (pemBegin.containsMatchIn(text) || text.contains("-----BEGIN")) return true
    if (keyPrefixes.any { it.containsMatchIn(text) }) return true
    if (jwtSpans(text).isNotEmpty()) return true
    val partial = Regex(
        "(?i)\\b(?:sk-|xai-|gsk_|csk-|hf_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[a-z]?-|xapp-|AKIA|ASIA|AIza|npm_|ntn_|pplx-|whsec_|SG\\.|bak_|eyJ)",
    )
    if (partial.containsMatchIn(text)) return true
    return keyValue.containsMatchIn(text) ||
        keySuffixAssignment.containsMatchIn(text) ||
        secretFlag.containsMatchIn(text) ||
        bearer.containsMatchIn(text) ||
        basicAuth.containsMatchIn(text) ||
        urlUserinfo.containsMatchIn(text)
}
