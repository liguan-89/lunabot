package com.lunabot.companion.ui

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.Markdown
import com.lunabot.companion.core.MarkdownBlock
import kotlinx.coroutines.launch

/**
 * Bot replies, rendered — the port of `ios/App/MarkdownText.swift`.
 *
 * `Markdown.blocks` (`:core`) does the splitting; this draws each block and hands
 * the inline run to [InlineMarkdown], which knows emphasis, code spans,
 * strikethrough and links. Links are tappable, which is most of why this is worth
 * doing at all — a reply full of sources was otherwise a wall of bracketed URLs.
 *
 * Only bot messages get this. The desktop makes the same split: what you typed is
 * shown as you typed it, because markdown you did not intend is worse than
 * markdown you did.
 */
@Composable
fun MarkdownText(
    source: String,
    modifier: Modifier = Modifier,
    /**
     * Draws a caret after the last block. The streaming bubble sets this so the
     * live reply and the settled one are the same view with the same layout — a
     * caret bolted on outside would sit on its own line the moment the reply ends
     * in a list item.
     */
    caret: Boolean = false,
    /**
     * Where a tapped link goes. Null hands every link to the system; a chat
     * supplies this so a bot's desktop path is fetched through the computer
     * instead of handed to a browser that cannot reach it.
     */
    openLink: ((String) -> Unit)? = null,
) {
    val blocks = Markdown.blocks(source)
    CompositionLocalProvider(LocalLinkOpener provides openLink) {
        Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            blocks.forEachIndexed { index, block ->
                MarkdownBlockView(block, tail = caret && index == blocks.lastIndex)
            }
        }
    }
}

/** The opener [MarkdownText] was given, reachable from every block's inline run. */
private val LocalLinkOpener = compositionLocalOf<((String) -> Unit)?> { null }

@Composable
private fun MarkdownBlockView(block: MarkdownBlock, tail: Boolean) {
    val muted = secondaryTint
    when (block) {
        is MarkdownBlock.Paragraph ->
            Text(
                text = inline(block.text, tail, muted),
                fontSize = 15.5.sp,
                lineHeight = 22.sp,
                letterSpacing = 0.08.sp,
                color = minisInk,
            )

        is MarkdownBlock.Heading ->
            // Three sizes, not six. A chat bubble is not a document, and an h4
            // that looks exactly like body text is a heading that failed.
            Text(
                text = inline(block.text, tail, muted),
                fontSize = when {
                    block.level <= 1 -> 19.sp
                    block.level == 2 -> 17.5.sp
                    else -> 16.sp
                },
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = 2.dp),
            )

        is MarkdownBlock.Bullet -> MarkerRow("•", block.indent, block.text, tail, muted)

        is MarkdownBlock.Ordered -> MarkerRow("${block.number}.", block.indent, block.text, tail, muted)

        is MarkdownBlock.Quote ->
            Row(
                modifier = Modifier.height(IntrinsicSize.Min),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    Modifier
                        .width(3.dp)
                        .fillMaxHeight()
                        .background(muted.copy(alpha = 0.4f), RoundedCornerShape(1.5.dp)),
                )
                Text(inline(block.text, tail, muted), fontSize = 15.5.sp, lineHeight = 22.5.sp, color = muted)
            }

        is MarkdownBlock.Table -> {
            val tableScroll = rememberScrollState()
            val fadeLeft = tableScroll.canScrollBackward
            val fadeRight = tableScroll.canScrollForward
            val tableShape = RoundedCornerShape(14.dp)
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(tableShape)
                    .background(minisCard, tableShape)
                    .border(0.5.dp, minisSeparator, tableShape)
                    .padding(vertical = 10.dp),
            ) {
                DataGrid(
                    headers = block.headers,
                    rows = block.rows,
                    modifier = Modifier
                        .fillMaxWidth()
                        .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                        .drawWithContent {
                            drawContent()
                            if (fadeLeft || fadeRight) {
                                val edge = 20.dp.toPx().coerceAtMost(size.width * 0.2f)
                                val l = if (size.width > 0f) edge / size.width else 0f
                                val r = if (size.width > 0f) 1f - edge / size.width else 1f
                                drawRect(
                                    brush = Brush.horizontalGradient(
                                        0f to if (fadeLeft) Color.Transparent else Color.Black,
                                        l to Color.Black,
                                        r to Color.Black,
                                        1f to if (fadeRight) Color.Transparent else Color.Black,
                                    ),
                                    blendMode = BlendMode.DstIn,
                                )
                            }
                        }
                        .horizontalScroll(tableScroll)
                        .padding(horizontal = 12.dp),
                )
            }
        }

        is MarkdownBlock.Code -> {
            val clipboard = LocalClipboard.current
            val scope = rememberCoroutineScope()
            var copied by remember(block.text) { mutableStateOf(false) }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(muted.copy(alpha = 0.14f), RoundedCornerShape(10.dp))
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = block.language?.takeIf { it.isNotEmpty() } ?: "",
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Medium,
                        color = muted,
                        modifier = Modifier.weight(1f),
                    )
                    // The clipboard preview is the confirmation; the label only
                    // reports it so a second tap is never mistaken for a first.
                    Text(
                        text = if (copied) "已复制" else "复制",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (copied) MaterialTheme.colorScheme.primary else muted,
                        modifier = Modifier
                            .clip(CircleShape)
                            .clickable(role = Role.Button) {
                                scope.launch {
                                    clipboard.setClipEntry(
                                        ClipEntry(ClipData.newPlainText("code", block.text)),
                                    )
                                    copied = true
                                }
                            }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
                // Horizontal scroll rather than wrapping: wrapped code is harder
                // to read than code you have to push sideways, and indentation is
                // most of what a snippet is saying.
                // Selection is the caller's to grant: a settled bubble wraps this
                // whole block in a SelectionContainer, and the live one must not.
                Text(
                    text = buildAnnotatedString {
                        append(block.text)
                        appendCaret(tail, muted)
                    },
                    fontSize = 14.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                )
            }
        }

        MarkdownBlock.Rule -> HorizontalDivider(Modifier.padding(vertical = 2.dp))
    }
}

@Composable
private fun MarkerRow(symbol: String, indent: Int, text: String, tail: Boolean, muted: Color) {
    Row(
        modifier = Modifier.padding(start = (indent * 14).dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = symbol,
            fontSize = 15.5.sp,
            lineHeight = 22.5.sp,
            color = muted,
            modifier = Modifier.widthIn(min = 16.dp),
        )
        Text(inline(text, tail, muted), fontSize = 15.5.sp, lineHeight = 22.5.sp)
    }
}

@Composable
private fun inline(text: String, tail: Boolean, muted: Color): AnnotatedString {
    val linkColor = MaterialTheme.colorScheme.primary
    val opener = LocalLinkOpener.current
    return buildAnnotatedString {
        for (span in InlineMarkdown.parse(text)) {
            val style = SpanStyle(
                fontWeight = if (InlineStyle.BOLD in span.styles) FontWeight.Bold else null,
                fontStyle = if (InlineStyle.ITALIC in span.styles) FontStyle.Italic else null,
                fontFamily = if (InlineStyle.CODE in span.styles) FontFamily.Monospace else null,
                textDecoration = if (InlineStyle.STRIKE in span.styles) TextDecoration.LineThrough else null,
            )
            // An empty destination is a legal link (`[x]()`), but there is
            // nothing to open — render the label and leave it inert rather than
            // handing the UriHandler a blank URI.
            val url = span.link?.takeIf { it.isNotBlank() }
            if (url == null) {
                withStyle(style) { append(span.text) }
            } else {
                withLink(
                    LinkAnnotation.Url(
                        url,
                        TextLinkStyles(
                            style = style.copy(
                                color = linkColor,
                                textDecoration = TextDecoration.Underline,
                            ),
                        ),
                        // With an opener the UriHandler is never consulted.
                        linkInteractionListener = opener?.let { open -> LinkInteractionListener { open(url) } },
                    ),
                ) { append(span.text) }
            }
        }
        appendCaret(tail, muted)
    }
}

/**
 * A figure space then a block, so the caret sits off the last glyph rather than
 * touching it. It does not blink, deliberately — a caret that blinks twice and
 * stops looks more broken than one that never blinks.
 */
private fun androidx.compose.ui.text.AnnotatedString.Builder.appendCaret(tail: Boolean, muted: Color) {
    if (!tail) return
    withStyle(SpanStyle(color = muted)) { append(" ▍") }
}
