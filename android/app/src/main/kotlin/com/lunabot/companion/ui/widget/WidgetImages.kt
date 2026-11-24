package com.lunabot.companion.ui.widget

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.WidgetNode
import com.lunabot.companion.core.widgetString
import com.lunabot.companion.ui.decodeAttachmentImage
import com.lunabot.companion.ui.minisInk
import com.lunabot.companion.ui.minisSecondary
import com.lunabot.companion.ui.minisSoftCard
import com.lunabot.companion.ui.minisTertiary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * widget Image 节点：只允许 https src，且默认不拉取——先画「加载图片」占位，
 * 点一下才联网（与桌面 imagesAllowed 隐私门一致）。
 */
private val imageClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(15, TimeUnit.SECONDS)
    .build()

private val imageCache = androidx.collection.LruCache<String, ImageBitmap>(32)

private suspend fun fetchImage(url: String): ImageBitmap? = withContext(Dispatchers.IO) {
    imageCache[url]?.let { return@withContext it }
    val body = runCatching {
        imageClient.newCall(Request.Builder().url(url).build()).execute().use { response ->
            if (!response.isSuccessful) null else response.body?.bytes()
        }
    }.getOrNull() ?: return@withContext null
    decodeAttachmentImage(body, 1200)?.also { imageCache.put(url, it) }
}

@Composable
fun WidgetRemoteImage(node: WidgetNode, form: WidgetFormState) {
    val src = widgetString(node, "src") ?: return
    if (!src.startsWith("https://", ignoreCase = true)) return
    if (!form.imagesAllowed) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(minisSoftCard)
                .clickable { form.onAllowImages() }
                .padding(14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text("加载图片", fontSize = 13.sp, color = minisInk)
            Text("出于隐私考虑，已隐藏外部图片", fontSize = 11.sp, color = minisTertiary)
        }
        return
    }
    val bitmap by produceState<ImageBitmap?>(null, src) { value = fetchImage(src) }
    val alt = widgetString(node, "alt")
    val fit = when (widgetString(node, "fit")) {
        "fill" -> ContentScale.FillBounds
        "contain", "scale-down" -> ContentScale.Fit
        "none" -> ContentScale.None
        else -> ContentScale.Crop
    }
    val position = when (widgetString(node, "position")) {
        "top", "top left", "top right" -> Alignment.TopCenter
        "bottom", "bottom left", "bottom right" -> Alignment.BottomCenter
        "left" -> Alignment.CenterStart
        "right" -> Alignment.CenterEnd
        else -> Alignment.Center
    }
    var modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp, max = 320.dp)
    if (!node.bool("flush")) modifier = modifier.clip(RoundedCornerShape((node.num("radius") ?: 12.0).dp))
    if (bitmap != null) {
        Image(
            bitmap = bitmap!!,
            contentDescription = alt,
            contentScale = fit,
            alignment = position,
            modifier = modifier,
        )
    } else {
        Box(modifier.background(minisSoftCard), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Info, contentDescription = alt, tint = minisSecondary, modifier = Modifier.size(20.dp))
        }
    }
}
