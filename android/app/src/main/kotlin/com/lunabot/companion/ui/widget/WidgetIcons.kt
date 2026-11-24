package com.lunabot.companion.ui.widget

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Warning
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.lunabot.companion.R
import com.lunabot.companion.ui.minisInk

/**
 * `WIDGET_ICON_NAMES`（shared/widget.ts 66 个名字）的映射：app 只有 material
 * core 图标与本包 ic_* 线稿可用，优先同名 drawable，其次最近语义 core 图标，
 * 其余落成圆点（与桌面未知名字的 dot 一致）。
 */
private val VECTOR_ICONS: Map<String, ImageVector> = mapOf(
    "info" to Icons.Filled.Info,
    "check" to Icons.Filled.Check,
    "check-circle" to Icons.Filled.CheckCircle,
    "check-circle-filled" to Icons.Filled.CheckCircle,
    "chevron-left" to Icons.AutoMirrored.Filled.KeyboardArrowLeft,
    "chevron-right" to Icons.AutoMirrored.Filled.KeyboardArrowRight,
    "close" to Icons.Filled.Close,
    "warning" to Icons.Filled.Warning,
    "plus" to Icons.Filled.Add,
    "user" to Icons.Filled.Person,
    "profile" to Icons.Filled.Person,
    "profile-card" to Icons.Filled.Person,
    "name" to Icons.Filled.Person,
    "agent" to Icons.Filled.Person,
    "play" to Icons.Filled.PlayArrow,
    "reload" to Icons.Filled.Refresh,
    "star" to Icons.Filled.Star,
    "star-filled" to Icons.Filled.Star,
    "confetti" to Icons.Filled.Star,
    "wreath" to Icons.Filled.Star,
    "bell" to Icons.Filled.Notifications,
    "lock" to Icons.Filled.Lock,
    "keys" to Icons.Filled.Lock,
    "dots-vertical" to Icons.Filled.MoreVert,
    "settings-slider" to Icons.Filled.Settings,
    "write" to Icons.Filled.Edit,
    "write-alt" to Icons.Filled.Edit,
    "write-alt2" to Icons.Filled.Edit,
    "chevron-down" to Icons.Filled.KeyboardArrowDown,
    "chevron-up" to Icons.Filled.KeyboardArrowUp,
)

private val DRAWABLE_ICONS: Map<String, Int> = mapOf(
    "calendar" to R.drawable.ic_schedule,
    "clock" to R.drawable.ic_schedule,
    "book-clock" to R.drawable.ic_schedule,
    "phone" to R.drawable.ic_call_line,
    "mobile" to R.drawable.ic_call_line,
    "desktop" to R.drawable.ic_display,
    "search" to R.drawable.ic_search_line,
    "compass" to R.drawable.ic_search_line,
    "document" to R.drawable.ic_list_line,
    "notebook" to R.drawable.ic_list_line,
    "notebook-pencil" to R.drawable.ic_edit_line,
    "file" to R.drawable.ic_attach_file,
    "images" to R.drawable.ic_photo,
    "square-image" to R.drawable.ic_photo,
    "external-link" to R.drawable.ic_open_in_new_line,
    "arrow-right" to R.drawable.ic_send_up,
    "download" to R.drawable.ic_send_up,
    "upload" to R.drawable.ic_share_line,
    "share" to R.drawable.ic_share_line,
    "pull-request" to R.drawable.ic_share_line,
    "sparkle" to R.drawable.ic_sparkles,
    "sparkle-double" to R.drawable.ic_sparkles,
    "lab" to R.drawable.ic_sparkles,
    "lightbulb" to R.drawable.ic_sparkles,
    "send" to R.drawable.ic_send_up,
    "dots-horizontal" to R.drawable.ic_more,
    "batch" to R.drawable.ic_grid,
    "cube" to R.drawable.ic_grid,
    "folder" to R.drawable.ic_grid,
    "globe" to R.drawable.ic_cloud,
    "maps" to R.drawable.ic_hub,
    "map-pin" to R.drawable.ic_hub,
    "book-open" to R.drawable.ic_list_line,
    "book-closed" to R.drawable.ic_list_line,
    "analytics" to R.drawable.ic_waveform,
    "chart" to R.drawable.ic_waveform,
    "atom" to R.drawable.ic_hub,
    "mail" to R.drawable.ic_send_up,
    "suitcase" to R.drawable.ic_display_line,
    "lifesaver" to R.drawable.ic_shield_line,
    "empty-circle" to R.drawable.ic_pause_circle,
    "circle-question" to R.drawable.ic_pause_circle,
    "page-blank" to R.drawable.ic_list_line,
    "square-code" to R.drawable.ic_display_line,
    "square-text" to R.drawable.ic_list_line,
    "link" to R.drawable.ic_open_in_new_line,
    "bug" to R.drawable.ic_pan_tool,
)

@Composable
fun WidgetGlyph(name: String, size: Int, tint: Color = minisInk) {
    val vector = VECTOR_ICONS[name]
    val drawable = DRAWABLE_ICONS[name]
    when {
        vector != null -> Icon(imageVector = vector, contentDescription = null, tint = tint, modifier = Modifier.size(size.dp))
        drawable != null -> Icon(painter = painterResource(drawable), contentDescription = null, tint = tint, modifier = Modifier.size(size.dp))
        else -> Box(Modifier.size((size / 3).coerceAtLeast(4).dp).background(tint, CircleShape))
    }
}
