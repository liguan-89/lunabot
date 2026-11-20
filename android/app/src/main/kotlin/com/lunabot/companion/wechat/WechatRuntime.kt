// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.lunabot.companion.wechat

import android.util.Log
import com.lunabot.companion.core.PhoneEventImage
import com.lunabot.companion.core.PhoneSmsEvent
import java.io.IOException
import java.util.Base64
import kotlin.math.min
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** What the settings screen shows. */
internal sealed interface WechatConnectionState {
    /** No binding and no intent to listen. */
    data object Off : WechatConnectionState

    /** No token at all, or a token iLink rejected: the person must scan again. */
    data object NeedsBinding : WechatConnectionState
    data object Connecting : WechatConnectionState
    data object Connected : WechatConnectionState
    data class Failed(val message: String) : WechatConnectionState
}

/** The wire calls the runtime needs, split out so a test can stand in for iLink. */
internal interface WechatTransport {
    fun startLogin(): WechatQrStart
    fun pollLogin(qrcode: String): WechatQrStatus
    suspend fun updates(account: WechatAccount, cursor: String): WechatUpdates
    suspend fun sendText(account: WechatAccount, peerId: String, clientId: String, text: String, contextToken: String?)
    suspend fun downloadImage(image: WechatImage): WechatDownloadedImage
    suspend fun uploadImage(account: WechatAccount, peerId: String, bytes: ByteArray): WechatUploadedImage
    suspend fun sendImage(
        account: WechatAccount,
        peerId: String,
        clientId: String,
        uploaded: WechatUploadedImage,
        contextToken: String?,
    )
}

/** Where a decoded inbound event goes. The app implements this over `Session`. */
internal interface WechatEventSink {
    suspend fun post(event: PhoneSmsEvent): Boolean
}

/**
 * The WeChat channel's phone half: one long poll, one event per accepted
 * message, one reply path for `PHONE_REPLY_WECHAT`.
 *
 * The turn still runs on the computer. This class only moves bytes: iLink in,
 * `POST /api/phones/self/events` out, and the job's answer back over iLink.
 *
 * Policy is Mika's, verbatim:
 *
 * - accept only a **private** user message (type 1, with an id and a sender,
 *   and no group id) — a group message is dropped before it becomes an event;
 * - from the **bound owner** only — any other DM is dropped;
 * - dedupe by iLink message id, with the cursor and the accepted ids persisted
 *   so a restart resumes rather than replays;
 * - on any failure back off 1 s, 2 s, 4 s … capped at 30 s;
 * - on 401/403 stop and mark the binding dead.
 *
 * There is deliberately **no outbound rate limit**: Mika has none, and
 * Tencent's throttling is not this app's to model. The only guards are the
 * failure backoff above and dedupe by client id, both Mika's.
 */
internal class WechatRuntime(
    internal val store: WechatStore,
    private val transport: WechatTransport,
    private val images: WechatImageFiles?,
    private val sink: WechatEventSink,
    private val scope: CoroutineScope,
    /** Test seam: where the backoff wait goes. */
    private val pause: suspend (Long) -> Unit = { delay(it) },
) {
    /**
     * Starts at [WechatConnectionState.Off] without touching the store: reading
     * the binding is Keystore IPC, and this object is built from a composable's
     * `remember` on the main thread. [refresh] moves it to the truth, and
     * [sync] does that as part of starting.
     */
    private val _state = MutableStateFlow<WechatConnectionState>(WechatConnectionState.Off)
    val state: StateFlow<WechatConnectionState> = _state.asStateFlow()

    private var monitor: Job? = null
    private val pollLock = Mutex()

    /**
     * Read the binding and settle the idle state: bound-and-listening is
     * [WechatConnectionState.Connecting] until the first poll answers, a
     * missing or rejected token is [WechatConnectionState.NeedsBinding], and a
     * paused channel is [WechatConnectionState.Off]. Call from IO.
     */
    fun refresh() {
        _state.value = when {
            store.account() == null || store.needsRebind() -> WechatConnectionState.NeedsBinding
            !store.enabled() -> WechatConnectionState.Off
            monitor?.isActive == true -> _state.value
            else -> WechatConnectionState.Connecting
        }
    }

    /** Start listening if a binding exists and the switch is on. */
    @Synchronized
    fun sync(): Boolean {
        val account = store.account()
        if (account == null || store.needsRebind()) {
            _state.value = WechatConnectionState.NeedsBinding
            return false
        }
        if (!store.enabled()) {
            _state.value = WechatConnectionState.Off
            return false
        }
        if (monitor?.isActive != true) {
            _state.value = WechatConnectionState.Connecting
            monitor = scope.launch { monitorLoop(account) }
        }
        return true
    }

    @Synchronized
    fun stop() {
        monitor?.cancel()
        monitor = null
        _state.value = when {
            store.account() == null || store.needsRebind() -> WechatConnectionState.NeedsBinding
            else -> WechatConnectionState.Off
        }
    }

    /** Turn listening on or off. Disabling keeps the token: rebinding is not needed to stop. */
    fun setEnabled(enabled: Boolean) {
        store.setEnabled(enabled)
        if (enabled) sync() else stop()
    }

    /** Start a bind. The caller polls [awaitLogin] with the returned key. */
    suspend fun startLogin(): WechatQrStart = withContext(Dispatchers.IO) { transport.startLogin() }

    /**
     * Poll until the scan is confirmed, then persist the binding and start
     * listening. Returns null when the QR expired or the caller cancelled.
     */
    suspend fun awaitLogin(qrcode: String): WechatAccount? {
        require(qrcode.isNotBlank()) { "Missing QR code key" }
        while (currentCoroutineContext().isActive) {
            val status = withContext(Dispatchers.IO) { transport.pollLogin(qrcode) }
            status.account()?.let { account ->
                store.saveAccount(account)
                store.setNeedsRebind(false)
                store.setEnabled(true)
                restartMonitor()
                return account
            }
            if (status.status == "expired") return null
            if (status.status == "confirmed") throw IllegalStateException("Incomplete confirmed login response")
            // "wait" and any status this build does not know: poll again in a
            // second. Mika does the same and treats unknown as "not yet".
            pause(1_000)
        }
        return null
    }

    /** Forget the binding: the token, cursor and journal all go. */
    fun unbind() {
        stop()
        store.clear()
        _state.value = WechatConnectionState.NeedsBinding
    }

    @Synchronized
    private fun restartMonitor() {
        monitor?.cancel()
        monitor = null
        sync()
    }

    /**
     * The loop. Internal rather than private so a test can run exactly one
     * iteration against a transport that fails on demand, without timers.
     */
    internal suspend fun monitorLoop(account: WechatAccount) {
        var failures = 0
        while (currentCoroutineContext().isActive && store.enabled() && store.account() == account) {
            try {
                pollOnce(account)
                failures = 0
                _state.value = WechatConnectionState.Connected
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: WechatHttpException) {
                if (error.httpCode == 401 || error.httpCode == 403) {
                    // The token is dead. Keep it out of the state and out of the
                    // log; the person has to scan again.
                    store.setEnabled(false)
                    store.setNeedsRebind(true)
                    _state.value = WechatConnectionState.NeedsBinding
                    Log.i(TAG, "wechat binding rejected (${error.httpCode}); rebind required")
                    return
                }
                failures++
                _state.value = WechatConnectionState.Failed("HTTP ${error.httpCode}")
                pause(backoffMillis(failures))
            } catch (error: Exception) {
                failures++
                // Only the exception's class: a JSON decode error's message can
                // quote the response body, and a status response carries the
                // bot token. Nothing here may put that in logcat or on screen.
                _state.value = WechatConnectionState.Failed(error::class.simpleName ?: "错误")
                Log.w(TAG, "wechat poll failed: ${error::class.simpleName}")
                pause(backoffMillis(failures))
            }
        }
    }

    /**
     * One poll: replay anything the journal still holds, then fetch new
     * messages. Serialised so a replay and a fetch cannot interleave.
     *
     * Internal rather than private so the tests can drive exactly one poll with
     * no timers and no network.
     */
    internal suspend fun pollOnce(account: WechatAccount) = pollLock.withLock {
        if (store.account() != account || !store.enabled()) return@withLock
        for (pending in store.pending()) {
            if (store.account() != account || !store.enabled()) return@withLock
            dispatch(pending)
        }
        val updates = transport.updates(account, store.cursor())
        // A rebind or stop that happened while the poll was in flight must not
        // write its result into the new conversation.
        if (store.account() != account || !store.enabled()) return@withLock
        for (message in updates.msgs) {
            if (store.account() != account || !store.enabled()) return@withLock
            // Mika's double rule, then the owner rule. Both drop before any
            // download, so a stranger's picture is never fetched.
            if (!message.isUserPrivateMessage()) continue
            if (message.fromUserId != account.ownerId) continue
            val sendId = message.messageId ?: continue
            if (store.hasMessage(sendId)) continue

            val text = message.text()
            val imageItems = message.images()
            if (text.isBlank() && imageItems.isEmpty()) continue

            store.rememberContextToken(message.contextToken, account)

            val stored = if (imageItems.isEmpty()) {
                emptyList()
            } else {
                val files = images
                if (files == null) {
                    // No image store configured: the message is dropped rather
                    // than forwarded with its pictures silently missing.
                    Log.w(TAG, "wechat image received with no store; message skipped")
                    continue
                }
                try {
                    files.receive(sendId, imageItems)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Exception) {
                    Log.w(TAG, "wechat image batch failed: ${error::class.simpleName}")
                    continue
                }
            }

            val pending = PendingWechatEvent(
                sendId = sendId,
                from = message.fromUserId,
                text = text,
                images = stored.map { PendingWechatImage(it.name, it.mime) },
            )
            if (store.journal(pending)) dispatch(pending)
        }
        if (updates.cursor.isNotEmpty()) store.saveCursor(updates.cursor, account)
    }

    private suspend fun dispatch(pending: PendingWechatEvent) {
        val files = images
        val eventImages = ArrayList<PhoneEventImage>(pending.images.size)
        for (image in pending.images) {
            // A journal entry names files that must still exist. If one is gone
            // (the process died between the journal write and the copy landing,
            // or the directory was cleared) the message is dropped whole rather
            // than posted with a silently missing picture — and acknowledged, so
            // a broken entry cannot spin the poll forever.
            val bytes = files?.let { runCatching { it.file(pending.sendId, image.name).readBytes() }.getOrNull() }
            if (bytes == null) {
                Log.w(TAG, "wechat journal entry lost its images; dropping it")
                store.acknowledge(pending.sendId)
                files?.release(pending.sendId)
                return
            }
            eventImages += PhoneEventImage(
                mime = image.mime,
                name = image.name,
                data = Base64.getEncoder().encodeToString(bytes),
            )
        }
        val event = PhoneSmsEvent(
            kind = "wechat",
            sendId = pending.sendId,
            from = pending.from,
            text = pending.text,
            images = eventImages,
        )
        val posted = runCatching { sink.post(event) }.getOrDefault(false)
        Log.i(TAG, "wechat event images=${eventImages.size} posted=$posted")
        if (posted) {
            store.acknowledge(pending.sendId)
            files?.release(pending.sendId)
        }
    }

    /**
     * Answer a `PHONE_REPLY_WECHAT` job.
     *
     * The argument shape is frozen at `{ to, text }`; the job id is the stable
     * client id, so a job the computer retries cannot double-send.
     */
    suspend fun reply(clientId: String, to: String, text: String): WechatReplyResult {
        val account = store.account()
            ?: return WechatReplyResult.Failure("not_bound", "微信尚未绑定。")
        if (store.needsRebind()) return WechatReplyResult.Failure("not_bound", "微信绑定已失效，请重新扫码。")
        if (to.isBlank() || text.isBlank()) return WechatReplyResult.Failure("invalid", "缺少收件人或内容。")
        // Mika's runtime only ever answers the bound owner; the server pins
        // `to` to the sender, and this is the second check.
        if (to != account.ownerId) return WechatReplyResult.Failure("not_owner", "只能回复绑定的微信账号。")
        return try {
            transport.sendText(account, to, clientId, text, store.contextToken())
            WechatReplyResult.Success
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: WechatHttpException) {
            if (error.httpCode == 401 || error.httpCode == 403) {
                store.setEnabled(false)
                store.setNeedsRebind(true)
                _state.value = WechatConnectionState.NeedsBinding
            }
            WechatReplyResult.Failure("send_failed", "微信发送失败（HTTP ${error.httpCode}）。")
        } catch (error: WechatApiException) {
            WechatReplyResult.Failure("send_failed", "微信拒绝了这条消息（${error.code}）。")
        } catch (error: IOException) {
            WechatReplyResult.Failure("send_failed", "微信发送失败，请稍后再试。")
        }
    }

    /**
     * Send one image. The frozen reply job shape is `{ to, text }`, so nothing
     * in the server contract reaches this today; it is ported because Mika's
     * image pipeline includes the outbound half, and a later job shape can use
     * it without re-deriving the upload handshake.
     */
    suspend fun replyImage(clientId: String, to: String, bytes: ByteArray): WechatReplyResult {
        val account = store.account()
            ?: return WechatReplyResult.Failure("not_bound", "微信尚未绑定。")
        if (store.needsRebind()) return WechatReplyResult.Failure("not_bound", "微信绑定已失效，请重新扫码。")
        if (to.isBlank()) return WechatReplyResult.Failure("invalid", "缺少收件人。")
        if (to != account.ownerId) return WechatReplyResult.Failure("not_owner", "只能回复绑定的微信账号。")
        return try {
            val uploaded = transport.uploadImage(account, to, bytes)
            transport.sendImage(account, to, clientId, uploaded, store.contextToken())
            WechatReplyResult.Success
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: WechatHttpException) {
            if (error.httpCode == 401 || error.httpCode == 403) {
                store.setEnabled(false)
                store.setNeedsRebind(true)
                _state.value = WechatConnectionState.NeedsBinding
            }
            WechatReplyResult.Failure("send_failed", "微信图片发送失败（HTTP ${error.httpCode}）。")
        } catch (error: Exception) {
            Log.w(TAG, "wechat image send failed: ${error::class.simpleName}")
            WechatReplyResult.Failure("send_failed", "微信图片发送失败。")
        }
    }

    private companion object {
        const val TAG = "WechatRuntime"
    }
}

internal sealed interface WechatReplyResult {
    data object Success : WechatReplyResult
    data class Failure(val code: String, val message: String) : WechatReplyResult
}

/**
 * Mika's backoff, kept exactly: 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s for every
 * further consecutive failure.
 */
internal fun backoffMillis(failures: Int): Long {
    val exponent = (failures - 1).coerceAtLeast(0).coerceAtMost(5)
    return min(30_000L, 1_000L * (1L shl exponent))
}
