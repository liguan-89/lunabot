// Adapted from Mika's DeviceUnlockInput and DeviceAccess (Apache-2.0).
package com.openmausbot.companion.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import com.openmausbot.companion.phoneui.UnlockCredential
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The non-secret half of the stored unlock credential. The value itself is not
 * part of this: it is read only by [UnlockCredentialStore.credential], and its
 * owner wipes it.
 */
data class UnlockState(
    val configured: Boolean = false,
    val kind: Int? = null,
    val revision: Long = 0,
    val remoteUnlockEnabled: Boolean = false,
    val blocked: Boolean = false,
)

/** The one credential value, valid only between [UnlockCredentialStore.credential] and [close]. */
class StoredUnlockCredential internal constructor(
    val kind: Int,
    val revision: Long,
    /** The value bytes; the owner passes this straight to the helper and then [close]s it. */
    val value: ByteArray,
) : AutoCloseable {
    override fun close() {
        value.fill(0)
    }

    override fun toString() = "StoredUnlockCredential(kind=$kind, revision=$revision, redacted)"
}

/** AES/GCM over an Android Keystore key; the plaintext never leaves this process. */
interface UnlockSecretCipher {
    fun encrypt(plain: ByteArray): ByteArray
    fun decrypt(sealed: ByteArray): ByteArray
}

/**
 * AES-256/GCM under a key the Android Keystore holds and never exports, so the
 * file is unreadable off this device and dies with the install. The IV is
 * random per write and prefixed to the ciphertext, as Mika's `KeyCipher` does.
 *
 * A raw byte cipher rather than EncryptedSharedPreferences (the idiom
 * [KeystoreTokenStore] uses) on purpose: that API stores `String`s, and this
 * value must never exist as a String the heap can keep alive.
 */
class KeystoreUnlockCipher(private val alias: String = DEFAULT_ALIAS) : UnlockSecretCipher {
    override fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val iv = cipher.iv
        check(iv.size == IV_BYTES) { "unexpected IV length ${iv.size}" }
        return iv + cipher.doFinal(plain)
    }

    override fun decrypt(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_BYTES) { "ciphertext too short" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
        return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    companion object {
        const val DEFAULT_ALIAS = "lunabot-unlock-credential"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }
}

/**
 * The unlock credential the person entered on this phone, encrypted at rest,
 * plus the two non-secret switches that govern it: whether remote unlocking is
 * allowed at all, and whether an attempt is still outstanding.
 *
 * The value is a `ByteArray` for its whole life here; nothing turns it into a
 * `String`, and every buffer this class builds is zeroed in a `finally`. [clear]
 * overwrites the file with zeros before deleting it, because unlink alone
 * promises nothing on a flash file system.
 *
 * Attempt blocking follows Mika: [beginAttempt] persists "an attempt is
 * outstanding" *before* a key is injected, and only [completeAttempt] — reached
 * only when the system reports the phone unlocked — clears it. A failed,
 * cancelled or crashed attempt therefore stays blocked instead of being retried
 * automatically; the person can still unlock by hand.
 *
 * Every method is synchronous and serialized, like Mika's `DeviceAccessSettings`
 * and unlike [KeystoreTokenStore]: the handoff provider has to read the switch
 * on a binder thread that cannot suspend, and callers that must stay off the
 * main thread already have a scope to hop through.
 *
 * The constructor touches neither the Keystore nor the disk. It runs on whatever
 * thread first asks for [of] — the main thread at app start — and the first read
 * is a `MasterKey`/`Cipher` init plus a file read. The read happens on the first
 * call that actually needs the record instead, once, under [lock]; until then
 * [state] is the default `UnlockState()`, which says "no credential" and so
 * unlocks nothing.
 */
class UnlockCredentialStore(
    private val dir: File,
    private val cipher: UnlockSecretCipher,
) {
    constructor(context: Context) : this(
        File(context.applicationContext.filesDir, DIR),
        KeystoreUnlockCipher(),
    )

    private val file = File(dir, FILE)
    private val lock = Any()

    /**
     * Whether the first read has happened. Written and read while holding [lock];
     * it is atomic only so the check is cheap and visible to any future reader
     * that does not.
     */
    private val loaded = AtomicBoolean(false)

    private val _state = MutableStateFlow(UnlockState())

    /**
     * The non-secret view Settings renders. The default — "not configured" — is
     * what it holds until the first read lands, and it is a plain in-memory read:
     * subscribing to it never touches the Keystore or the disk.
     */
    val state: StateFlow<UnlockState> = _state.asStateFlow()

    val configured: Boolean get() = _state.value.configured

    /**
     * Re-read the file and publish its non-secret fields. Called once at app
     * start on a background dispatcher, and again whenever Settings reopens.
     * Unreadable means not configured.
     */
    fun refresh() = synchronized(lock) {
        val first = readRecord()
        publish(first)
        loaded.set(true)
        first?.value?.fill(0)
    }

    /**
     * The record for this call, and the one place the lazy first read happens.
     * Callers hold [lock]. The first caller — whichever accessor it is — pays the
     * Keystore and disk read and publishes the non-secret fields; every later
     * caller reads the file and nothing else.
     *
     * This is why the constructor can run on the main thread: nothing here has
     * been touched until someone actually needs the credential, and until then
     * [state] is the default "not configured", which unlocks nothing.
     */
    private fun record(): UnlockRecord? {
        val next = readRecord()
        if (!loaded.getAndSet(true)) publish(next)
        return next
    }

    /**
     * Replace the credential. [value] is consumed: it is wiped before this
     * returns, whether or not the write succeeded. False for a value outside the
     * PIN/password shape or when the Keystore refuses.
     */
    fun set(kind: Int, value: CharArray): Boolean {
        try {
            if (!UnlockCredential.valid(kind, value)) return false
            return synchronized(lock) {
                val bytes = ByteArray(value.size) { value[it].code.toByte() }
                try {
                    val previous = record()
                    try {
                        val next = UnlockRecord(
                            kind = kind,
                            revision = (previous?.revision ?: 0L) + 1,
                            remoteUnlockEnabled = previous?.remoteUnlockEnabled == true,
                            blocked = false,
                            value = bytes,
                        )
                        write(next)
                        publish(next)
                        true
                    } finally {
                        previous?.value?.fill(0)
                    }
                } finally {
                    bytes.fill(0)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "credential set failed: ${t.javaClass.simpleName}")
            return false
        } finally {
            value.fill('\u0000')
        }
    }

    /** Remove the credential: overwrite the file, delete it, and drop the remote-unlock permission with it. */
    fun clear() = synchronized(lock) {
        overwriteAndDelete()
        _state.value = UnlockState()
        // Nothing is left to read, and a later lazy read must not try.
        loaded.set(true)
    }

    /** The value for one attempt, or null when there is none or the file no longer parses. */
    fun credential(): StoredUnlockCredential? = synchronized(lock) {
        val held = record() ?: return@synchronized null
        publish(held)
        StoredUnlockCredential(held.kind, held.revision, held.value)
    }

    /**
     * Claim the one outstanding attempt. False when the credential changed since
     * it was read, or when an earlier attempt never finished.
     *
     * The person's remote switch is not checked here: a test unlock started from
     * this phone's own Settings must work with the switch off, while the switch
     * itself still gates the helper (see [PhoneUiUnlocker] and the bridge).
     */
    fun beginAttempt(revision: Long): Boolean = synchronized(lock) {
        val held = record() ?: return@synchronized false
        try {
            if (held.blocked || held.revision != revision) return@synchronized false
            val claimed = UnlockRecord(held.kind, held.revision, held.remoteUnlockEnabled, true, held.value)
            write(claimed)
            publish(claimed)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "attempt claim failed: ${t.javaClass.simpleName}")
            false
        } finally {
            held.value.fill(0)
        }
    }

    /** The phone is unlocked: clear the outstanding attempt, but only for the revision that made it. */
    fun completeAttempt(revision: Long) = synchronized(lock) {
        val held = record() ?: return@synchronized
        try {
            if (held.revision != revision || !held.blocked) return@synchronized
            val cleared = UnlockRecord(held.kind, held.revision, held.remoteUnlockEnabled, false, held.value)
            write(cleared)
            publish(cleared)
        } finally {
            held.value.fill(0)
        }
    }

    /**
     * The person's switch, which the helper is told at connect time. Refused
     * while no credential is configured: there is nothing the switch could
     * authorize. Turning it off is always allowed.
     */
    fun setRemoteUnlockEnabled(enabled: Boolean): Boolean = synchronized(lock) {
        val held = record() ?: return@synchronized false
        try {
            val next = UnlockRecord(held.kind, held.revision, enabled, held.blocked, held.value)
            write(next)
            publish(next)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "remote unlock switch failed: ${t.javaClass.simpleName}")
            false
        } finally {
            held.value.fill(0)
        }
    }

    private fun publish(record: UnlockRecord?) {
        _state.value = if (record == null) {
            UnlockState()
        } else {
            UnlockState(
                configured = true,
                kind = record.kind,
                revision = record.revision,
                remoteUnlockEnabled = record.remoteUnlockEnabled,
                blocked = record.blocked,
            )
        }
    }

    private class UnlockRecord(
        val kind: Int,
        val revision: Long,
        val remoteUnlockEnabled: Boolean,
        val blocked: Boolean,
        val value: ByteArray,
    )

    /** Header and value sealed as one blob. Null for a missing, undecryptable or malformed file. */
    private fun readRecord(): UnlockRecord? = try {
        if (!file.isFile) null else {
            val sealed = file.readBytes()
            val plain = try {
                cipher.decrypt(sealed)
            } finally {
                sealed.fill(0)
            }
            try {
                parse(plain)
            } finally {
                plain.fill(0)
            }
        }
    } catch (t: Throwable) {
        Log.w(TAG, "credential unreadable: ${t.javaClass.simpleName}")
        null
    }

    private fun parse(plain: ByteArray): UnlockRecord? {
        val buffer = ByteBuffer.wrap(plain)
        if (buffer.remaining() < HEADER_BYTES || buffer.int != MAGIC || buffer.get() != VERSION) return null
        val kind = buffer.get().toInt()
        val revision = buffer.long
        val flags = buffer.get().toInt()
        val length = buffer.short.toInt()
        if (length < 0 || length > buffer.remaining()) return null
        val value = ByteArray(length).also(buffer::get)
        val chars = CharArray(length) { value[it].toInt().toChar() }
        val valid = try {
            UnlockCredential.valid(kind, chars)
        } finally {
            chars.fill('\u0000')
        }
        if (!valid) {
            value.fill(0)
            return null
        }
        return UnlockRecord(
            kind = kind,
            revision = revision,
            remoteUnlockEnabled = flags and FLAG_REMOTE != 0,
            blocked = flags and FLAG_BLOCKED != 0,
            value = value,
        )
    }

    private fun write(record: UnlockRecord) {
        val plain = ByteBuffer.allocate(HEADER_BYTES + record.value.size)
            .putInt(MAGIC)
            .put(VERSION)
            .put(record.kind.toByte())
            .putLong(record.revision)
            .put(((if (record.remoteUnlockEnabled) FLAG_REMOTE else 0) or (if (record.blocked) FLAG_BLOCKED else 0)).toByte())
            .putShort(record.value.size.toShort())
            .put(record.value)
            .array()
        dir.mkdirs()
        val tmp = File(dir, "$FILE.tmp")
        try {
            val sealed = cipher.encrypt(plain)
            try {
                tmp.writeBytes(sealed)
            } finally {
                sealed.fill(0)
            }
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } finally {
            plain.fill(0)
            tmp.delete()
        }
    }

    /** Overwrite the ciphertext in place, flush, then delete it. */
    private fun overwriteAndDelete() {
        if (file.isFile) {
            runCatching {
                RandomAccessFile(file, "rw").use { handle ->
                    val zeros = ByteArray(handle.length().coerceAtMost(MAX_OVERWRITE_BYTES).toInt())
                    handle.write(zeros)
                    handle.fd.sync()
                }
            }.onFailure { Log.w(TAG, "credential overwrite failed: ${it.javaClass.simpleName}") }
        }
        file.delete()
        File(dir, "$FILE.tmp").delete()
    }

    companion object {
        private const val TAG = "UnlockCredential"

        /** Excluded from Auto Backup and device transfer in both XML rule files. */
        const val DIR = "unlock"
        const val FILE = "device-credential.bin"

        private const val MAGIC = 0x4C554E4B // "LUNK"
        private const val VERSION: Byte = 1
        private const val FLAG_REMOTE = 1
        private const val FLAG_BLOCKED = 2
        private const val HEADER_BYTES = 4 + 1 + 1 + 8 + 1 + 2
        private const val MAX_OVERWRITE_BYTES = 4_096L

        @Volatile
        private var shared: UnlockCredentialStore? = null

        /**
         * The one store this process uses, so the handoff provider and Settings
         * read and write the same state. The first caller's context decides
         * where the file lives; every caller is the same app process.
         */
        fun of(context: Context): UnlockCredentialStore =
            shared ?: synchronized(this) {
                shared ?: UnlockCredentialStore(context.applicationContext).also { shared = it }
            }
    }
}
