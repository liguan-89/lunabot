// Adapted from Mika's WechatApi and WechatRuntime (Apache-2.0).
package com.openmausbot.companion.wechat

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * One message the runtime has accepted but not yet handed to the computer.
 * Kept across a process restart so a phone that dies mid-post replays it
 * instead of losing it — and so the same iLink message is never posted twice.
 *
 * Images are referenced by name; their bytes live in the app's private files
 * directory, never in preferences.
 */
@Serializable
internal data class PendingWechatEvent(
    val sendId: String,
    val from: String,
    val text: String,
    val images: List<PendingWechatImage> = emptyList(),
)

@Serializable
internal data class PendingWechatImage(val name: String, val mime: String)

/** Everything about the channel that is not a credential. */
@Serializable
internal data class WechatState(
    /** Whether the runtime should be listening. The token survives a stop. */
    val enabled: Boolean = false,
    /** Set when iLink answered 401/403: the binding is dead and must be redone. */
    val needsRebind: Boolean = false,
    /** iLink's `get_updates_buf`. Persisted so a restart resumes, not replays. */
    val cursor: String = "",
    /** The reply token for the bound owner's private chat. */
    val contextToken: String? = null,
    /** Recent message ids, so a cursor rewind cannot re-post one. */
    val acknowledged: List<String> = emptyList(),
    val pending: List<PendingWechatEvent> = emptyList(),
)

/** AES/GCM over a Keystore-held key. Split out so tests can substitute it. */
internal interface WechatKeyCipher {
    fun encrypt(plain: ByteArray): ByteArray
    fun decrypt(data: ByteArray): ByteArray
}

/** 12-byte IV followed by the ciphertext (with its GCM tag). */
internal class AesGcmKeyCipher(private val key: () -> SecretKey) : WechatKeyCipher {
    override fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val iv = cipher.iv
        check(iv.size == IV_BYTES) { "unexpected IV length ${iv.size}" }
        return iv + cipher.doFinal(plain)
    }

    override fun decrypt(data: ByteArray): ByteArray {
        require(data.size > IV_BYTES) { "ciphertext too short" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, data, 0, IV_BYTES))
        return cipher.doFinal(data, IV_BYTES, data.size - IV_BYTES)
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}

/**
 * The key lives in the Android Keystore: it never leaves the device's protected
 * storage, cannot be exported, and dies with the install.
 */
internal fun keystoreWechatCipher(alias: String = "lunabot-wechat-credentials"): WechatKeyCipher =
    AesGcmKeyCipher {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(
                    KeyGenParameterSpec.Builder(
                        alias,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build(),
                )
                generateKey()
            }
    }

/**
 * The binding and the runtime's place in the message stream.
 *
 * Two stores with different rules, deliberately:
 *
 * - **The token is encrypted** with a Keystore key and written as one opaque
 *   base64 blob. It is never written anywhere else, never put in the state
 *   blob, never logged, and never sent to the paired computer — the server
 *   sees a `wechat` event, not the credential that produced it.
 * - **The cursor, context token, acknowledged ids and pending messages are
 *   ordinary preferences.** They are not credentials, and a lost cursor only
 *   costs a re-fetch.
 *
 * Every write is `commit()`, not `apply()`: the caller relies on the cursor
 * being durable before the next long poll, and on a journal entry being
 * durable before the message is dispatched.
 */
internal class WechatStore(
    private val prefs: SharedPreferences,
    private val cipher: WechatKeyCipher,
) {
    constructor(context: Context, cipher: WechatKeyCipher = keystoreWechatCipher()) : this(
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
        cipher,
    )

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    /**
     * The account is read on first use, not in the constructor: unwrapping the
     * token is Keystore IPC plus disk I/O, and this store is built from places
     * that run on the main thread (the settings card's `remember`, the job
     * runner's constructor). `@Volatile` keeps the first read visible to the
     * monitor thread, and the synchronized accessors below serialise it.
     */
    @Volatile
    private var accountRead = false

    @Volatile
    private var cachedAccount: WechatAccount? = null

    private var state: WechatState = readState()

    @Synchronized
    fun account(): WechatAccount? {
        if (!accountRead) {
            cachedAccount = readAccount()
            accountRead = true
        }
        return cachedAccount
    }

    @Synchronized
    fun saveAccount(value: WechatAccount) {
        // A different bot or owner is a different conversation: drop the old
        // cursor, context token and journal rather than replaying them into it.
        val sameAccount = account()?.let { it.ownerId == value.ownerId && it.botId == value.botId } == true
        if (!sameAccount) {
            state = WechatState(enabled = state.enabled)
            writeState(state)
        }
        val plain = json.encodeToString(WechatAccount.serializer(), value).toByteArray()
        prefs.edit().putString(KEY_ACCOUNT, Base64.encodeToString(cipher.encrypt(plain), Base64.NO_WRAP)).commit()
        cachedAccount = value
        accountRead = true
    }

    /** Unbind: the token, the cursor and every pending message go together. */
    @Synchronized
    fun clear() {
        cachedAccount = null
        accountRead = true
        state = WechatState()
        prefs.edit().remove(KEY_ACCOUNT).commit()
        writeState(state)
    }

    @Synchronized
    fun enabled(): Boolean = state.enabled

    @Synchronized
    fun setEnabled(value: Boolean) {
        val next = state.copy(enabled = value)
        writeState(next)
        state = next
    }

    @Synchronized
    fun needsRebind(): Boolean = state.needsRebind

    @Synchronized
    fun setNeedsRebind(value: Boolean) {
        val next = state.copy(needsRebind = value)
        writeState(next)
        state = next
    }

    @Synchronized
    fun cursor(): String = state.cursor

    @Synchronized
    fun saveCursor(value: String, expected: WechatAccount? = null) {
        if (expected != null && account() != expected) return
        val next = state.copy(cursor = value)
        writeState(next)
        state = next
    }

    @Synchronized
    fun contextToken(): String? = state.contextToken

    @Synchronized
    fun rememberContextToken(value: String?, expected: WechatAccount? = null) {
        if (expected != null && account() != expected) return
        if (value.isNullOrBlank() || state.contextToken == value) return
        val next = state.copy(contextToken = value)
        writeState(next)
        state = next
    }

    /** True when this iLink message id is already acknowledged or still queued. */
    @Synchronized
    fun hasMessage(sendId: String): Boolean =
        sendId in state.acknowledged || state.pending.any { it.sendId == sendId }

    /** Queue an event exactly once; false when it was already known. */
    @Synchronized
    fun journal(event: PendingWechatEvent): Boolean {
        if (hasMessage(event.sendId)) return false
        val next = state.copy(pending = state.pending + event)
        writeState(next)
        state = next
        return true
    }

    @Synchronized
    fun pending(): List<PendingWechatEvent> = state.pending

    @Synchronized
    fun acknowledge(sendId: String) {
        if (sendId !in state.acknowledged && state.pending.none { it.sendId == sendId }) return
        val next = state.copy(
            pending = state.pending.filterNot { it.sendId == sendId },
            acknowledged = (state.acknowledged.filterNot { it == sendId } + sendId).takeLast(MAX_ACKNOWLEDGED),
        )
        writeState(next)
        state = next
    }

    private fun readState(): WechatState =
        prefs.getString(KEY_STATE, null)?.let {
            runCatching { json.decodeFromString(WechatState.serializer(), it) }.getOrNull()
        } ?: WechatState()

    private fun readAccount(): WechatAccount? {
        val stored = prefs.getString(KEY_ACCOUNT, null) ?: return null
        return runCatching {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            json.decodeFromString(WechatAccount.serializer(), cipher.decrypt(bytes).decodeToString())
        }.getOrNull()
    }

    private fun writeState(value: WechatState) {
        prefs.edit().putString(KEY_STATE, json.encodeToString(WechatState.serializer(), value)).commit()
    }

    companion object {
        const val PREFS_NAME = "lunabot.wechat"

        /** Bounded so the state blob cannot grow without limit. */
        internal const val MAX_ACKNOWLEDGED = 256

        private const val KEY_ACCOUNT = "wechat.account"
        private const val KEY_STATE = "wechat.state"
    }
}
