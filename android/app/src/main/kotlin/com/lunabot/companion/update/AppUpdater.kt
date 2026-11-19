package com.lunabot.companion.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import androidx.core.net.toUri

/** What the release page says the newest build is. */
data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val apkUrl: String,
    /** Lowercase hex; absent on an old manifest, in which case size is all we check. */
    val sha256: String?,
    val notes: String?,
    val sizeBytes: Long?,
) {
    val sizeLabel: String get() = sizeBytes?.let(::formatBytes).orEmpty()
}

/** Everything the Settings row can be showing. */
sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data class UpToDate(val current: String) : UpdateState
    data class Available(val info: UpdateInfo) : UpdateState
    /** [progress] is null when the server did not send a content length. */
    data class Downloading(val info: UpdateInfo, val progress: Float?) : UpdateState
    /**
     * Downloaded and waiting for the system installer. [hint] is set when the
     * installer could not open yet — the package stays here so the person does
     * not download it again after granting the permission.
     */
    data class Ready(
        val info: UpdateInfo,
        val file: File,
        val hint: String? = null,
    ) : UpdateState
    data class Failed(val message: String) : UpdateState
}

/**
 * The release channel: a static page with `update.json` and the APK beside it.
 *
 * The APK is signed with the same key as the installed build, so the system
 * installs it over the existing app without touching pairing or chat data.
 * Android still shows its own install confirmation — a normal app cannot skip
 * that, and this one does not try.
 *
 * Lives in `CompanionEnvironment`, not in the Settings composition: leaving the
 * screen during an 18 MB download must not cancel it.
 */
class AppUpdater(
    context: Context,
    private val manifestUrl: String = MANIFEST_URL,
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    val currentVersionName: String
        get() = runCatching { packageInfo().versionName }.getOrNull() ?: "未知"

    fun check() {
        if (_state.value is UpdateState.Checking || _state.value is UpdateState.Downloading) return
        _state.value = UpdateState.Checking
        scope.launch {
            _state.value = try {
                val info = withContext(Dispatchers.IO) { fetchManifest() }
                if (info.versionCode > currentVersionCode()) {
                    UpdateState.Available(info)
                } else {
                    UpdateState.UpToDate(currentVersionName)
                }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                UpdateState.Failed(error.message ?: "检查更新失败，请稍后重试。")
            }
        }
    }

    /** Download the package offered by [UpdateState.Available]. */
    fun download() {
        val available = _state.value as? UpdateState.Available ?: return
        _state.value = UpdateState.Downloading(available.info, null)
        scope.launch {
            _state.value = try {
                val file = withContext(Dispatchers.IO) { download(available.info) }
                UpdateState.Ready(available.info, file)
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                UpdateState.Failed(error.message ?: "下载更新失败。")
            }
        }
    }

    /** Hand a downloaded package to the system installer. */
    fun install() {
        val ready = _state.value as? UpdateState.Ready ?: return
        when (openInstaller(ready.file)) {
            // The permission hint was true for the previous attempt only.
            InstallResult.OPENED -> _state.value = ready.copy(hint = null)
            // Keep the file and the Ready state: the person grants the switch,
            // comes back, and taps the same button. A Failed state here would
            // send them through the 18 MB download again.
            InstallResult.NEEDS_PERMISSION -> _state.value = ready.copy(
                hint = "请在系统设置中允许此应用安装未知应用，然后回来再点一次“安装”。",
            )
            InstallResult.FAILED -> _state.value = UpdateState.Failed(
                "无法打开系统安装器。请在浏览器中打开发布页手动安装。",
            )
        }
    }

    private suspend fun fetchManifest(): UpdateInfo {
        if (!manifestUrl.startsWith("https://")) {
            throw IOException("更新地址必须使用 HTTPS。")
        }
        val connection = (URL(manifestUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 20_000
            requestMethod = "GET"
            setRequestProperty("Cache-Control", "no-cache")
        }
        return try {
            if (connection.responseCode !in 200..299) {
                throw IOException("更新服务返回 ${connection.responseCode}。")
            }
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val json = JSONObject(body)
            val versionCode = json.getInt("versionCode")
            if (versionCode <= 0) throw IOException("更新清单缺少 versionCode。")
            val apkUrl = URI(manifestUrl).resolve(json.getString("apkUrl")).toString()
            // A manifest served over a hijacked network must not be able to
            // point the download at plain HTTP.
            if (!apkUrl.startsWith("https://")) throw IOException("更新包地址必须使用 HTTPS。")
            UpdateInfo(
                versionCode = versionCode,
                versionName = json.optString("versionName", "新版本"),
                apkUrl = apkUrl,
                sha256 = json.optString("sha256").takeIf(String::isNotBlank),
                notes = json.optString("notes").takeIf(String::isNotBlank),
                sizeBytes = json.optLong("size", 0L).takeIf { it > 0 },
            )
        } finally {
            connection.disconnect()
        }
    }

    private fun download(info: UpdateInfo): File {
        val directory = File(appContext.cacheDir, "updates").apply { mkdirs() }
        // One package at a time; a retry replaces the previous partial file.
        directory.listFiles()?.forEach { it.delete() }
        val target = File(directory, "lunabot-${info.versionCode}.apk")
        val connection = (URL(info.apkUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 60_000
            requestMethod = "GET"
        }
        try {
            if (connection.responseCode !in 200..299) {
                throw IOException("下载更新失败：HTTP ${connection.responseCode}。")
            }
            val total = connection.contentLengthLong
            val digest = MessageDigest.getInstance("SHA-256")
            var copied = 0L
            connection.inputStream.use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        copied += read
                        _state.value = UpdateState.Downloading(
                            info,
                            if (total > 0) (copied.toFloat() / total).coerceIn(0f, 1f) else null,
                        )
                    }
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (info.sha256 != null && !actual.equals(info.sha256, ignoreCase = true)) {
                target.delete()
                throw IOException("更新包校验失败，请重试。")
            }
            if (copied <= 0) {
                target.delete()
                throw IOException("更新包为空，请重试。")
            }
            return target
        } catch (error: Exception) {
            target.delete()
            throw error
        } finally {
            connection.disconnect()
        }
    }

    private fun openInstaller(file: File): InstallResult {
        if (!file.isFile) return InstallResult.FAILED
        // Android 8+ gates sideloading per app. Sending the user to the switch
        // is more useful than an opaque "no activity found" later.
        if (!appContext.packageManager.canRequestPackageInstalls()) {
            val settings = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                "package:${appContext.packageName}".toUri(),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { appContext.startActivity(settings) }
            return InstallResult.NEEDS_PERMISSION
        }
        val uri = FileProvider.getUriForFile(
            appContext,
            "${appContext.packageName}.transcripts",
            file,
        )
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return if (runCatching { appContext.startActivity(intent) }.isSuccess) {
            InstallResult.OPENED
        } else {
            InstallResult.FAILED
        }
    }

    private enum class InstallResult { OPENED, NEEDS_PERMISSION, FAILED }

    @Suppress("DEPRECATION")
    private fun packageInfo() =
        appContext.packageManager.getPackageInfo(appContext.packageName, 0)

    @Suppress("DEPRECATION")
    private fun currentVersionCode(): Int = packageInfo().versionCode

    companion object {
        /**
         * The fixed ZCode Sites address of the release page. It never changes
         * across deploys, so shipped builds keep finding the newest manifest.
         */
        const val MANIFEST_URL = "https://cloud.dexai.vip/update.json"

        /** Where a person can install manually if the in-app flow cannot. */
        const val RELEASE_PAGE = "https://cloud.dexai.vip/download"
    }
}

/** Bytes as the row shows them; no localisation beyond the one decimal. */
fun formatBytes(bytes: Long): String = when {
    bytes >= 1_048_576 -> String.format(java.util.Locale.getDefault(), "%.1f MB", bytes / 1_048_576.0)
    bytes >= 1_024 -> "${bytes / 1_024} KB"
    else -> "$bytes B"
}
