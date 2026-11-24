package com.lunabot.companion.ui.widget

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.WIDGET_FIELD_TYPES
import com.lunabot.companion.core.WidgetNode
import com.lunabot.companion.core.widgetNumber
import com.lunabot.companion.core.widgetString
import com.lunabot.companion.ui.MarkdownText
import com.lunabot.companion.ui.minisAccent
import com.lunabot.companion.ui.minisDanger
import com.lunabot.companion.ui.minisInk
import com.lunabot.companion.ui.minisPaperBorder
import com.lunabot.companion.ui.minisRaised
import com.lunabot.companion.ui.minisSecondary
import com.lunabot.companion.ui.minisSeparator
import com.lunabot.companion.ui.minisSoftCard
import com.lunabot.companion.ui.minisSuccess
import com.lunabot.companion.ui.minisTertiary
import com.lunabot.companion.ui.minisWarning

/** 下行给子节点的版式上下文：父轴方向、行距、是不是列表项第一列、是不是表格单元格。 */
class Ctx(
    val axis: String = "col",
    val gap: Int = 12,
    val item: Boolean = false,
    val lead: Boolean = false,
    val cell: Boolean = false,
    val listName: String? = null,
    /** 卡的直属子级（桌面 where.card）：Row 给 min-h 44 / stacked 时上下 10。 */
    val card: Boolean = false,
    /** 父 Col stretch：子项应占满行宽（按钮变 block）。 */
    val fill: Boolean = false,
)

private val TEXT_SIZES = mapOf("xs" to 12.sp, "sm" to 13.sp, "md" to 14.sp, "lg" to 16.sp, "xl" to 18.sp)
private val TITLE_SIZES = mapOf("sm" to 15.sp, "md" to 17.sp, "lg" to 20.sp, "xl" to 24.sp, "2xl" to 28.sp, "3xl" to 32.sp, "4xl" to 40.sp, "5xl" to 48.sp)
private val CAPTION_SIZES = mapOf("sm" to 12.sp, "md" to 13.sp, "lg" to 14.sp)
private val ICON_SIZES = mapOf("xs" to 12, "sm" to 14, "md" to 16, "lg" to 20, "xl" to 24, "2xl" to 28, "3xl" to 32)
private val COL_SIZES = mapOf("xs" to 48, "sm" to 72, "md" to 120, "lg" to 180, "xl" to 240)

@Composable
fun inkColor(name: String?): Color = when (name) {
    "secondary" -> minisSecondary
    "tertiary" -> minisTertiary
    "success" -> minisSuccess
    "warning" -> minisWarning
    "danger" -> minisDanger
    else -> minisInk
}

@Composable
private fun backgroundColor(name: String?): Color = when (name) {
    "surface" -> minisRaised
    "secondary" -> minisSoftCard
    "elevated" -> minisRaised
    else -> minisInk.copy(alpha = 0.07f)
}

private fun fourSides(raw: Any?): List<Int>? =
    (raw as? kotlinx.serialization.json.JsonArray)
        ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.doubleOrNull?.toInt() }
        ?.takeIf { it.size == 4 }

private fun pad(node: WidgetNode, default: Int = 0): Modifier {
    val sides = fourSides(node["padding"]) ?: return Modifier.padding(default.dp)
    return Modifier.padding(start = sides[0].dp, top = sides[1].dp, end = sides[2].dp, bottom = sides[3].dp)
}

/** 长度 prop：数字是 px，"full" 是撑满。 */
private fun len(node: WidgetNode, key: String, base: Modifier): Modifier {
    val raw = node[key]
    val num = (raw as? kotlinx.serialization.json.JsonPrimitive)?.doubleOrNull
    val full = (raw as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull == "full"
    return when {
        num != null -> when (key) {
            "width" -> base.width(num.dp)
            "height" -> base.height(num.dp)
            "minWidth" -> base.widthIn(min = num.dp)
            "maxWidth" -> base.widthIn(max = num.dp)
            "minHeight" -> base.heightIn(min = num.dp)
            "maxHeight" -> base.heightIn(max = num.dp)
            else -> base
        }
        full -> when (key) {
            "width" -> base.fillMaxWidth()
            "height" -> base.heightIn(min = 0.dp)
            else -> base
        }
        else -> base
    }
}

@Composable
fun layoutModifier(node: WidgetNode): Modifier {
    var mod: Modifier = Modifier
    for (key in listOf("width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight")) mod = len(node, key, mod)
    widgetNumber(node, "aspectRatio")?.let { if (it > 0) mod = mod.aspectRatio(it.toFloat()) }
    mod = mod.then(pad(node))
    widgetNumber(node, "radius")?.let { mod = mod.clip(RoundedCornerShape(it.dp)) }
    node.str("background")?.let { mod = mod.background(backgroundColor(it), RoundedCornerShape((widgetNumber(node, "radius") ?: 8.0).dp)) }
    widgetNumber(node, "border")?.let { mod = mod.border(it.dp, minisSeparator, RoundedCornerShape((widgetNumber(node, "radius") ?: 8.0).dp)) }
    return mod
}

private fun textAlignOf(node: WidgetNode): TextAlign = when (node.str("textAlign")) {
    "center" -> TextAlign.Center
    "end" -> TextAlign.End
    else -> TextAlign.Start
}

private fun weightOf(node: WidgetNode): FontWeight = when (node.str("weight")) {
    "medium" -> FontWeight.Medium
    "semibold" -> FontWeight.SemiBold
    "bold" -> FontWeight.Bold
    else -> FontWeight.Normal
}

@Composable
private fun WidgetTextView(node: WidgetNode, baseSize: androidx.compose.ui.unit.TextUnit, weight: FontWeight, color: Color) {
    val value = widgetString(node, "value") ?: return
    val width = (node["width"] as? kotlinx.serialization.json.JsonPrimitive)?.doubleOrNull
    Text(
        text = value,
        fontSize = TEXT_SIZES[node.str("size")] ?: baseSize,
        fontWeight = weightOf(node).let { if (it == FontWeight.Normal) weight else it },
        color = inkColor(node.str("color")).let { if (node.str("color") == null) color else it },
        textAlign = textAlignOf(node),
        fontStyle = if (node.bool("italic")) FontStyle.Italic else null,
        textDecoration = if (node.bool("lineThrough")) TextDecoration.LineThrough else null,
        maxLines = if (node.bool("truncate")) 1 else (widgetNumber(node, "maxLines")?.toInt() ?: Int.MAX_VALUE),
        minLines = widgetNumber(node, "minLines")?.toInt() ?: 1,
        overflow = if (node.bool("truncate")) TextOverflow.Ellipsis else TextOverflow.Clip,
        modifier = if (width != null) Modifier.width(width.dp) else Modifier,
    )
}

@Composable
private fun WidgetBadge(node: WidgetNode) {
    val label = widgetString(node, "label") ?: return
    val name = node.str("color") ?: "secondary"
    val tone = when (name) {
        "success" -> minisSuccess
        "danger" -> minisDanger
        "warning" -> minisWarning
        "info" -> minisAccent
        "discovery" -> minisAccent
        else -> minisSecondary
    }
    val height = when (node.str("size")) { "sm" -> 20; "lg" -> 26; else -> 22 }
    val fontSize = when (node.str("size")) { "sm" -> 11.sp; "lg" -> 13.sp; else -> 12.sp }
    val padH = when (node.str("size")) { "sm" -> 8; "lg" -> 11; else -> 9 }
    val shape = if (node.bool("pill")) CircleShape else RoundedCornerShape(6.dp)
    when (node.str("variant")) {
        "solid" -> Text(
            label, fontSize = fontSize, fontWeight = FontWeight.Medium, color = Color.White,
            modifier = Modifier.height(height.dp).background(tone, shape).padding(horizontal = padH.dp).wrapContentHeight(),
        )
        "outline" -> Text(
            label, fontSize = fontSize, fontWeight = FontWeight.Medium, color = tone,
            modifier = Modifier.height(height.dp).border(1.dp, tone.copy(alpha = 0.5f), shape).padding(horizontal = padH.dp).wrapContentHeight(),
        )
        "dot" -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Box(Modifier.size(6.dp).background(tone, CircleShape))
            Text(label, fontSize = fontSize, fontWeight = FontWeight.Medium, color = tone)
        }
        else -> Text(
            label, fontSize = fontSize, fontWeight = FontWeight.Medium, color = tone,
            modifier = Modifier.height(height.dp).background(tone.copy(alpha = 0.12f), shape).padding(horizontal = padH.dp).wrapContentHeight(),
        )
    }
}

@Composable
private fun WidgetProgress(node: WidgetNode) {
    val value = (widgetNumber(node, "value") ?: 0.0).toFloat().coerceIn(0f, 1f)
    val label = widgetString(node, "label")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        LinearProgressIndicator(
            progress = { value },
            modifier = Modifier.weight(1f),
            color = minisInk,
            trackColor = minisInk.copy(alpha = 0.12f),
        )
        Text(label ?: "${(value * 100).toInt()}%", fontSize = 12.sp, color = minisSecondary)
    }
}

/** 节点自带按钮：pending 转圈、sent 对勾、locked/disabled 不可点。 */
@Composable
fun WidgetButtonView(node: WidgetNode, ref: String, label: String, look: String, form: WidgetFormState, press: (String) -> Unit, block: Boolean = false) {
    val pending = form.pendingRef == ref
    val sent = form.sentRef == ref
    val disabled = node.bool("disabled") || form.locked
    val modifier = (if (block) Modifier.fillMaxWidth() else Modifier)
        .height(34.dp)
        .clip(RoundedCornerShape(17.dp))
        .then(
            when (look) {
                "primary" -> Modifier.background(minisInk)
                "danger" -> Modifier.background(minisDanger)
                "secondary" -> Modifier.background(minisSoftCard)
                "outline" -> Modifier.border(1.dp, minisPaperBorder, RoundedCornerShape(17.dp))
                else -> Modifier
            },
        )
        .clickable(enabled = !disabled && !pending) { press(ref) }
        .padding(horizontal = 14.dp)
    Row(modifier, horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        if (pending) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = if (look == "primary") Color.White else minisInk)
            Spacer(Modifier.width(6.dp))
        }
        node.str("iconStart")?.let { WidgetGlyph(it, 14, if (look == "primary" || look == "danger") Color.White else minisInk); Spacer(Modifier.width(4.dp)) }
        Text(
            if (sent) "已发送" else label,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            color = when (look) {
                "primary", "danger" -> Color.White
                "quiet" -> minisSecondary
                else -> minisInk
            },
        )
        node.str("iconEnd")?.let { Spacer(Modifier.width(4.dp)); WidgetGlyph(it, 14, if (look == "primary" || look == "danger") Color.White else minisInk) }
    }
}

@Composable
private fun WidgetListViewItem(node: WidgetNode, form: WidgetFormState, press: (String) -> Unit, ctx: Ctx) {
    val entry = form.actions[node.id]
    val selected = ctx.listName != null && form.value(ctx.listName) == (node.str("value") ?: "")
    var mod = Modifier
        .fillMaxWidth()
        .then(if (entry != null || ctx.listName != null) Modifier.defaultMinSize(minHeight = 56.dp) else Modifier)
        .clip(RoundedCornerShape(10.dp))
    if (selected) mod = mod.background(minisSoftCard)
    mod = when {
        form.locked -> mod.padding(horizontal = 8.dp)
        ctx.listName != null -> mod.clickable { form.setValue(ctx.listName, node.str("value") ?: "") }.padding(horizontal = 8.dp)
        entry != null -> mod.clickable { press(node.id) }.padding(horizontal = 8.dp)
        else -> mod.padding(horizontal = 8.dp)
    }
    Row(mod.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy((node.num("gap") ?: ctx.gap.toDouble()).toInt().dp)) {
        if (ctx.listName != null) {
            Box(
                Modifier.size(18.dp).border(1.5.dp, if (selected) minisInk else minisSeparator, CircleShape).padding(4.dp),
                contentAlignment = Alignment.Center,
            ) { if (selected) Box(Modifier.size(8.dp).background(minisInk, CircleShape)) }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            WidgetChildren(node, form, press, Ctx("col", ctx.gap, item = true))
        }
        if (form.pendingRef == node.id) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp)
    }
}

@Composable
private fun WidgetTableView(node: WidgetNode, form: WidgetFormState, press: (String) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        node.children.forEachIndexed { index, row ->
            val header = row.type == "Table.Row" && row.bool("header")
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.Top) {
                row.children.forEach { cell ->
                    val colSize = COL_SIZES[cell.str("colSize")] ?: 120
                    val width = (cell["width"] as? kotlinx.serialization.json.JsonPrimitive)?.doubleOrNull
                    val span = (widgetNumber(cell, "colSpan") ?: 1.0).toInt()
                    val cellMod = if (width != null) Modifier.width(width.dp) else Modifier.width((colSize * span).dp)
                    Column(cellMod.then(pad(cell, 8))) {
                        WidgetChildren(cell, form, press, Ctx("col", 6, cell = true))
                    }
                }
            }
            if (header || index < node.children.size - 1) {
                HorizontalDivider(color = minisSeparator.copy(alpha = if (header) 1f else 0.4f), thickness = if (header) 1.dp else 0.5.dp)
            }
        }
    }
}

@Composable
fun WidgetNodeView(node: WidgetNode, form: WidgetFormState, press: (String) -> Unit, ctx: Ctx = Ctx()) {
    when (node.type) {
        "Row", "Col", "Form", "Box" -> WidgetLayout(node, form, press, ctx)
        "Card" -> Column(Modifier.fillMaxWidth().museLiteCard()) {
            WidgetChildren(node, form, press, Ctx("col", (widgetNumber(node, "gap") ?: 12.0).toInt()))
        }
        "ListViewItem" -> WidgetListViewItem(node, form, press, ctx)
        "Spacer" -> {
            val min = (widgetNumber(node, "minSize") ?: 0.0).toInt().coerceAtLeast(4)
            if (ctx.axis == "row") Spacer(Modifier.width(min.dp)) else Spacer(Modifier.height(min.dp))
        }
        "Divider" -> {
            val spacing = widgetNumber(node, "spacing")?.toInt() ?: 0
            HorizontalDivider(
                color = minisSeparator,
                thickness = 0.5.dp,
                modifier = Modifier.padding(vertical = (spacing / 2).dp).then(if (node.bool("flush")) Modifier.padding(horizontal = (-18).dp) else Modifier),
            )
        }
        "Table" -> WidgetTableView(node, form, press)
        "Text" -> WidgetTextView(node, 14.sp, FontWeight.Normal, minisInk)
        "Title" -> WidgetTextView(node, TITLE_SIZES[node.str("size")] ?: 17.sp, FontWeight.SemiBold, minisInk)
        "Caption" -> WidgetTextView(node, CAPTION_SIZES[node.str("size")] ?: 12.sp, FontWeight.Normal, minisSecondary)
        "Label" -> WidgetTextView(node, TEXT_SIZES[node.str("size")] ?: 13.sp, FontWeight.Medium, minisSecondary)
        "Markdown" -> widgetString(node, "value")?.let { MarkdownText(it) }
        "Icon" -> WidgetGlyph(node.str("name") ?: "dot", ICON_SIZES[node.str("size")] ?: 16, inkColor(node.str("color")))
        "Badge" -> WidgetBadge(node)
        "Progress" -> WidgetProgress(node)
        "Button" -> {
            val look = widgetString(node, "style") ?: "secondary"
            WidgetButtonView(node, node.id, widgetString(node, "label") ?: "", look, form, press, node.bool("block") || ctx.fill)
        }
        "Chart" -> WidgetChartView(node)
        "Image" -> WidgetRemoteImage(node, form)
        "Select", "DatePicker", "TimePicker", "DayPicker", "Checkbox", "RadioGroup", "Input", "Textarea" ->
            WidgetFieldView(node, form)
        else -> WidgetChildren(node, form, press, ctx)
    }
}

private val WORDS = setOf("Label", "Text", "Caption", "Title")
private val FLOWS = WIDGET_FIELD_TYPES + setOf("Button", "Badge", "Spacer")

private fun pairsField(node: WidgetNode) =
    node.children.any { it.type in WIDGET_FIELD_TYPES && it.type != "Checkbox" } &&
        node.children.any { it.type in WORDS }

private fun flows(children: List<WidgetNode>) = children.size > 1 && children.all { it.type in FLOWS }

/** 内部 fillMaxWidth 的子项：在收缩行里按 flex=1 分剩余宽（对应桌面 width:100% 基项收缩后的等效结果）。 */
private fun wantsRowFill(c: WidgetNode): Boolean = when {
    (c["width"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull == "full" -> true
    c.type == "Button" && c.bool("block") -> true
    c.type in WIDGET_FIELD_TYPES -> true
    c.type in setOf("Progress", "Divider", "Table", "Card", "ListViewItem", "Chart", "Image") -> true
    else -> false
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WidgetLayout(node: WidgetNode, form: WidgetFormState, press: (String) -> Unit, ctx: Ctx) {
    val stacked = form.compact && node.type == "Row" && pairsField(node)
    val isRow = !stacked && (node.type == "Row" || (node.type != "Col" && node.str("direction") == "row"))
    val gap = if (stacked) 6 else (widgetNumber(node, "gap")?.toInt() ?: (if (isRow) 8 else if (node.type == "Form") 12 else 0))
    val shown = if (stacked) node.children.filter { it.type != "Spacer" } else node.children
    val alignName = if (stacked) "stretch" else node.str("align") ?: (if (isRow) "center" else "stretch")
    var mod = layoutModifier(node).fillMaxWidth()
    if (ctx.card && node.type == "Row") mod = if (stacked) mod.padding(vertical = 10.dp) else mod.heightIn(min = 44.dp)
    if (isRow) {
        val vAlign = when (alignName) {
            "center", "baseline" -> Alignment.CenterVertically
            "end" -> Alignment.Bottom
            else -> Alignment.Top
        }
        if (node.bool("wrap") || flows(shown)) {
            val justifyH: Arrangement.Horizontal = when (node.str("justify")) {
                "center" -> Arrangement.spacedBy(gap.dp, Alignment.CenterHorizontally)
                "end" -> Arrangement.spacedBy(gap.dp, Alignment.End)
                "between" -> Arrangement.SpaceBetween
                "around" -> Arrangement.SpaceAround
                "evenly" -> Arrangement.SpaceEvenly
                else -> Arrangement.spacedBy(gap.dp)
            }
            FlowRow(mod, horizontalArrangement = justifyH, verticalArrangement = Arrangement.spacedBy(gap.dp)) {
                shown.forEach { child -> WidgetNodeView(child, form, press, Ctx("row", gap)) }
            }
        } else {
            ShrinkRow(mod, gap.dp, vAlign, alignName == "stretch", node.str("justify"), shown) {
                shown.forEach { child -> WidgetNodeView(child, form, press, Ctx("row", gap)) }
            }
        }
    } else {
        val justifyV: Arrangement.Vertical = when (node.str("justify")) {
            "center" -> Arrangement.spacedBy(gap.dp, Alignment.CenterVertically)
            "end" -> Arrangement.spacedBy(gap.dp, Alignment.Bottom)
            "between" -> Arrangement.SpaceBetween
            "around" -> Arrangement.SpaceAround
            "evenly" -> Arrangement.SpaceEvenly
            else -> Arrangement.spacedBy(gap.dp)
        }
        val stretch = alignName == "stretch"
        Column(mod, verticalArrangement = justifyV, horizontalAlignment = when (alignName) {
            "center" -> Alignment.CenterHorizontally
            "end" -> Alignment.End
            else -> Alignment.Start
        }) {
            shown.forEach { child ->
                val flex = widgetNumber(child, "flex")
                val cctx = Ctx("col", gap, fill = stretch)
                when {
                    flex != null && flex > 0 -> Box(Modifier.weight(flex.toFloat()).fillMaxWidth()) { WidgetNodeView(child, form, press, cctx) }
                    stretch -> Box(Modifier.fillMaxWidth()) { WidgetNodeView(child, form, press, cctx) }
                    else -> WidgetNodeView(child, form, press, cctx)
                }
            }
        }
    }
}

/** 桌面 flex 行的对应物：先按固有宽排，挤不下按 CSS flex-shrink 等比收缩（min-w-0 可到 0），
 *  `flex` 子项按比例吃剩余空间；富余宽度交给 justify 分布。 */
@Composable
private fun ShrinkRow(
    modifier: Modifier,
    gap: Dp,
    vAlign: Alignment.Vertical,
    stretch: Boolean,
    justify: String?,
    children: List<WidgetNode>,
    content: @Composable () -> Unit,
) {
    val flexes = children.map { c ->
        widgetNumber(c, "flex")?.toFloat()?.takeIf { it > 0f } ?: if (wantsRowFill(c)) 1f else 0f
    }
    Layout(content = content, modifier = modifier) { measurables, constraints ->
        val n = measurables.size
        if (n == 0) return@Layout layout(0, 0) {}
        val gapPx = gap.roundToPx()
        val avail = (constraints.maxWidth - gapPx * (n - 1)).coerceAtLeast(0)
        // measure() 对每个 Measurable 只能调一次：固有宽与 stretch 行高都走
        // intrinsic 预估，最终尺寸在唯一一次 measure 里以固定宽约束下发。
        val widths = IntArray(n) { measurables[it].maxIntrinsicWidth(Constraints.Infinity) }
        val flexSum = flexes.sumOf { it.coerceAtLeast(0f).toDouble() }.toFloat()
        when {
            flexSum > 0f -> {
                val room = (avail - widths.filterIndexed { i, _ -> flexes[i] <= 0f }.sum()).coerceAtLeast(0)
                for (i in 0 until n) if (flexes[i] > 0f) widths[i] = (room * flexes[i] / flexSum).toInt()
            }
            widths.sum() > avail -> {
                val total = widths.sum()
                for (i in 0 until n) widths[i] = (avail.toLong() * widths[i] / total).toInt()
            }
        }
        val height = if (stretch) {
            maxOf(
                measurables.indices.maxOf { measurables[it].maxIntrinsicHeight(widths[it]) },
                constraints.minHeight,
            ).coerceAtMost(constraints.maxHeight)
        } else 0
        val placed = measurables.mapIndexed { i, m ->
            if (stretch) m.measure(Constraints.fixed(widths[i], height))
            else m.measure(Constraints(minWidth = widths[i], maxWidth = widths[i], maxHeight = constraints.maxHeight))
        }
        val rowH = if (stretch) height
        else maxOf(placed.maxOf { it.height }, constraints.minHeight).coerceAtMost(constraints.maxHeight)
        layout(constraints.maxWidth, rowH) {
            val free = (avail - widths.sum()).coerceAtLeast(0)
            var x = 0
            var between = gapPx
            when (justify) {
                "center" -> x = free / 2
                "end" -> x = free
                "between" -> if (n > 1) between = gapPx + free / (n - 1)
                "around" -> { val s = free / n; x = s / 2; between = gapPx + s }
                "evenly" -> { val s = free / (n + 1); x = s; between = gapPx + s }
            }
            placed.forEach { p ->
                p.place(x, when (vAlign) {
                    Alignment.CenterVertically -> (rowH - p.height) / 2
                    Alignment.Bottom -> rowH - p.height
                    else -> 0
                })
                x += p.width + between
            }
        }
    }
}

@Composable
fun WidgetChildren(node: WidgetNode, form: WidgetFormState, press: (String) -> Unit, ctx: Ctx) {
    node.children.forEach { child -> WidgetNodeView(child, form, press, ctx) }
}

/** 根节点 children：Card 内边距 18/16、ListView 行列表（limit + 显示全部 + 选择态）。 */
@Composable
fun WidgetBody(root: WidgetNode, form: WidgetFormState, press: (String) -> Unit, headed: Boolean) {
    val listName = if (root.type == "ListView") root.str("name") else null
    var showAll by remember { mutableStateOf(false) }
    val limit = (widgetNumber(root, "limit") ?: 0.0).toInt()
    val rows = root.children
    val shown = if (limit > 0 && !showAll) rows.take(limit) else rows
    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp)) {
        shown.forEach { row ->
            WidgetNodeView(row, form, press, Ctx("col", listName = listName, card = true))
        }
        if (limit > 0 && !showAll && rows.size > limit) {
            Text(
                "显示全部（${rows.size}）",
                fontSize = 12.5.sp,
                color = minisSecondary,
                modifier = Modifier.clickable { showAll = true }.padding(8.dp),
            )
        }
    }
}

/** Card 头部：status 行 + title + caption + meta 丸。 */
@Composable
fun WidgetHead(root: WidgetNode) {
    val title = widgetString(root, "title")
    val caption = widgetString(root, "caption")
    val meta = widgetString(root, "meta")
    val status = (root["status"] as? kotlinx.serialization.json.JsonObject)
    val statusText = (status?.get("text") as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
    val statusIcon = (status?.get("icon") as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
    if (title == null && caption == null && meta == null && statusText == null) return
    Row(Modifier.fillMaxWidth().padding(start = 18.dp, top = 14.dp, end = 18.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            if (statusText != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (statusIcon != null) {
                        Box(Modifier.size(24.dp).background(minisSoftCard, CircleShape), contentAlignment = Alignment.Center) {
                            WidgetGlyph(statusIcon, 13, minisSecondary)
                        }
                    }
                    Text(statusText, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = minisAccent, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (title != null || caption != null) Spacer(Modifier.height(4.dp))
            }
            title?.let { Text(it, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = minisInk, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            caption?.let { Text(it, fontSize = 13.sp, color = minisSecondary, modifier = Modifier.padding(top = 2.dp)) }
        }
        meta?.let {
            Text(it, fontSize = 11.sp, fontWeight = FontWeight.Medium, color = minisSecondary,
                modifier = Modifier.background(minisSoftCard, CircleShape).padding(horizontal = 8.dp, vertical = 2.dp))
        }
    }
    HorizontalDivider(color = minisSeparator.copy(alpha = 0.4f), thickness = 0.5.dp)
}

/** 卡底 confirm/cancel 行。 */
@Composable
fun WidgetFooter(form: WidgetFormState, press: (String) -> Unit) {
    val confirm = form.actions["confirm"]
    val cancel = form.actions["cancel"]
    if (confirm == null && cancel == null) return
    HorizontalDivider(color = minisSeparator.copy(alpha = 0.4f), thickness = 0.5.dp)
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
        val stub = remember {
            WidgetNode(kotlinx.serialization.json.buildJsonObject {
                put("type", "Button")
                put("id", "footer")
            })
        }
        cancel?.let { WidgetButtonView(stub, "cancel", it.label, "outline", form, press) }
        confirm?.let { WidgetButtonView(stub, "confirm", it.label, "primary", form, press) }
    }
}

@Composable
private fun Modifier.museLiteCard(): Modifier = this
    .clip(RoundedCornerShape(16.dp))
    .background(minisRaised)
    .border(0.6.dp, minisPaperBorder, RoundedCornerShape(16.dp))
