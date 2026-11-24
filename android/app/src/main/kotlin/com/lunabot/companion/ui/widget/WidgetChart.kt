package com.lunabot.companion.ui.widget

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.WidgetNode
import com.lunabot.companion.core.widgetNumber
import com.lunabot.companion.ui.minisSecondary
import com.lunabot.companion.ui.minisSeparator
import com.lunabot.companion.ui.minisTertiary
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * `shared/widget-chart.ts` 的 Canvas 移植：bar（按 stack 分组堆叠、正负分堆）/
 * line/area，4 格网格、可选 y 轴、x 标签疏排、底部图例。
 */
private class ChartSeries(val type: String, val dataKey: String, val label: String, val stack: String?)

private class ChartModel(
    val rows: List<Map<String, Double?>>,
    val xs: List<String>,
    val series: List<ChartSeries>,
    val min: Double,
    val max: Double,
)

private val PALETTE = listOf(
    Color(0xFF2F6FE4), Color(0xFFE4572E), Color(0xFF17A97B), Color(0xFFF2A93B),
    Color(0xFF8B5CF6), Color(0xFF14B8D4), Color(0xFFE2529A), Color(0xFF7A869A),
)

private fun readChart(node: WidgetNode): ChartModel? {
    val data = (node["data"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return null
    val series = (node["series"] as? JsonArray)?.mapNotNull { item ->
        (item as? JsonObject)?.let {
            ChartSeries(
                it["type"].asStr() ?: "bar",
                it["dataKey"].asStr() ?: return@let null,
                it["label"].asStr() ?: it["dataKey"].asStr()!!,
                it["stack"].asStr(),
            )
        }
    }?.takeIf { it.isNotEmpty() } ?: return null
    val xKey = (node["xAxis"] as? JsonObject)?.get("dataKey").asStr()
        ?: (node["xAxis"] as? JsonPrimitive)?.contentOrNull
        ?: series.first().dataKey
    val rows = data.map { row -> row.mapValues { (_, v) -> (v as? JsonPrimitive)?.doubleOrNull } }
    val xs = data.map { row -> (row[xKey] as? JsonPrimitive)?.contentOrNull ?: "" }
    val values = rows.flatMap { row -> series.map { s -> row[s.dataKey] } }.filterNotNull()
    var min = values.minOrNull() ?: 0.0
    var max = values.maxOrNull() ?: 0.0
    // 堆叠的柱组按堆求极值
    for (row in rows) {
        val positives = series.filter { it.type == "bar" }.groupBy { it.stack ?: it.dataKey }
            .mapValues { (_, ss) -> ss.sumOf { s -> (row[s.dataKey] ?: 0.0).coerceAtLeast(0.0) } }
        val negatives = series.filter { it.type == "bar" }.groupBy { it.stack ?: it.dataKey }
            .mapValues { (_, ss) -> ss.sumOf { s -> (row[s.dataKey] ?: 0.0).coerceAtMost(0.0) } }
        positives.values.maxOrNull()?.let { max = maxOf(max, it) }
        negatives.values.minOrNull()?.let { min = minOf(min, it) }
    }
    if (max - min < 1e-9) max = min + 1.0
    return ChartModel(rows, xs, series, min.coerceAtMost(0.0), max.coerceAtLeast(0.0))
}

private fun kotlinx.serialization.json.JsonElement?.asStr(): String? =
    (this as? JsonPrimitive)?.contentOrNull

private fun compact(value: Double): String = when {
    kotlin.math.abs(value) >= 1e9 -> "%.1fG".format(value / 1e9)
    kotlin.math.abs(value) >= 1e6 -> "%.1fM".format(value / 1e6)
    kotlin.math.abs(value) >= 1e3 -> "%.1fK".format(value / 1e3)
    value == value.toLong().toDouble() -> value.toLong().toString()
    else -> "%.1f".format(value)
}

@Composable
fun WidgetChartView(node: WidgetNode) {
    val model = readChart(node) ?: return
    val height = (widgetNumber(node, "height") ?: 160.0).toInt().coerceIn(80, 400)
    val showYAxis = node.bool("showYAxis")
    val showLegend = node["showLegend"]?.let { (it as? JsonPrimitive)?.contentOrNull != "false" } != false
    val showGrid = node["showGrid"]?.let { (it as? JsonPrimitive)?.contentOrNull != "false" } != false
    val gridColor = minisSeparator
    val axisColor = minisTertiary
    val labelPaint = remember(axisColor) {
        android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = axisColor.toArgb()
        }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Canvas(Modifier.fillMaxWidth().height(height.dp)) {
            val axisPad = if (showYAxis) 34.dp.toPx() else 4.dp.toPx()
            val bottomPad = 20.dp.toPx()
            val topPad = 6.dp.toPx()
            val w = size.width - axisPad
            val h = size.height - bottomPad - topPad
            val n = model.xs.size
            if (n == 0 || w <= 0 || h <= 0) return@Canvas
            val yOf = { v: Double -> topPad + h * (1 - ((v - model.min) / (model.max - model.min))).toFloat() }
            if (showGrid) {
                for (i in 0..4) {
                    val v = model.min + (model.max - model.min) * i / 4
                    val y = yOf(v)
                    drawLine(gridColor, Offset(axisPad, y), Offset(axisPad + w, y), strokeWidth = 0.5.dp.toPx())
                    if (showYAxis) {
                        labelPaint.textSize = 10.dp.toPx()
                        drawContext.canvas.nativeCanvas.drawText(compact(v), 2f, y + 4.dp.toPx(), labelPaint)
                    }
                }
            }
            val zeroY = yOf(0.0)
            drawLine(axisColor, Offset(axisPad, zeroY), Offset(axisPad + w, zeroY), strokeWidth = 1.dp.toPx())
            // bar 槽位：同 stack 同槽，无 stack 独占一槽
            val barStacks = model.series.filter { it.type == "bar" }.map { it.stack ?: it.dataKey }.distinct()
            val slotCount = barStacks.size.coerceAtLeast(1)
            val groupW = w / n
            val slotW = (groupW * 0.7f) / slotCount
            model.series.forEachIndexed { index, s ->
                val color = PALETTE[index % PALETTE.size]
                when (s.type) {
                    "bar" -> {
                        val slot = barStacks.indexOf(s.stack ?: s.dataKey)
                        model.rows.forEachIndexed { i, row ->
                            val v = row[s.dataKey] ?: return@forEachIndexed
                            val x = axisPad + i * groupW + (groupW - slotW * slotCount) / 2 + slot * slotW
                            val y = yOf(v)
                            val top = minOf(y, zeroY)
                            val heightPx = kotlin.math.abs(y - zeroY).coerceAtLeast(0.5f)
                            drawRect(color, topLeft = Offset(x + 1f, top), size = androidx.compose.ui.geometry.Size(slotW - 2f, heightPx))
                        }
                    }
                    "line", "area" -> {
                        val path = Path()
                        val area = Path()
                        var started = false
                        model.rows.forEachIndexed { i, row ->
                            val v = row[s.dataKey]
                            val x = axisPad + i * groupW + groupW / 2
                            if (v == null) { started = false; return@forEachIndexed }
                            val y = yOf(v)
                            if (!started) {
                                path.moveTo(x, y)
                                area.moveTo(x, zeroY); area.lineTo(x, y)
                                started = true
                            } else {
                                path.lineTo(x, y)
                                area.lineTo(x, y)
                            }
                            if (model.rows.size <= 40) {
                                drawCircle(color, radius = if (model.rows.size > 16) 1.5.dp.toPx() else 2.5.dp.toPx(), center = Offset(x, y))
                            }
                        }
                        drawPath(path, color, style = Stroke(width = 2.dp.toPx()))
                        if (s.type == "area") {
                            var lastX = 0f
                            model.rows.forEachIndexed { i, _ -> lastX = axisPad + i * groupW + groupW / 2 }
                            area.lineTo(lastX, zeroY); area.close()
                            drawPath(area, color.copy(alpha = 0.15f))
                        }
                    }
                }
            }
            // x 标签：疏排
            val stride = ((n * 46.dp.toPx() / w).toInt() + 1).coerceAtLeast(1)
            model.xs.forEachIndexed { i, label ->
                if (i % stride != 0) return@forEachIndexed
                val x = axisPad + i * groupW + groupW / 2
                labelPaint.textSize = 10.dp.toPx()
                drawContext.canvas.nativeCanvas.drawText(
                    label.take(8),
                    (x - 14.dp.toPx()).coerceIn(axisPad, axisPad + w - 28.dp.toPx()),
                    topPad + h + 16.dp.toPx(),
                    labelPaint,
                )
            }
        }
        if (showLegend && model.series.size > 1) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                model.series.forEachIndexed { index, s ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Box(Modifier.size(8.dp).background(PALETTE[index % PALETTE.size], CircleShape))
                        Text(s.label, fontSize = 11.sp, color = minisSecondary)
                    }
                }
            }
        }
    }
}
