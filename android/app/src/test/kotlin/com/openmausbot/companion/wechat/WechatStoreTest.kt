// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.openmausbot.companion.wechat

import android.content.Context
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * The store's two obligations: the token round-trips, and it is the only place
 * the token appears.
 *
 * These run against a real `SharedPreferences` (Robolectric) and a cipher that
 * is a marker rather than encryption — the Keystore itself is Android's to
 * keep, and asserting anything about it here would be asserting about the
 * platform. What is testable is this class's handling: which keys hold what,
 * that the state blob never carries the token, and that clearing really clears.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WechatStoreTest {

    private val context: Context = RuntimeEnvironment.getApplication()

    /** A cipher whose output is recognisably not the plaintext, and reversible. */
    private class MarkerCipher : WechatKeyCipher {
        override fun encrypt(plain: ByteArray): ByteArray =
            plain.map { (it.toInt() xor 0x5A).toByte() }.reversed().toByteArray()
        override fun decrypt(data: ByteArray): ByteArray =
            data.reversed().map { (it.toInt() xor 0x5A).toByte() }.toByteArray()
    }

    private fun prefs(name: String) = context.getSharedPreferences(name, Context.MODE_PRIVATE)

    private fun store(name: String) = WechatStore(prefs(name), MarkerCipher())

    @Test
    fun `the token round-trips and nothing else holds it`() {
        val name = "wechat-store-${System.nanoTime()}"
        val store = store(name)
        val account = WechatAccount(token = "very-secret-token", botId = "bot", ownerId = "owner")
        store.saveAccount(account)

        val reopened = WechatStore(prefs(name), MarkerCipher())
        assertEquals(account, reopened.account())
        assertEquals("very-secret-token", reopened.account()?.token)

        // Every value on disk is checked: the token must appear in exactly the
        // one encrypted blob, and in no plain form anywhere.
        val all = prefs(name).all
        assertTrue(all.isNotEmpty())
        for ((key, value) in all) {
            val text = value.toString()
            assertFalse(text.contains("very-secret-token"), "plaintext token in $key")
        }
        val rawBlob = all.getValue("wechat.account").toString()
        val decoded = MarkerCipher().decrypt(android.util.Base64.decode(rawBlob, android.util.Base64.NO_WRAP))
        // It is in the encrypted slot, and the state blob does not carry it.
        assertTrue(decoded.decodeToString().contains("very-secret-token"))
        assertFalse(all.getValue("wechat.state").toString().contains("very-secret-token"))
    }

    @Test
    fun `the state survives a restart and carries no credential`() {
        val name = "wechat-state-${System.nanoTime()}"
        val store = store(name)
        store.saveAccount(WechatAccount(token = "t", botId = "b", ownerId = "owner"))
        store.setEnabled(true)
        store.saveCursor("cursor-1")
        store.rememberContextToken("ctx-1")
        store.journal(PendingWechatEvent(sendId = "m1", from = "owner", text = "hi"))

        val reopened = WechatStore(prefs(name), MarkerCipher())
        assertTrue(reopened.enabled())
        assertEquals("cursor-1", reopened.cursor())
        assertEquals("ctx-1", reopened.contextToken())
        assertEquals(1, reopened.pending().size)
        assertEquals("m1", reopened.pending().single().sendId)
        assertTrue(reopened.hasMessage("m1"))
        // A restart does not replay it: the journal entry is still pending, and
        // the id is known.
        assertFalse(reopened.journal(PendingWechatEvent(sendId = "m1", from = "owner", text = "hi")))
    }

    @Test
    fun `needs rebind is durable`() {
        val name = "wechat-rebind-${System.nanoTime()}"
        val store = store(name)
        store.saveAccount(WechatAccount(token = "t", botId = "b", ownerId = "owner"))
        store.setNeedsRebind(true)
        assertTrue(WechatStore(prefs(name), MarkerCipher()).needsRebind())
        store.setNeedsRebind(false)
        assertFalse(WechatStore(prefs(name), MarkerCipher()).needsRebind())
    }

    @Test
    fun `acknowledged ids are bounded and the journal empties`() {
        val name = "wechat-ack-${System.nanoTime()}"
        val store = store(name)
        repeat(WechatStore.MAX_ACKNOWLEDGED + 40) { index ->
            val id = "m$index"
            store.journal(PendingWechatEvent(sendId = id, from = "owner", text = "x"))
            store.acknowledge(id)
        }
        assertTrue(store.pending().isEmpty())
        // The oldest ids fall off the list; the newest is still known.
        assertTrue(store.hasMessage("m${WechatStore.MAX_ACKNOWLEDGED + 39}"))
        assertFalse(store.hasMessage("m0"))
    }

    @Test
    fun `clear wipes the token, the cursor and the journal`() {
        val name = "wechat-clear-${System.nanoTime()}"
        val store = store(name)
        store.saveAccount(WechatAccount(token = "t", botId = "b", ownerId = "owner"))
        store.setEnabled(true)
        store.saveCursor("c")
        store.journal(PendingWechatEvent(sendId = "m1", from = "owner", text = "hi"))

        store.clear()

        assertNull(store.account())
        assertFalse(store.enabled())
        assertEquals("", store.cursor())
        assertTrue(store.pending().isEmpty())
        // The encrypted blob is gone from disk, not merely ignored.
        assertNull(prefs(name).getString("wechat.account", null))
        assertNull(WechatStore(prefs(name), MarkerCipher()).account())
    }

    @Test
    fun `rebinding the same owner keeps the journal and a different owner clears it`() {
        val name = "wechat-rebind-journal-${System.nanoTime()}"
        val store = store(name)
        store.saveAccount(WechatAccount(token = "t", botId = "b", ownerId = "owner"))
        store.journal(PendingWechatEvent(sendId = "m1", from = "owner", text = "hi"))

        // The same account re-scans: its queued message is still valid.
        store.saveAccount(WechatAccount(token = "t2", botId = "b", ownerId = "owner"))
        assertTrue(store.hasMessage("m1"))

        // A different owner is a different conversation.
        store.saveAccount(WechatAccount(token = "t3", botId = "b2", ownerId = "someone-else"))
        assertFalse(store.hasMessage("m1"))
        assertEquals("", store.cursor())
        assertNotNull(store.account())
    }

    @Test
    fun `a corrupted blob reads as no binding instead of crashing`() {
        val name = "wechat-corrupt-${System.nanoTime()}"
        prefs(name).edit().putString("wechat.account", "not-base64-at-all!!").commit()
        assertNull(WechatStore(prefs(name), MarkerCipher()).account())
    }
}
