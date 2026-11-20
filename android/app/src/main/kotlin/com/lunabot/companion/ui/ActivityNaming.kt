package com.lunabot.companion.ui

/**
 * The words a receipt wears.
 *
 * The desktop has done this since it had a transcript: `live-activity.ts` maps
 * an engine's tool id to the thing a person would say (`bash` → 正在执行命令,
 * `read` → 正在读取文件), and `engine-name.ts` names the one engine this build
 * runs instead of printing its internal id. The phone printed the wire, so a
 * turn that ran a command left a chip reading `bash`, and a slow-start notice
 * said `pi`.
 *
 * Pure, and in its own file for the usual reason: these are rules about
 * strings, and a string rule is exactly what a screenshot cannot pin.
 */
object ActivityNaming {
    /**
     * Engine tool ids, as the same words the desktop's status line uses. Ordered
     * longest-first so `write_file` is not read as `write`; matching is on the
     * whole id, so a name that already reads as a sentence never lands here.
     */
    private val TOOL_LABELS: List<Pair<Regex, String>> = listOf(
        Regex("^(?:bash|shell|terminal|exec|run_command|command|shell_command)$", RegexOption.IGNORE_CASE) to "正在执行命令",
        Regex("^(?:read|read_file|view|open_file|cat)$", RegexOption.IGNORE_CASE) to "正在读取文件",
        Regex("^(?:write|write_file|create_file)$", RegexOption.IGNORE_CASE) to "正在写入文件",
        Regex("^(?:edit|edit_file|apply_patch|replace|str_replace)$", RegexOption.IGNORE_CASE) to "正在编辑文件",
        Regex("^(?:web_search|search_web)$", RegexOption.IGNORE_CASE) to "正在搜索网页",
        Regex("^(?:web_fetch|fetch_url|read_page)$", RegexOption.IGNORE_CASE) to "正在阅读网页",
        Regex("^(?:grep|glob|find|search)$", RegexOption.IGNORE_CASE) to "正在查找文件",
        Regex("^(?:screenshot|screen_capture)$", RegexOption.IGNORE_CASE) to "正在查看屏幕",
        Regex("^(?:click|type|keypress|press|scroll|computer)$", RegexOption.IGNORE_CASE) to "正在操作屏幕",
        Regex("^(?:open_url|navigate)$", RegexOption.IGNORE_CASE) to "正在打开网页",
        Regex("^(?:list_bots|list_agents)$", RegexOption.IGNORE_CASE) to "正在查看有谁在",
        Regex("^list_rooms$", RegexOption.IGNORE_CASE) to "正在查看群组",
        Regex("^post_to_room$", RegexOption.IGNORE_CASE) to "正在群组里发言",
        Regex("^message_person$", RegexOption.IGNORE_CASE) to "正在转告消息",
        Regex("^publish_page$", RegexOption.IGNORE_CASE) to "正在发布页面",
        Regex("^delegate_bot$", RegexOption.IGNORE_CASE) to "正在移交任务",
        Regex("^(?:ask_bot|send_message)$", RegexOption.IGNORE_CASE) to "正在询问队友",
    )

    /**
     * A tool id as a person reads it. A name that already is a sentence — a
     * notice, an error, anything with a space or a CJK character in it — is
     * returned untouched: those are written for this exact row.
     */
    fun toolLabel(name: String): String {
        val id = name.trim()
        if (id.isEmpty()) return name
        if (id.any { it.isWhitespace() } || id.any { it.code in 0x2E80..0x9FFF || it.code in 0xF900..0xFAFF }) return name
        return TOOL_LABELS.firstOrNull { (pattern, _) -> pattern.matches(id) }?.second ?: name
    }

    /**
     * The engine's name as the desktop names it. `pi` is this build's only
     * engine, and its display name on the wire is its own id; the desktop maps
     * it to the provider it actually runs (`engine-name.ts`), so a sentence that
     * came from the harness says the same thing here.
     */
    fun engineName(name: String): String = when (name.trim().lowercase()) {
        "pi", "piagent" -> "自定义模型提供方"
        else -> name
    }

    /**
     * A notice row's sentence with its engine id replaced by [engineName]. The
     * harness writes the row from a language pack ("提示：{ai} 在缓慢启动后回复
     * 了。") and fills `{ai}` with the instance id, so the sentence has to be
     * fixed where the id landed — the row itself is already written.
     */
    fun rescueEngine(name: String, rescue: com.lunabot.companion.core.FirstReplyRescue?): String {
        val ai = rescue?.ai?.takeIf { it.isNotBlank() } ?: return name
        val readable = engineName(ai)
        if (readable == ai) return name
        // Whole-word, so a bot whose name happens to contain "pi" is left alone.
        return Regex("(?<![\\w-])${Regex.escape(ai)}(?![\\w-])").replace(name, readable)
    }
}
