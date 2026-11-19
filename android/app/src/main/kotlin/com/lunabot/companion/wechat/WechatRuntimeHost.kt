// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.lunabot.companion.wechat

import android.content.Context
import com.lunabot.companion.OpenMausApp
import com.lunabot.companion.core.PhoneSmsEvent
import com.lunabot.companion.core.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The one runtime for the process.
 *
 * Held here rather than on `OpenMausApp` so the whole WeChat channel stays in
 * one package: the service, the settings section and the job runner all ask
 * for the same instance, and a second one could not exist to disagree about
 * the binding. Construction is lazy, on first use — a phone that never binds
 * WeChat pays nothing.
 */
internal object WechatRuntimeHost {

    @Volatile
    private var runtime: WechatRuntime? = null

    /** The process-wide runtime, built on first use. */
    fun of(context: Context): WechatRuntime {
        runtime?.let { return it }
        return synchronized(this) {
            runtime ?: build(context.applicationContext).also { runtime = it }
        }
    }

    /** True when a token exists and the switch is on, i.e. listening is wanted. */
    fun shouldListen(context: Context): Boolean {
        val runtime = of(context)
        return runtime.store.account() != null && runtime.store.enabled() && !runtime.store.needsRebind()
    }

    /**
     * Bring the channel up if the person left it on. The service's own
     * START_STICKY covers a process kill; this covers a fresh process (an
     * update, or the app reopened) where the service was never started.
     */
    fun startIfEnabled(context: Context) {
        if (!shouldListen(context)) return
        WechatService.start(context)
    }

    private fun build(context: Context): WechatRuntime {
        val store = WechatStore(context)
        val versionName = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull().orEmpty()
        val api = WechatApi.default(versionName)
        val sink = object : WechatEventSink {
            override suspend fun post(event: PhoneSmsEvent): Boolean {
                val app = context as? OpenMausApp ?: return false
                app.session.connect()
                // The SMS relay uses the same window: a phone that is paired but
                // asleep gets one chance to come up before the message stays in
                // the journal for the next poll.
                withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
                    app.session.status.first { it is Session.Status.Live }
                } ?: return false
                return app.session.postPhoneEvent(event)
            }
        }
        val images = WechatImageFiles(WechatImageFiles.root(context), api::downloadImage)
        // A crash mid-download leaves staging directories nothing can use.
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            runCatching { images.pruneStaging() }
        }
        return WechatRuntime(
            store = store,
            transport = api,
            images = images,
            sink = sink,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
        )
    }

    private const val CONNECT_TIMEOUT_MS = 10_000L
}
