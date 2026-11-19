// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
package com.lunabot.companion.phoneui

import com.lunabot.companion.storage.UnlockCredentialStore
import com.lunabot.companion.storage.UnlockSecretCipher
import com.lunabot.companion.storage.UnlockState
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The stored credential: it survives a restart, it is never on disk in the
 * clear, `clear` overwrites and deletes, and the attempt block follows Mika's
 * rule (claimed before any key, cleared only by a successful unlock).
 *
 * Robolectric for `android.util.Log`, which the failure paths call. The cipher
 * is a reversible stand-in, so these are assertions about the store's own
 * bookkeeping rather than about the Keystore.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UnlockCredentialStoreTest {
    private val dir: File = Files.createTempDirectory("unlock-store").toFile()

    private fun store(cipher: UnlockSecretCipher = XorCipher()): UnlockCredentialStore =
        UnlockCredentialStore(dir, cipher)

    @AfterTest
    fun cleanUp() {
        dir.deleteRecursively()
    }

    @Test
    fun `a credential round-trips with its kind and revision`() {
        val store = store()
        assertFalse(store.configured)

        assertTrue(store.set(UnlockCredential.KIND_PIN, "1234".toCharArray()))
        store.refresh()
        assertTrue(store.configured)
        assertEquals(UnlockCredential.KIND_PIN, store.state.value.kind)
        assertEquals(1L, store.state.value.revision)
        assertFalse(store.state.value.remoteUnlockEnabled, "the switch is off until the person turns it on")

        store.credential()!!.use { held ->
            assertEquals(UnlockCredential.KIND_PIN, held.kind)
            assertEquals("1234", String(held.value, Charsets.US_ASCII))
        }

        assertTrue(store.set(UnlockCredential.KIND_PASSWORD, "pa ss".toCharArray()))
        assertEquals(2L, store.state.value.revision)
        store.credential()!!.use { held ->
            assertEquals(UnlockCredential.KIND_PASSWORD, held.kind)
            assertEquals("pa ss", String(held.value, Charsets.US_ASCII))
        }
    }

    @Test
    fun `the value is not on disk in the clear`() {
        val store = store()
        assertTrue(store.set(UnlockCredential.KIND_PIN, "864209".toCharArray()))
        val raw = File(dir, UnlockCredentialStore.FILE).readBytes()
        assertFalse(String(raw, Charsets.ISO_8859_1).contains("864209"), "the PIN must be sealed at rest")
    }

    @Test
    fun `clear overwrites and deletes the file, and drops the switch with it`() {
        val store = store()
        assertTrue(store.set(UnlockCredential.KIND_PIN, "1357".toCharArray()))
        assertTrue(store.setRemoteUnlockEnabled(true))
        assertTrue(store.state.value.remoteUnlockEnabled)
        val file = File(dir, UnlockCredentialStore.FILE)
        assertTrue(file.isFile)

        store.clear()

        assertFalse(file.exists(), "clear must delete the record, not just empty it")
        assertFalse(store.configured)
        assertNull(store.credential())
        assertFalse(store.state.value.remoteUnlockEnabled, "removing the credential removes the permission")
        assertFalse(store.state.value.blocked)
        // A later attempt to read sees nothing, and a fresh set starts over at
        // revision 1 because there is no record to build on.
        store.refresh()
        assertFalse(store.configured)
        assertTrue(store.set(UnlockCredential.KIND_PIN, "2468".toCharArray()))
        assertEquals(1L, store.state.value.revision)
    }

    @Test
    fun `the caller's buffer is wiped whether or not the value was accepted`() {
        val store = store()
        val accepted = "1234".toCharArray()
        assertTrue(store.set(UnlockCredential.KIND_PIN, accepted))
        assertContentEquals(CharArray(4) { '\u0000' }, accepted)

        val refused = "12".toCharArray()
        assertFalse(store.set(UnlockCredential.KIND_PIN, refused))
        assertContentEquals(CharArray(2) { '\u0000' }, refused)
    }

    @Test
    fun `an invalid value is refused and nothing is written`() {
        val store = store()
        assertFalse(store.set(UnlockCredential.KIND_PIN, "12a4".toCharArray()))
        assertFalse(store.set(UnlockCredential.KIND_PASSWORD, "   ".toCharArray()))
        assertFalse(store.set(UnlockCredential.KIND_PASSWORD, "x".repeat(65).toCharArray()))
        assertFalse(store.set(9, "1234".toCharArray()))
        assertFalse(File(dir, UnlockCredentialStore.FILE).exists())
        assertFalse(store.configured)
    }

    @Test
    fun `the switch needs a credential and turning it off always works`() {
        val store = store()
        assertFalse(store.setRemoteUnlockEnabled(true), "no credential, nothing to authorize")
        assertTrue(store.set(UnlockCredential.KIND_PIN, "1111".toCharArray()))
        assertTrue(store.setRemoteUnlockEnabled(true))
        assertTrue(store.setRemoteUnlockEnabled(false))
        assertFalse(store.state.value.remoteUnlockEnabled)
    }

    @Test
    fun `an attempt is claimed once and cleared only by a successful unlock`() {
        val store = store()
        assertTrue(store.set(UnlockCredential.KIND_PIN, "4321".toCharArray()))
        val revision = store.state.value.revision

        assertTrue(store.beginAttempt(revision))
        assertTrue(store.state.value.blocked)
        // The claim survives a restart: the block is in the file, not in memory.
        val reopened = store().also { it.refresh() }
        assertTrue(reopened.state.value.blocked)
        assertFalse(reopened.beginAttempt(revision), "an unfinished attempt is not retried automatically")
        assertFalse(reopened.beginAttempt(revision + 1), "a stale revision cannot claim the block")

        reopened.completeAttempt(revision)
        assertFalse(reopened.state.value.blocked)
        assertTrue(reopened.beginAttempt(revision))
    }

    @Test
    fun `a new credential clears an outstanding block`() {
        val store = store()
        assertTrue(store.set(UnlockCredential.KIND_PIN, "9999".toCharArray()))
        assertTrue(store.beginAttempt(store.state.value.revision))
        assertTrue(store.state.value.blocked)

        assertTrue(store.set(UnlockCredential.KIND_PIN, "8888".toCharArray()))

        assertFalse(store.state.value.blocked)
        assertTrue(store.beginAttempt(store.state.value.revision))
    }

    @Test
    fun `an unreadable file is not a credential`() {
        dir.mkdirs()
        File(dir, UnlockCredentialStore.FILE).writeBytes(byteArrayOf(1, 2, 3))
        val store = store()
        store.refresh()
        assertFalse(store.configured)
        assertNull(store.credential())
    }

    @Test
    fun `the constructor does no keystore or disk work`() {
        // Built on the main thread at app start, so the cipher must not be
        // touched and the state must already answer "not configured".
        val cipher = CountingCipher()
        val store = UnlockCredentialStore(dir, cipher)

        assertEquals(0, cipher.calls, "constructing the store must not reach the cipher")
        assertEquals(UnlockState(), store.state.value, "the default state says no credential")
        assertFalse(store.configured)
    }

    @Test
    fun `the first read is lazy, once, and publishes what it found`() {
        assertTrue(store().set(UnlockCredential.KIND_PIN, "2468".toCharArray()))
        val cipher = CountingCipher()
        val reopened = UnlockCredentialStore(dir, cipher)
        assertFalse(reopened.configured, "nothing is read until someone asks")

        reopened.credential()!!.use { held ->
            assertEquals("2468", String(held.value, Charsets.US_ASCII))
        }
        assertTrue(reopened.configured, "the first read publishes the non-secret fields")
        assertEquals(1L, reopened.state.value.revision)
    }

    /** Counts every cipher call, so a test can prove the constructor made none. */
    private class CountingCipher : UnlockSecretCipher {
        var calls = 0

        override fun encrypt(plain: ByteArray): ByteArray {
            calls++
            return ByteArray(plain.size) { (plain[it].toInt() xor 0x5A).toByte() }
        }

        override fun decrypt(sealed: ByteArray): ByteArray {
            calls++
            return ByteArray(sealed.size) { (sealed[it].toInt() xor 0x5A).toByte() }
        }
    }

    /** Reversible stand-in for the Keystore cipher: enough to prove the store never writes plaintext. */
    private class XorCipher : UnlockSecretCipher {
        override fun encrypt(plain: ByteArray): ByteArray = ByteArray(plain.size) { (plain[it].toInt() xor 0x5A).toByte() }

        override fun decrypt(sealed: ByteArray): ByteArray = encrypt(sealed)
    }
}
