package com.lunabot.companion.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.view.Surface
import android.view.TextureView
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.lunabot.companion.core.Session
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext

/**
 * Canonical dynamic avatar states shared across desktop and Android.
 */
internal object DynamicAvatarStates {
    const val IDLE = "idle"
    const val WORKING = "working"
    const val LISTENING = "listening"
    const val TALKING = "talking"
    const val THINKING = "thinking"

    val ALL = listOf(IDLE, WORKING, LISTENING, TALKING, THINKING)
    val CORE_PACK = listOf(IDLE, WORKING, TALKING)

    fun label(state: String): String = when (state) {
        IDLE -> "待机"
        WORKING -> "工作中"
        LISTENING -> "聆听中"
        TALKING -> "说话中"
        THINKING -> "思考中"
        else -> state
    }

    fun fromMausAndMood(
        state: MausState,
        mood: FaceMood,
        override: String? = null,
    ): String {
        if (!override.isNullOrBlank()) return override
        return when {
            mood == FaceMood.SPEAKING -> TALKING
            mood == FaceMood.LISTENING || state == MausState.LISTENING -> LISTENING
            mood == FaceMood.WORKING || state == MausState.WORKING -> WORKING
            mood == FaceMood.THINKING || state == MausState.THINKING -> THINKING
            else -> IDLE
        }
    }
}

/**
 * Style presets for Seedance dynamic avatar generation, matching desktop `AvatarStatesEditor.tsx`.
 */
internal enum class AvatarVideoStyle(val wire: String, val label: String) {
    AUTO("auto", "自动"),
    PHOTOREALISTIC("photorealistic", "写实"),
    STYLIZED_3D("stylized3d", "3D"),
    ANIME("anime", "二次元"),
    CARTOON("cartoon", "卡通"),
}

internal fun isVideoAvatarPath(path: String?): Boolean {
    if (path.isNullOrBlank()) return false
    val clean = path.substringBefore('?').lowercase()
    return clean.endsWith(".mp4") || clean.endsWith(".webm")
}

/**
 * Resolves the best media attachment path for a requested dynamic avatar state,
 * mirroring desktop `resolveAvatarMedia` fallback priority.
 */
internal fun resolveDynamicAvatarMedia(
    avatarStates: Map<String, String>?,
    state: String,
    fallbackUrl: String? = null,
): String? {
    val map = avatarStates?.filterValues { it.isNotBlank() }.orEmpty()
    if (map.isEmpty()) return fallbackUrl?.takeIf { it.isNotBlank() }

    map[state]?.let { return it }
    if (state == DynamicAvatarStates.THINKING) {
        map[DynamicAvatarStates.WORKING]?.let { return it }
    }
    if (state == DynamicAvatarStates.LISTENING) {
        map[DynamicAvatarStates.IDLE]?.let { return it }
    }
    map[DynamicAvatarStates.IDLE]?.let { return it }
    map[DynamicAvatarStates.TALKING]?.let { return it }
    map[DynamicAvatarStates.LISTENING]?.let { return it }
    map[DynamicAvatarStates.WORKING]?.let { return it }
    return map.values.firstOrNull() ?: fallbackUrl?.takeIf { it.isNotBlank() }
}

/**
 * Disk-backed cache for dynamic avatar videos and state images fetched from the paired computer.
 * Uses `context.cacheDir/avatar_states/` with request deduplication so multiple widgets playing
 * the same state share one local file and never re-download across recompositions.
 */
internal object AvatarMediaDiskCache {
    private val inFlight = ConcurrentHashMap<String, Deferred<File?>>()

    private fun cacheFile(context: Context, path: String): File {
        val dir = File(context.cacheDir, "avatar_states").apply { mkdirs() }
        val ext = path.substringBefore('?').substringAfterLast('.', "bin")
            .lowercase()
            .filter { it.isLetterOrDigit() }
            .ifEmpty { "bin" }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(path.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(32)
        return File(dir, "$digest.$ext")
    }

    suspend fun getOrFetchFile(
        context: Context,
        session: Session,
        path: String,
    ): File? {
        val target = cacheFile(context, path)
        if (target.exists() && target.length() > 0L) return target

        return coroutineScope {
            val existing = inFlight[path]
            if (existing != null) return@coroutineScope existing.await()

            val deferred = async(Dispatchers.IO) {
                try {
                    if (target.exists() && target.length() > 0L) return@async target
                    val bytes = session.avatarMedia(path) ?: return@async null
                    if (bytes.isEmpty()) return@async null
                    val tmp = File(target.parentFile, "${target.name}.tmp.${System.nanoTime()}")
                    tmp.writeBytes(bytes)
                    if (!tmp.renameTo(target)) {
                        tmp.copyTo(target, overwrite = true)
                        tmp.delete()
                    }
                    target
                } catch (_: Throwable) {
                    null
                } finally {
                    inFlight.remove(path)
                }
            }
            val raced = inFlight.putIfAbsent(path, deferred)
            if (raced != null) {
                deferred.cancel()
                raced.await()
            } else {
                deferred.await()
            }
        }
    }
}

/**
 * Renders a bot's multi-state dynamic avatar (looping muted `.mp4`/`.webm` video or static image)
 * using Android's native `TextureView + MediaPlayer` with smooth state cross-fading, optional
 * Muse-style breakout working frame, and subtle voice-level scaling during Live Calls.
 */
@Composable
internal fun DynamicAvatarMedia(
    avatarStates: Map<String, String>?,
    state: String,
    size: Dp,
    shape: Shape,
    modifier: Modifier = Modifier,
    fallbackUrl: String? = null,
    breakout: Boolean = false,
    audioLevel: Float = 0f,
    fallbackContent: @Composable () -> Unit,
) {
    val resolvedPath = remember(avatarStates, state, fallbackUrl) {
        resolveDynamicAvatarMedia(avatarStates, state, fallbackUrl)
    }
    if (resolvedPath == null) {
        fallbackContent()
        return
    }

    val session = LocalCompanion.current.session
    val context = LocalContext.current
    val pulseScale by animateFloatAsState(
        targetValue = 1f + (audioLevel.coerceIn(0f, 1f) * 0.045f),
        animationSpec = tween(durationMillis = 120),
        label = "dynamicAvatarVoicePulse",
    )

    val frameShape = if (breakout) RoundedCornerShape((size.value * 0.28f).coerceIn(12f, 24f).dp) else shape
    val containerModifier = modifier
        .size(size)
        .scale(if (breakout) 1.06f * pulseScale else pulseScale)
        .then(
            if (breakout) {
                Modifier
                    .shadow(elevation = 6.dp, shape = frameShape, ambientColor = Color(0x33000000), spotColor = Color(0x38000000))
                    .border(width = 1.5.dp, color = Color(0xCCFFFFFF), shape = frameShape)
            } else {
                Modifier
            },
        )
        .clip(frameShape)

    Box(modifier = containerModifier, contentAlignment = Alignment.Center) {
        Crossfade(
            targetState = resolvedPath,
            animationSpec = tween(durationMillis = 220),
            label = "dynamicAvatarStateCrossfade",
        ) { mediaPath ->
            if (isVideoAvatarPath(mediaPath)) {
                var videoFile by remember(mediaPath) { mutableStateOf<File?>(null) }
                var failed by remember(mediaPath) { mutableStateOf(false) }

                LaunchedEffect(mediaPath) {
                    failed = false
                    val fetched = AvatarMediaDiskCache.getOrFetchFile(context, session, mediaPath)
                    videoFile = fetched
                    if (fetched == null) failed = true
                }

                val file = videoFile
                if (file != null && !failed) {
                    LoopingAvatarVideo(
                        file = file,
                        modifier = Modifier.fillMaxSize(),
                        placeholder = fallbackContent,
                    )
                } else {
                    fallbackContent()
                }
            } else {
                var bitmap by remember(mediaPath) { mutableStateOf<Bitmap?>(null) }
                LaunchedEffect(mediaPath) {
                    bitmap = withContext(Dispatchers.IO) {
                        val file = AvatarMediaDiskCache.getOrFetchFile(context, session, mediaPath)
                            ?: return@withContext null
                        runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull()
                    }
                }
                val loaded = bitmap
                if (loaded != null) {
                    val imageBitmap = remember(loaded) { loaded.asImageBitmap() }
                    Image(
                        bitmap = imageBitmap,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    fallbackContent()
                }
            }
        }
    }
}

/**
 * Lightweight native looping video player backed by `TextureView` + `MediaPlayer`.
 * Applies a center-crop matrix so portrait/square/landscape clips fill any avatar shape cleanly,
 * stays muted, and fades in on the first rendered frame to eliminate black-frame flashes.
 */
@Composable
private fun LoopingAvatarVideo(
    file: File,
    modifier: Modifier = Modifier,
    placeholder: @Composable () -> Unit,
) {
    var ready by remember(file.absolutePath) { mutableStateOf(false) }
    val videoAlpha by animateFloatAsState(
        targetValue = if (ready) 1f else 0f,
        animationSpec = tween(durationMillis = 180),
        label = "avatarVideoReadyAlpha",
    )
    val playerHolder = remember(file.absolutePath) { PlayerHolder() }

    DisposableEffect(file.absolutePath) {
        onDispose {
            playerHolder.release()
        }
    }

    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        if (!ready) {
            placeholder()
        }
        AndroidView(
            factory = { ctx ->
                TextureView(ctx).apply {
                    isOpaque = false
                    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                        override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                            playerHolder.start(this@apply, surface, file, width, height) {
                                ready = true
                            }
                        }

                        override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
                            playerHolder.updateTransform(this@apply, width, height)
                        }

                        override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
                            playerHolder.release()
                            return true
                        }

                        override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
                    }
                }
            },
            update = { view ->
                if (view.isAvailable && playerHolder.currentPath != file.absolutePath) {
                    ready = false
                    playerHolder.start(view, view.surfaceTexture!!, file, view.width, view.height) {
                        ready = true
                    }
                }
            },
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Transparent)
                .alpha(videoAlpha),
        )
    }
}

private class PlayerHolder {
    private var player: MediaPlayer? = null
    private var surface: Surface? = null
    private var videoWidth: Int = 0
    private var videoHeight: Int = 0
    var currentPath: String? = null
        private set

    fun start(
        view: TextureView,
        surfaceTexture: SurfaceTexture,
        file: File,
        viewWidth: Int,
        viewHeight: Int,
        onReady: () -> Unit,
    ) {
        release()
        currentPath = file.absolutePath
        val newSurface = Surface(surfaceTexture)
        surface = newSurface
        val mp = MediaPlayer()
        player = mp
        try {
            mp.setDataSource(file.absolutePath)
            mp.setSurface(newSurface)
            mp.isLooping = true
            mp.setVolume(0f, 0f)
            mp.setOnVideoSizeChangedListener { _, w, h ->
                videoWidth = w
                videoHeight = h
                updateTransform(view, view.width.takeIf { it > 0 } ?: viewWidth, view.height.takeIf { it > 0 } ?: viewHeight)
            }
            mp.setOnPreparedListener { prepared ->
                videoWidth = prepared.videoWidth
                videoHeight = prepared.videoHeight
                updateTransform(view, view.width.takeIf { it > 0 } ?: viewWidth, view.height.takeIf { it > 0 } ?: viewHeight)
                prepared.start()
                view.post { onReady() }
            }
            mp.setOnErrorListener { _, _, _ ->
                release()
                true
            }
            mp.prepareAsync()
        } catch (_: Throwable) {
            release()
        }
    }

    fun updateTransform(view: TextureView, viewWidth: Int, viewHeight: Int) {
        if (viewWidth <= 0 || viewHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return
        val viewRatio = viewWidth.toFloat() / viewHeight.toFloat()
        val videoRatio = videoWidth.toFloat() / videoHeight.toFloat()
        val scaleX: Float
        val scaleY: Float
        if (videoRatio > viewRatio) {
            scaleX = videoRatio / viewRatio
            scaleY = 1f
        } else {
            scaleX = 1f
            scaleY = viewRatio / videoRatio
        }
        val matrix = Matrix()
        matrix.setScale(scaleX, scaleY, viewWidth / 2f, viewHeight / 2f)
        view.setTransform(matrix)
    }

    fun release() {
        currentPath = null
        val mp = player
        player = null
        try {
            mp?.stop()
        } catch (_: Throwable) {
        }
        try {
            mp?.release()
        } catch (_: Throwable) {
        }
        surface?.release()
        surface = null
    }
}
