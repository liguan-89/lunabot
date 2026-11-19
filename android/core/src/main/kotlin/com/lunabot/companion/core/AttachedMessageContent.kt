package com.openmausbot.companion.core

/** A safe, quiet label for an attachment encoded in a stored user prompt. */
data class DisplayedMessageAttachment(
    val kind: Kind,
    val name: String,
    /** The computer-local path carried by the exact standalone transport tag. */
    val path: String,
    /** `kind == AUDIO`: the server's duration estimate, shown until the player loads metadata. */
    val durationMs: Double? = null,
) {
    enum class Kind { IMAGE, FILE, AUDIO }
}

data class AttachedMessageContent(
    val text: String,
    val attachments: List<DisplayedMessageAttachment>,
) {
    companion object {
        /** Split only exact standalone tags; inline examples remain ordinary prose. */
        fun parse(source: String): AttachedMessageContent {
            val attachments = mutableListOf<DisplayedMessageAttachment>()
            val visible = StringBuilder()
            var fence: Fence? = null
            var htmlBlock: HtmlBlock? = null
            // Inside a paste whose opening wrapper line was hidden, so its
            // exact closing line is hidden too.
            var hidingPasteWrapper = false
            var cursor = 0
            while (cursor < source.length) {
                val newline = source.indexOf('\n', cursor)
                val lineEnd = if (newline >= 0) newline else source.length
                val wholeLineEnd = if (newline >= 0) newline + 1 else source.length
                val rawLine = source.substring(cursor, lineEnd)
                val line = rawLine.removeSuffix("\r")
                var consumedTransportTag = false

                val marker = fenceMarker(line)
                val activeFence = fence
                if (activeFence != null) {
                    if (
                        marker != null && marker.character == activeFence.character &&
                        marker.length >= activeFence.length && marker.remainder.all { it == ' ' || it == '\t' }
                    ) {
                        fence = null
                    }
                } else if (htmlBlock != null) {
                    val activeHTMLBlock = htmlBlock!!
                    val shouldEnd = activeHTMLBlock.closingToken
                        ?.let { it in line.lowercase() }
                        ?: line.all { it == ' ' || it == '\t' }
                    if (shouldEnd) {
                        if (hidingPasteWrapper && PASTED_TEXT_CLOSE.matches(line)) consumedTransportTag = true
                        htmlBlock = null
                        hidingPasteWrapper = false
                    }
                } else if (marker != null) {
                    fence = Fence(marker.character, marker.length)
                } else {
                    val match = TAG.matchEntire(line)
                    if (match != null) {
                        val path = decodeAttribute(match.groupValues[2])
                        // A voice message travels as an ordinary file tag —
                        // there is no audio tag on the wire. What makes it a
                        // player instead of a document card is the extension
                        // the computer stored it under.
                        val kind = when {
                            match.groupValues[1] == "image" -> DisplayedMessageAttachment.Kind.IMAGE
                            isAudioPath(path) -> DisplayedMessageAttachment.Kind.AUDIO
                            else -> DisplayedMessageAttachment.Kind.FILE
                        }
                        val provided = match.groups[3]?.value?.let(::decodeAttribute)
                        attachments += DisplayedMessageAttachment(
                            kind = kind,
                            name = displayName(provided, path, kind),
                            path = path,
                        )
                        consumedTransportTag = true
                    } else {
                        htmlBlock = htmlBlockStarting(line)
                        // The bot needs the <pasted-text> wrapper to tell pasted
                        // from typed text; the person reading it does not.
                        if (htmlBlock?.closingToken == "</pasted-text>" && PASTED_TEXT_OPEN.matches(line)) {
                            hidingPasteWrapper = true
                            consumedTransportTag = true
                        }
                    }
                }

                if (!consumedTransportTag) visible.append(source, cursor, wholeLineEnd)
                cursor = wholeLineEnd
            }
            return AttachedMessageContent(
                text = visible.toString().trim(),
                attachments = attachments,
            )
        }

        /** The extensions the computer's upload route uses for audio files. */
        internal fun isAudioPath(path: String): Boolean {
            val extension = path.substringAfterLast('.', "").lowercase()
            return extension in AUDIO_EXTENSIONS
        }

        private val AUDIO_EXTENSIONS = setOf(
            "m4a", "mp3", "aac", "ogg", "opus", "wav", "flac", "webm",
        )

        private data class Fence(val character: Char, val length: Int)
        private data class FenceMarker(val character: Char, val length: Int, val remainder: String)
        /** A null token is a CommonMark type 6/7 block, which ends at a blank line. */
        private data class HtmlBlock(val closingToken: String?)

        private fun htmlBlockStarting(line: String): HtmlBlock? {
            val lower = line.lowercase()
            val comment = lower.indexOf("<!--")
            if (comment >= 0 && lower.indexOf("-->", comment + 4) < 0) return HtmlBlock("-->")

            val content = commonMarkContent(line) ?: return null
            val lowerContent = content.lowercase()

            if (PASTED_TEXT_START.containsMatchIn(line)) {
                return if ("</pasted-text>" in lowerContent) null else HtmlBlock("</pasted-text>")
            }

            val typeOne = TYPE_ONE.find(line)
            if (typeOne != null) {
                val closingToken = "</${typeOne.groupValues[1].lowercase()}>"
                return if (closingToken in lower) null else HtmlBlock(closingToken)
            }

            if (lowerContent.startsWith("<?")) {
                return if ("?>" in lowerContent.drop(2)) null else HtmlBlock("?>")
            }
            if (lowerContent.startsWith("<![cdata[")) {
                return if ("]]>" in lowerContent.drop(9)) null else HtmlBlock("]]>")
            }
            if (
                content.startsWith("<!") &&
                (content.getOrNull(2) in 'A'..'Z' || content.getOrNull(2) in 'a'..'z')
            ) {
                return if ('>' in content.drop(2)) null else HtmlBlock(">")
            }

            if (TYPE_SIX.containsMatchIn(line) || TYPE_SEVEN.matches(line)) return HtmlBlock(null)
            return null
        }

        private fun commonMarkContent(line: String): String? {
            var index = 0
            while (index < line.length && line[index] == ' ') {
                index += 1
                if (index > 3) return null
            }
            return line.substring(index)
        }

        private fun fenceMarker(line: String): FenceMarker? {
            var index = 0
            while (index < line.length && index < 4 && line[index] == ' ') index += 1
            if (index > 3 || index >= line.length) return null
            val character = line[index]
            if (character != '`' && character != '~') return null
            val start = index
            while (index < line.length && line[index] == character) index += 1
            val length = index - start
            if (length < 3) return null
            return FenceMarker(character, length, line.substring(index))
        }

        private val TAG = Regex(
            """^<attached-(image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*/>[\t ]*$""",
        )

        private val COMMONMARK_BLOCK_TAGS = listOf(
            "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
            "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
            "footer", "form", "frame", "frameset", "h[1-6]", "head", "header", "hr", "html", "iframe", "legend",
            "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p",
            "param", "search", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "title",
            "tr", "track", "ul",
        ).joinToString("|")
        /** The exact wrapper lines the desktop composer writes around a paste. */
        private val PASTED_TEXT_OPEN = Regex("""^ {0,3}<pasted-text(?:[\t ]+index="\d+")?[\t ]*>[\t ]*$""", RegexOption.IGNORE_CASE)
        private val PASTED_TEXT_CLOSE = Regex("""^[\t ]*</pasted-text>[\t ]*$""", RegexOption.IGNORE_CASE)
        private val PASTED_TEXT_START = Regex("""^ {0,3}<pasted-text(?:[\t >]|$)""", RegexOption.IGNORE_CASE)
        private val TYPE_ONE = Regex(
            """^ {0,3}<(script|pre|style|textarea)(?:[\t ]|>|$)""",
            RegexOption.IGNORE_CASE,
        )
        private val TYPE_SIX = Regex(
            """^ {0,3}</?(?:$COMMONMARK_BLOCK_TAGS)(?:[\t ]|/?>|$)""",
            RegexOption.IGNORE_CASE,
        )
        private val TYPE_SEVEN = Regex(
            """^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[\t ]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[\t ]*=[\t ]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[\t ]*/?>|</[A-Za-z][A-Za-z0-9-]*[\t ]*>)[\t ]*$""",
        )

        private fun decodeAttribute(value: String): String = value
            .replace("&#9;", "\t")
            .replace("&#10;", "\n")
            .replace("&#13;", "\r")
            .replace("&quot;", "\"")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")

        internal fun displayName(
            providedName: String?,
            path: String?,
            kind: DisplayedMessageAttachment.Kind,
        ): String {
            fun basename(source: String?): String? {
                val value = source?.trim()?.split('/', '\\')?.lastOrNull(String::isNotEmpty)
                return value?.takeUnless { it == "." || it == ".." }
            }
            val fallback = basename(path)
            val providedBasename = basename(providedName)
            val generic = when (kind) {
                DisplayedMessageAttachment.Kind.IMAGE -> "Image"
                DisplayedMessageAttachment.Kind.FILE -> "File"
                DisplayedMessageAttachment.Kind.AUDIO -> "Voice note"
            }
            return sanitisePortableFilename(providedBasename ?: fallback ?: generic, generic)
        }
    }
}

/** Preserve the server path exactly for the originating message's authenticated file route. */
val Message.generatedImages: List<DisplayedMessageAttachment>
    get() = attachments.orEmpty()
        .filter { it.kind == "image" && !it.path.isNullOrBlank() }
        .distinctBy { it.path }
        .map {
            val path = requireNotNull(it.path)
            DisplayedMessageAttachment(
                kind = DisplayedMessageAttachment.Kind.IMAGE,
                path = path,
                name = AttachedMessageContent.displayName(null, path, DisplayedMessageAttachment.Kind.IMAGE),
            )
        }

/**
 * Voice notes ride ordinary bot text messages in one of two wire shapes: a
 * TTS note parked as `kind: "audio"` (path, mime, duration estimate, no
 * name), or an `attach_file` handover as `kind: "file"` (path, mime, name)
 * whose mime or extension is audio. The old gate mirrored the desktop
 * bubble's `attachmentAudioUrl` allowlist — only a bare generated `.mp3`
 * basename rendered there — but Android fetches through the message-scoped
 * POST route, so the gate only dropped valid notes (m4a handovers,
 * extensionless audio) and is gone.
 */
val Message.voiceNotes: List<DisplayedMessageAttachment>
    get() = attachments.orEmpty()
        .filter { it.isAudioAttachment() && !it.path.isNullOrBlank() }
        .distinctBy { it.path }
        .map { attachment ->
            val path = requireNotNull(attachment.path)
            DisplayedMessageAttachment(
                kind = DisplayedMessageAttachment.Kind.AUDIO,
                path = path,
                // A handover names itself; a parked note keeps the generic
                // label rather than its bare uuid basename.
                name = AttachedMessageContent.displayName(
                    attachment.name,
                    null,
                    DisplayedMessageAttachment.Kind.AUDIO,
                ),
                durationMs = attachment.durationMs?.takeIf { it > 0.0 },
            )
        }

/**
 * Non-audio `attach_file` handovers: document cards beside any voice notes
 * in the same message. A path claimed by [voiceNotes] renders once, as the
 * player.
 */
val Message.fileAttachments: List<DisplayedMessageAttachment>
    get() {
        val claimed = voiceNotes.mapTo(mutableSetOf(), DisplayedMessageAttachment::path)
        return attachments.orEmpty()
            .filter { it.kind == "file" && !it.isAudioAttachment() && !it.path.isNullOrBlank() }
            .mapNotNull { attachment ->
                val path = requireNotNull(attachment.path)
                if (path in claimed) return@mapNotNull null
                DisplayedMessageAttachment(
                    kind = DisplayedMessageAttachment.Kind.FILE,
                    path = path,
                    name = AttachedMessageContent.displayName(
                        attachment.name,
                        path,
                        DisplayedMessageAttachment.Kind.FILE,
                    ),
                )
            }
            .distinctBy { it.path }
    }

/** Audio by the declared mime, else by the extension the computer stored it under. */
private fun MessageImageAttachment.isAudioAttachment(): Boolean =
    (kind == "audio" || kind == "file") &&
        (mime?.trim()?.lowercase()?.startsWith("audio/") == true || AttachedMessageContent.isAudioPath(path.orEmpty()))
