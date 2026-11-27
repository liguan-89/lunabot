package com.lunabot.companion.ui

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.lunabot.companion.core.AppDocument
import com.lunabot.companion.core.AppRpcOutcome
import com.lunabot.companion.core.CompanionJson
import java.io.ByteArrayInputStream
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

interface ChatAppBridgeDelegate {
    suspend fun rpc(method: String, params: JsonObject): AppRpcOutcome
    suspend fun message(text: String)
    suspend fun openLink(url: String)
    suspend fun context(update: JsonObject)
    fun resize(height: Int)
    fun initialized()
    fun hostReady() = Unit
    fun teardownRequested()
    fun failure(text: String)
}

/** One row's WebView host. It owns the only object the page can reach and every reply into it. */
@SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
class ChatAppWebController(
    private val context: Context,
    private val scope: CoroutineScope,
    private val delegate: ChatAppBridgeDelegate,
    private val hostVersion: String,
    private val consoleLog: ((String) -> Unit)? = null,
) {
    private var webView: WebView? = null
    private var replyProxy: JavaScriptReplyProxy? = null
    private var document: AppDocument? = null
    private var initialHeightPx = 160
    private var loadSent = false
    private var ready = false
    private var widthPx = 600
    private var maxHeightPx = 720
    private var dark = false
    private var engagedAt = 0L
    private var tornDown = false

    val supported: Boolean
        get() = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    fun attach(view: WebView) {
        if (webView === view) return
        webView = view
        configure(view)
    }

    fun load(doc: AppDocument, width: Int, maxHeight: Int, darkTheme: Boolean, initialHeight: Int) {
        widthPx = width.coerceAtLeast(1)
        maxHeightPx = maxHeight.coerceAtLeast(48)
        initialHeightPx = initialHeight.coerceIn(48, maxHeightPx)
        dark = darkTheme
        if (document !== doc) {
            document = doc
            loadSent = false
        }
        tornDown = false
        if (ready && !loadSent) postLoad()
    }

    fun resize(width: Int, maxHeight: Int) {
        val changed = width != widthPx || maxHeight != maxHeightPx
        widthPx = width.coerceAtLeast(1)
        maxHeightPx = maxHeight.coerceAtLeast(48)
        if (changed && ready) {
            post("contextChanged", listOf(buildJsonObject {
                put("containerDimensions", buildJsonObject {
                    put("width", widthPx)
                    put("maxHeight", maxHeightPx)
                })
            }))
        }
    }

    fun teardown() {
        if (!tornDown && ready) {
            tornDown = true
            post("teardown", emptyList())
        }
    }

    fun destroy() {
        val view = webView ?: return
        replyProxy = null
        webView = null
        if (ready && loadSent) {
            Handler(Looper.getMainLooper()).postDelayed({ view.destroy() }, 1_100)
        } else {
            view.destroy()
        }
    }

    private fun configure(view: WebView) {
        val assets = WebViewAssetLoader.AssetsPathHandler(context)
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/app/") { path ->
                // PathHandler receives only the suffix after `/app/`; the checked-in
                // asset keeps its `app/` directory, so the two prefixes are not duplicates.
                if (path == "app-host.html") assets.handle("app/app-host.html") else null
            }
            .build()
        view.settings.javaScriptEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.setSupportMultipleWindows(false)
        view.settings.setGeolocationEnabled(false)
        view.settings.mediaPlaybackRequiresUserGesture = true
        view.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.setOnTouchListener { _, event ->
            if (event.actionMasked == android.view.MotionEvent.ACTION_DOWN) {
                engagedAt = System.currentTimeMillis()
                post("engaged", listOf(JsonPrimitive(engagedAt)))
            }
            false
        }
        if (supported) {
            WebViewCompat.addWebMessageListener(
                view,
                "appHost",
                setOf(ChatAppNetwork.HOST_ORIGIN),
                object : WebViewCompat.WebMessageListener {
                    override fun onPostMessage(
                        webView: WebView,
                        message: WebMessageCompat,
                        sourceOrigin: Uri,
                        isMainFrame: Boolean,
                        replyProxy: JavaScriptReplyProxy,
                    ) {
                        if (!isMainFrame || !isHostOrigin(sourceOrigin)) return
                        this@ChatAppWebController.replyProxy = replyProxy
                        handlePageMessage(message.data)
                    }
                },
            )
        }
        view.webViewClient = object : WebViewClientCompat() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url.toString()
                assetLoader.shouldInterceptRequest(request.url)?.let { return it }
                if (url == ChatAppNetwork.HOST_PAGE) return forbidden()
                return if (ChatAppNetwork.allows(url, document?.network)) null else forbidden()
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
                consoleLog?.invoke("${message.sourceId()}:${message.lineNumber()} ${message.message()}")
                return consoleLog != null
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: android.webkit.GeolocationPermissions.Callback?,
            ) {
                callback?.invoke(origin, false, false)
            }

            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message?,
            ): Boolean = false

            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: android.webkit.JsResult?): Boolean {
                result?.cancel()
                return true
            }

            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: android.webkit.JsResult?): Boolean {
                result?.cancel()
                return true
            }

            override fun onJsPrompt(view: WebView?, url: String?, message: String?, defaultValue: String?, result: android.webkit.JsPromptResult?): Boolean {
                result?.cancel()
                return true
            }

            override fun onJsBeforeUnload(view: WebView?, url: String?, message: String?, result: android.webkit.JsResult?): Boolean {
                result?.cancel()
                return true
            }
        }
        view.loadUrl(ChatAppNetwork.HOST_PAGE)
    }

    private fun isHostOrigin(origin: Uri): Boolean =
        origin.scheme == "https" &&
            origin.host == "appassets.androidplatform.net" &&
            (origin.port == -1 || origin.port == 443) &&
            origin.path.orEmpty().removeSuffix("/").isEmpty()

    private fun forbidden(): WebResourceResponse = WebResourceResponse(
        "text/plain",
        "utf-8",
        403,
        "Forbidden",
        emptyMap(),
        ByteArrayInputStream(ByteArray(0)),
    )

    private fun handlePageMessage(raw: String?) {
        if (raw.isNullOrEmpty() || raw.length > 1_000_000) return
        val message = runCatching { CompanionJson.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        if ((message["v"] as? JsonPrimitive)?.intOrNull != 1) return
        when ((message["type"] as? JsonPrimitive)?.content) {
            "ready" -> {
                ready = true
                delegate.hostReady()
                if (!loadSent && document != null) postLoad()
            }
            "initialized" -> delegate.initialized()
            "size" -> {
                val height = (message["height"] as? JsonPrimitive)?.intOrNull ?: return
                delegate.resize(height)
            }
            "teardown-request" -> delegate.teardownRequested()
            "torn-down" -> Unit
            "call" -> handleCall(message)
        }
    }

    private fun handleCall(message: JsonObject) {
        val callId = (message["callId"] as? JsonPrimitive)?.content ?: return
        val op = (message["op"] as? JsonPrimitive)?.content ?: return
        val params = message["params"] as? JsonObject ?: JsonObject(emptyMap())
        scope.launch {
            val reply = try {
                when (op) {
                    "rpc" -> {
                        val method = (params["method"] as? JsonPrimitive)?.content
                        val rpcParams = params["params"] as? JsonObject
                        val doc = document
                        val allowed = doc != null && method in setOf("tools/call", "tools/list", "resources/read", "resources/list") &&
                            if (method?.startsWith("tools/") == true) doc.can.serverTools else doc.can.serverResources
                        if (method == null || rpcParams == null) errorReply(-32602, "rpc needs method and params")
                        else if (!allowed) errorReply(-32000, "This app cannot use that server capability here.")
                        else when (val outcome = delegate.rpc(method, rpcParams)) {
                            is AppRpcOutcome.Result -> resultReply(outcome.value ?: JsonObject(emptyMap()))
                            is AppRpcOutcome.Refusal -> {
                                delegate.failure(when {
                                    outcome.offline -> "电脑离线，应用暂时不可用。"
                                    outcome.signInServer != null -> "需要先在电脑端登录 ${outcome.signInServer}。"
                                    outcome.blockedReason != null -> outcome.blockedText ?: "此应用已被电脑阻止。"
                                    else -> outcome.message
                                })
                                errorReply(outcome.code, outcome.message)
                            }
                        }
                    }
                    "message" -> {
                        val text = (params["text"] as? JsonPrimitive)?.content
                        if (text.isNullOrEmpty()) errorReply(-32602, "message needs text")
                        else if (document?.can?.message != true) errorReply(-32000, "This app cannot send messages here.")
                        else {
                            delegate.message(text)
                            resultReply(JsonObject(emptyMap()))
                        }
                    }
                    "open-link" -> {
                        val url = (params["url"] as? JsonPrimitive)?.content
                        if (url.isNullOrEmpty()) errorReply(-32602, "open-link needs a URL")
                        else if (document?.can?.openLinks != true) errorReply(-32000, "This app cannot open links here.")
                        else {
                            delegate.openLink(url)
                            resultReply(JsonObject(emptyMap()))
                        }
                    }
                    "context" -> {
                        if (document?.can?.modelContext != true) errorReply(-32000, "This app cannot update model context here.")
                        else {
                            delegate.context(params)
                            resultReply(JsonObject(emptyMap()))
                        }
                    }
                    else -> errorReply(-32601, "Method not found")
                }
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                val text = error.message ?: "应用操作失败。"
                delegate.failure(text)
                errorReply(-32000, text)
            }
            postReply(callId, reply)
        }
    }

    private fun resultReply(result: kotlinx.serialization.json.JsonElement): JsonObject = buildJsonObject {
        put("result", result)
    }

    private fun errorReply(code: Int, message: String): JsonObject = buildJsonObject {
        put("error", buildJsonObject {
            put("code", code)
            put("message", message)
        })
    }

    private fun postReply(callId: String, reply: JsonObject) {
        post("reply", listOf(JsonPrimitive(callId), reply))
    }

    private fun postLoad() {
        val doc = document ?: return
        loadSent = true
        val docJson = CompanionJson.encodeToJsonElement(AppDocument.serializer(), doc).jsonObject
        post("load", listOf(buildJsonObject {
            put("v", 1)
            put("doc", docJson)
            put("hostContext", hostContext())
            put("limits", buildJsonObject {
                put("maxHeight", maxHeightPx)
                put("height", initialHeightPx)
            })
            put("engagedAt", engagedAt)
            put("hostVersion", hostVersion)
        }))
    }

    private fun hostContext(): JsonObject = buildJsonObject {
        put("theme", if (dark) "dark" else "light")
        put("styles", buildJsonObject {
            put("variables", buildJsonObject {
                val ink = if (dark) "#FFFFFF" else "#111111"
                val secondary = if (dark) "#99EBEBF5" else "#993C3C43"
                val tertiary = if (dark) "#4DEBEBF5" else "#4D3C3C43"
                val card = if (dark) "#1C1C1E" else "#FFFFFF"
                val soft = if (dark) "#2C2C2E" else "#F5F5F3"
                val accent = if (dark) "#6A94CE" else "#528AD2"
                put("--color-background-primary", card)
                put("--color-background-secondary", soft)
                put("--color-background-tertiary", soft)
                put("--color-background-inverse", ink)
                put("--color-background-ghost", "transparent")
                put("--color-text-primary", ink)
                put("--color-text-secondary", secondary)
                put("--color-text-tertiary", tertiary)
                put("--color-text-inverse", card)
                put("--color-border-primary", if (dark) "#38FFFFFF" else "#14000000")
                put("--color-border-secondary", if (dark) "#38383A" else "#14000000")
                put("--color-ring-primary", accent)
                put("--font-sans", "sans-serif")
                put("--font-mono", "monospace")
                put("--border-radius-md", "12px")
                put("--border-radius-lg", "16px")
            })
        })
        put("displayMode", "inline")
        put("availableDisplayModes", JsonArray(listOf(JsonPrimitive("inline"))))
        put("containerDimensions", buildJsonObject {
            put("width", widthPx)
            put("maxHeight", maxHeightPx)
        })
        put("locale", Locale.getDefault().toLanguageTag())
        put("timeZone", TimeZone.getDefault().id)
        put("platform", "mobile")
        put("deviceCapabilities", buildJsonObject {
            put("touch", true)
            put("hover", false)
        })
        put("userAgent", "LUNABOT/$hostVersion Android")
    }

    private fun post(call: String, args: List<kotlinx.serialization.json.JsonElement>) {
        val proxy = replyProxy ?: return
        val message = buildJsonObject {
            put("v", 1)
            put("call", call)
            put("args", JsonArray(args))
        }
        proxy.postMessage(message.toString())
    }
}
