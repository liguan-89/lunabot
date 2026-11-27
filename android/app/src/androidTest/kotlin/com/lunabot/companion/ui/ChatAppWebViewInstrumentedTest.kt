package com.lunabot.companion.ui

import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lunabot.companion.core.AppCan
import com.lunabot.companion.core.AppDocument
import com.lunabot.companion.core.AppNetwork
import com.lunabot.companion.core.AppRpcOutcome
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.MockWebServer
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ChatAppWebViewInstrumentedTest {
    private var scenario: ActivityScenario<ChatAppTestActivity>? = null

    @After
    fun tearDown() {
        scenario?.close()
    }

    private class Harness(
        val controller: ChatAppWebController,
        val webView: WebView,
        val scope: CoroutineScope,
        val initialized: CountDownLatch,
        val hostReady: CountDownLatch,
        val contexts: LinkedBlockingQueue<JsonObject>,
        val console: MutableList<String>,
        val messages: MutableList<String>,
        val links: MutableList<String>,
    )

    private fun load(mainScript: String, mcp: Boolean = false): Harness {
        val initialized = CountDownLatch(1)
        val hostReady = CountDownLatch(1)
        val contexts = LinkedBlockingQueue<JsonObject>()
        val console = mutableListOf<String>()
        val messages = mutableListOf<String>()
        val links = mutableListOf<String>()
        var harness: Harness? = null
        lateinit var webView: WebView
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val delegate = object : ChatAppBridgeDelegate {
            override suspend fun rpc(method: String, params: JsonObject): AppRpcOutcome = AppRpcOutcome.Result(JsonObject(emptyMap()))
            override suspend fun message(text: String) { messages += text }
            override suspend fun openLink(url: String) { links += url }
            override suspend fun context(update: JsonObject) { contexts += update }
            override fun resize(height: Int) = Unit
            override fun initialized() { initialized.countDown() }
            override fun hostReady() { hostReady.countDown() }
            override fun teardownRequested() = Unit
            override fun failure(text: String) = Unit
        }
        val doc = document(mainScript, mcp)
        scenario = ActivityScenario.launch(ChatAppTestActivity::class.java)
        scenario?.onActivity { activity ->
            webView = WebView(activity)
            val controller = ChatAppWebController(activity, scope, delegate, "instrumented-test") { console += it }
            activity.setContentView(webView)
            controller.attach(webView)
            controller.load(doc, 360, 720, false, 160)
            harness = Harness(controller, webView, scope, initialized, hostReady, contexts, console, messages, links)
        }
        val result = requireNotNull(harness)
        assertTrue("host page did not become ready", result.hostReady.await(8, TimeUnit.SECONDS))
        val initializedOk = result.initialized.await(8, TimeUnit.SECONDS)
        val detail = if (initializedOk) "" else " host=" + evaluate(result.webView, """
JSON.stringify({
  iframes: document.querySelectorAll('iframe').length,
  injected: typeof appHost,
  api: typeof lunabotAppHost,
  body: document.body && document.body.innerHTML.slice(0, 180)
})
""")
        assertTrue("app did not initialize:$detail console=${console.take(8)}", initializedOk)
        return result
    }

    private fun document(mainScript: String, mcp: Boolean): AppDocument {
        val csp = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline'"
        val html = """<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="$csp"><script>
const pending = new Map();
const hostEvents = [];
function send(message) { parent.postMessage(message, '*'); }
function request(id, method, params) { send({ jsonrpc: '2.0', id, method, params: params || {} }); }
function report(value) { request('report-' + Math.random(), 'ui/update-model-context', { structuredContent: { probe: value } }); }
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.jsonrpc !== '2.0') return;
  if (typeof data.method === 'string') hostEvents.push(data.method);
  const waiter = pending.get(String(data.id));
  if (waiter) { pending.delete(String(data.id)); waiter(data); }
});
function call(id, method, params) { return new Promise((resolve) => { pending.set(id, resolve); request(id, method, params); }); }
pending.set('1', () => {
  send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  setTimeout(() => { $mainScript }, 0);
});
request(1, 'ui/initialize', {});
</script>"""
        return AppDocument(
            v = 1,
            messageId = "m1",
            rev = 1,
            srcdoc = html,
            csp = csp,
            network = AppNetwork(connect = emptyList(), resources = emptyList()),
            tool = if (mcp) com.lunabot.companion.core.AppToolDefinition(name = "probe") else null,
            can = AppCan(serverTools = mcp, serverResources = mcp, message = true, openLinks = true, modelContext = true),
        )
    }

    private fun evaluate(webView: WebView, expression: String): String {
        val latch = CountDownLatch(1)
        var value = "no answer"
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            webView.evaluateJavascript(expression) { answer ->
                value = answer ?: "null"
                latch.countDown()
            }
        }
        latch.await(4, TimeUnit.SECONDS)
        return value
    }

    private fun nextContext(harness: Harness): JsonObject =
        harness.contexts.poll(8, TimeUnit.SECONDS)?.getValue("structuredContent")?.jsonObject?.getValue("probe")?.jsonObject
            ?: throw AssertionError("the frame did not report back")

    @Test
    fun sandboxedFrameIsOpaqueAndCannotReachTheAndroidBridge() {
        val harness = load("""
report({
  origin: String(window.location.origin),
  appHost: typeof window.appHost,
  webkit: typeof window.webkit,
  parentDocument: (() => { try { return parent.document ? 'visible' : 'visible'; } catch (_) { return 'blocked'; } })(),
  localStorage: (() => { try { localStorage.setItem('x', 'y'); return 'visible'; } catch (_) { return 'blocked'; } })(),
  cookie: (() => { try { document.cookie = 'x=y'; return document.cookie ? 'visible' : 'empty'; } catch (_) { return 'blocked'; } })()
});
""")
        val probe = nextContext(harness)
        assertEquals("null", probe.getValue("origin").jsonPrimitive.content)
        assertEquals("undefined", probe.getValue("appHost").jsonPrimitive.content)
        assertEquals("undefined", probe.getValue("webkit").jsonPrimitive.content)
        assertEquals("blocked", probe.getValue("parentDocument").jsonPrimitive.content)
        assertEquals("blocked", probe.getValue("localStorage").jsonPrimitive.content)
        harness.scope.cancel()
    }

    @Test
    fun messageAndOpenLinkDoNothingWithoutEngagement() {
        val harness = load("""
Promise.all([
  call('m', 'ui/message', { role: 'user', content: [{ type: 'text', text: 'hello' }] }),
  call('l', 'ui/open-link', { url: 'https://example.com/' })
]).then(([message, link]) => report({ message: message.error && message.error.code, link: link.error && link.error.code }));
""")
        val probe = nextContext(harness)
        assertEquals(-32000, probe.getValue("message").jsonPrimitive.content.toInt())
        assertEquals(-32000, probe.getValue("link").jsonPrimitive.content.toInt())
        assertTrue(harness.messages.isEmpty())
        assertTrue(harness.links.isEmpty())
        harness.scope.cancel()
    }

    @Test
    fun malformedMessagesDoNotStopTheBridgeAndUnknownMethodsAreRefused() {
        val harness = load("""
parent.postMessage({ junk: true }, '*');
parent.postMessage('not json rpc', '*');
call('u', 'not/a-method', {}).then((answer) => {
  report({ code: answer.error && answer.error.code, ping: 'waiting' });
});
""")
        val probe = nextContext(harness)
        assertEquals(-32601, probe.getValue("code").jsonPrimitive.content.toInt())
        harness.scope.cancel()
    }

    @Test
    fun mcpToolInputPrecedesToolResultAfterInitialization() {
        val harness = load("""
setTimeout(() => report({ events: hostEvents }), 150);
""", mcp = true)
        val events = nextContext(harness).getValue("events").toString()
        assertTrue(events.indexOf("ui/notifications/tool-input") < events.indexOf("ui/notifications/tool-result"))
        harness.scope.cancel()
    }

    @Test
    fun sandboxBlocksNetworkRequestsAndFrameNavigationBeforeTheyReachTheSink() {
        val server = MockWebServer()
        server.start()
        try {
            val hit = server.url("/hit").toString()
            val harness = load("""
fetch('$hit').catch(() => {});
const image = new Image(); image.src = '$hit';
const prefetch = document.createElement('link'); prefetch.rel = 'prefetch'; prefetch.href = '$hit'; document.head.appendChild(prefetch);
try { window.open('$hit'); } catch (_) {}
setTimeout(() => report({ done: true }), 500);
setTimeout(() => {
  try { top.location = '$hit'; } catch (_) {}
  const form = document.createElement('form'); form.action = '$hit'; form.method = 'post'; document.body.appendChild(form); form.submit();
}, 800);
""")
            assertNotNull(nextContext(harness).getValue("done"))
            Thread.sleep(700)
            assertEquals(0, server.requestCount)
            harness.scope.cancel()
        } finally {
            server.shutdown()
        }
    }
}
