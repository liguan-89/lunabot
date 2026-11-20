package com.lunabot.companion.ui

import com.lunabot.companion.core.Instance
import com.lunabot.companion.core.ModelSelection

/** One row of the model picker. */
data class ModelChoice(val id: String, val label: String)

/**
 * The Model section of bot settings, as rules — the decision half of the
 * section `ios/App/AgentProfileView.swift` added in #699.
 *
 * The phone sees the catalog and the bot's current selection; provider
 * accounts and keys stay on the computer. What this decides is which rows the
 * pickers offer, what a provider change resets, and when "Apply model" is
 * allowed to send anything.
 */
object ModelRules {
    const val FOOTER: String =
        "服务商账号和 API 密钥保留在电脑端。“默认”不发送固定推理强度，由模型服务商自行决定。"

    const val LOADING: String = "正在加载模型…"
    const val NONE_AVAILABLE: String = "暂无可用的模型提供商"
    const val CURRENT_PROVIDER_UNAVAILABLE: String = "当前提供商（不可用）"
    const val DEFAULT_EFFORT_LABEL: String = "默认"

    // Private for the reason ProfileRules gives: each is one arm of a
    // state-dependent choice, reached only through [note].
    private const val BUSY_NOTE: String = "请先停止此智能体，再切换其模型。"
    private const val UNAVAILABLE_NOTE: String = "请选择一个可用的提供商以切换此智能体的模型。"

    /**
     * The providers the picker offers: the available ones, with the bot's
     * current provider in front when it has gone unavailable, so the picker can
     * still show what the bot is set to.
     */
    fun instanceChoices(instances: List<Instance>, saved: ModelSelection): List<Instance> {
        val available = instances.filter { it.snapshot.isAvailable }
        val current = instances.firstOrNull { it.instanceId == saved.instanceId }
        return if (current != null && !current.snapshot.isAvailable) listOf(current) + available else available
    }

    /** True when the selected provider is not in the catalog at all. */
    fun providerMissing(instances: List<Instance>, selectedInstanceId: String): Boolean =
        instances.none { it.instanceId == selectedInstanceId }

    /**
     * The models the picker offers for one provider: its default first, then
     * the listed options, then the current selection if the catalog does not
     * carry it — each id once.
     */
    fun modelChoices(instance: Instance?, selectedModelId: String): List<ModelChoice> {
        if (instance == null) {
            return if (selectedModelId.isEmpty()) {
                emptyList()
            } else {
                listOf(ModelChoice(selectedModelId, modelLabel(selectedModelId, selectedModelId)))
            }
        }
        val seen = mutableSetOf<String>()
        val out = mutableListOf<ModelChoice>()
        val default = instance.models.defaultModel
        if (default.isNotEmpty() && seen.add(default)) {
            val label = instance.models.options.firstOrNull { it.id == default }?.label ?: default
            out += ModelChoice(default, modelLabel(default, label))
        }
        for (option in instance.models.options) {
            if (seen.add(option.id)) out += ModelChoice(option.id, modelLabel(option.id, option.label))
        }
        if (selectedModelId.isNotEmpty() && seen.add(selectedModelId)) {
            out += ModelChoice(selectedModelId, modelLabel(selectedModelId, selectedModelId))
        }
        return out
    }

    /**
     * A model's name as the picker shows it.
     *
     * The catalog is authored on the computer and most labels are already
     * readable; what it does not do is speak Chinese. Qualifiers are translated,
     * and a raw id — which the catalog emits when it has no hand-written label,
     * often with a vendor prefix — is turned into a name instead of being shown
     * as `kimi-code/k3.1-pro`.
     */
    fun modelLabel(id: String, label: String): String {
        val provided = label.trim()
        if (provided.isNotEmpty() && provided != id && '/' !in provided) {
            return localizeQualifiers(provided)
        }
        return humanizeModelId(id)
    }

    private fun localizeQualifiers(label: String): String = label
        .replace("HighSpeed", "高速")
        .replace("Highspeed", "高速")
        .replace("for Coding", "编程")
        .replace("for coding", "编程")
        .replace("Thinking", "思考")
        .replace("Fast", "快速")
        .replace("Auto (Factory picks)", "自动（由平台选择）")
        .replace(" (availability unverified)", "（可用性未验证）")
        .replace("(availability unverified)", "（可用性未验证）")
        .replace(" availability unverified", "（可用性未验证）")
        .trim()

    private fun humanizeModelId(id: String): String {
        val bare = id.substringAfterLast('/')
        val lower = bare.lowercase()
        val prefix = id.substringBefore('/', "")
        val vendor = when (prefix) {
            "kimi-code", "kimi-coding" -> "Kimi"
            "zai-coding-cn", "zai" -> "智谱"
            "deepseek" -> "DeepSeek"
            else -> ""
        }
        // Claude ids put the version before or after the family; a straight
        // hyphen split would read "Claude 4 5 Sonnet", so put the family first.
        if (lower.startsWith("claude")) {
            val family = listOf("fable", "opus", "sonnet", "haiku").firstOrNull { it in lower }
            val version = Regex("(\\d+)[-.](\\d+)").find(lower)?.value?.replace('-', '.')
                ?: Regex("(\\d+)").find(lower)?.value
            if (family != null) {
                return "Claude ${family.replaceFirstChar { it.uppercase() }}".let {
                    if (version != null) "$it $version" else it
                }
            }
        }
        // GPT ids keep the version attached with a hyphen, the way the catalog
        // writes them: "GPT-5.6 Astra", not "GPT 5.6 Astra".
        if (lower.startsWith("gpt-")) {
            val rest = bare.removePrefix("gpt-").split('-', '_')
                .filter(String::isNotEmpty)
                .joinToString(" ") { it.replaceFirstChar { c -> c.uppercase() } }
            return "GPT-$rest"
        }
        val words = bare.split('-', '_').filter(String::isNotEmpty).map { token ->
            when (token.lowercase()) {
                "gpt" -> "GPT"
                "glm" -> "GLM"
                "pro" -> "Pro"
                "flash" -> "Flash"
                "mini" -> "Mini"
                "max" -> "Max"
                "thinking" -> "思考"
                "highspeed" -> "高速"
                "coding" -> "编程"
                "k3" -> "K3"
                else -> token.replaceFirstChar { it.uppercase() }
            }
        }
        // "K3.1" arrives as two tokens ("k3.1" survives, but "4-6" does not):
        // join adjacent pure numbers into one dotted version.
        val joined = mutableListOf<String>()
        for (word in words) {
            val last = joined.lastOrNull()
            if (last != null && last.all(Char::isDigit) && word.all(Char::isDigit)) {
                joined[joined.lastIndex] = "$last.$word"
            } else {
                joined += word
            }
        }
        val name = joined.joinToString(" ").ifEmpty { bare }
        val alreadyNamed = vendor.isNotEmpty() && name.startsWith(vendor)
        return if (vendor.isEmpty() || alreadyNamed) name else "$vendor $name"
    }

    /** The reasoning levels a provider offers, blanks dropped, each once. */
    fun effortLevels(instance: Instance?): List<String> =
        (instance?.capabilities?.effortLevels ?: emptyList()).filter { it.isNotEmpty() }.distinct()

    /**
     * Whether "Apply model" may send: the catalog has loaded, the bot is idle,
     * the chosen provider is available and actually offers the chosen model and
     * effort, and the draft differs from what is saved.
     */
    fun canApply(
        loaded: Boolean,
        botBusy: Boolean?,
        instance: Instance?,
        draft: ModelSelection,
        saved: ModelSelection,
    ): Boolean {
        if (!loaded || botBusy == true || instance == null || !instance.snapshot.isAvailable) return false
        val modelOffered = draft.model == instance.models.defaultModel ||
            instance.models.options.any { it.id == draft.model }
        val effortOffered = draft.effort?.let { it in effortLevels(instance) } ?: true
        return modelOffered && effortOffered && draft != saved
    }

    /**
     * What choosing a provider selects: back on the saved provider, the saved
     * model and its effort (if that provider still offers it); on any other,
     * the provider's default model and the engine-default effort.
     */
    fun defaultsFor(instance: Instance, saved: ModelSelection): ModelSelection =
        if (instance.instanceId == saved.instanceId) {
            ModelSelection(
                instanceId = instance.instanceId,
                model = saved.model,
                effort = saved.effort?.takeIf { it in (instance.capabilities?.effortLevels ?: emptyList()) },
            )
        } else {
            ModelSelection(instanceId = instance.instanceId, model = instance.models.defaultModel, effort = null)
        }

    /** The line under the pickers, or null when nothing stands in the way. */
    fun note(botBusy: Boolean?, instance: Instance?): String? = when {
        botBusy == true -> BUSY_NOTE
        instance?.snapshot?.isAvailable != true -> UNAVAILABLE_NOTE
        else -> null
    }

    fun instanceLabel(instance: Instance): String {
        // A custom display name wins. A bare instance id gets a Chinese name
        // where we know the provider, so the picker does not read like a config
        // file on a Chinese phone.
        val display = instance.displayName?.trim()?.takeIf { it.isNotEmpty() }
        val name = when {
            display != null && display != instance.instanceId -> display
            providerNames[instance.instanceId] != null -> providerNames.getValue(instance.instanceId)
            else -> instance.instanceId
        }
        return if (instance.snapshot.isAvailable) name else "$name（不可用）"
    }

    private val providerNames: Map<String, String> = mapOf(
        "openai" to "OpenAI",
        "openaiCompat" to "OpenAI 兼容",
        "claude" to "Claude",
        "claudeApi" to "Claude（API）",
        "xaiApi" to "xAI Grok",
        "grok" to "Grok",
        "openrouter" to "OpenRouter",
        "deepseek" to "DeepSeek",
        "qwen" to "通义千问",
        "kimi" to "Kimi",
        "codex" to "Codex",
        "chatgpt" to "ChatGPT",
        "cursor" to "Cursor",
        "githubCopilot" to "GitHub Copilot",
        "opencodeGo" to "OpenCode Go",
        "antigravity" to "Antigravity",
        "mistral" to "Mistral",
        "cerebras" to "Cerebras",
        "groq" to "Groq",
        "meta" to "Meta",
        "museCode" to "Muse",
        "commandCode" to "Command Code",
        "kiro" to "Kiro",
        "droid" to "Droid",
        "hermes" to "Hermes",
        "cline" to "Cline",
        // `pi` is the only engine this build runs, and the desktop never shows
        // its internal name: it names the provider it drives (`engine-name.ts`).
        // The picker says the same thing as the transcript's notices.
        "pi" to ActivityNaming.engineName("pi"),
    )

    fun effortLabel(effort: String): String = when (effort.lowercase()) {
        "low" -> "低"
        "medium" -> "中"
        "high" -> "高"
        "xhigh" -> "极高"
        else -> effort.replaceFirstChar { it.uppercase() }
    }
}
