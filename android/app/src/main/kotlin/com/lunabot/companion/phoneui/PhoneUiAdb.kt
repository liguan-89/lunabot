package com.lunabot.companion.phoneui

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.ssl.SSLSockets
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.core.content.edit
import com.lunabot.companion.core.phoneui.adb.AdbConnection
import com.lunabot.companion.core.phoneui.adb.AdbIdentity
import com.lunabot.companion.core.phoneui.adb.AdbKeyUnreadableException
import com.lunabot.companion.core.phoneui.adb.AdbTls
import com.lunabot.companion.core.phoneui.adb.KeyingMaterialExporter
import com.lunabot.companion.core.phoneui.adb.AdbPairing
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.net.NetworkInterface
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.SSLException

internal interface PhoneUiKeyStore {
    fun read(): ByteArray?
    fun write(pkcs8: ByteArray)
    fun clear()
}

internal class PhoneUiAdb(context: Context) {
    private val app = context.applicationContext
    private val keyStore = KeystoreAdbKeyStore(app)
    @Volatile private var cachedIdentity: AdbIdentity? = null
    private val tlsExporter = KeyingMaterialExporter { socket, label, length ->
        SSLSockets.exportKeyingMaterial(socket, label, ByteArray(0), length)
            ?: throw SSLException("TLS keying material export failed")
    }

    fun pairingIdentity(): AdbIdentity = identity(forPairing = true)

    internal fun markPaired(paired: Boolean) {
        if (paired) pairedPrefs.edit(commit = true) { putBoolean(PAIRED_FLAG, true) }
        else pairedPrefs.edit(commit = true) { remove(PAIRED_FLAG) }
    }

    internal fun isPaired(): Boolean = pairedPrefs.getBoolean(PAIRED_FLAG, false)

    private val pairedPrefs by lazy { app.getSharedPreferences(PAIRED_PREFS, Context.MODE_PRIVATE) }

    private fun identity(forPairing: Boolean): AdbIdentity = cachedIdentity ?: synchronized(this) {
        cachedIdentity ?: run {
            val stored = try {
                keyStore.read()
            } catch (error: AdbKeyUnreadableException) {
                if (!forPairing) throw error
                keyStore.clear()
                null
            }
            val loaded = if (stored != null) {
                try {
                    AdbIdentity.fromPkcs8(stored, adbName())
                } catch (error: AdbKeyUnreadableException) {
                    if (!forPairing) throw error
                    keyStore.clear()
                    AdbIdentity.generate(adbName()).also { keyStore.write(it.keyPair.private.encoded) }
                }
            } else {
                AdbIdentity.generate(adbName()).also { keyStore.write(it.keyPair.private.encoded) }
            }
            loaded.also { cachedIdentity = it }
        }
    }

    private fun adbName(): String = "lunabot@${Build.MODEL.orEmpty()}"

    fun hasIdentity(): Boolean {
        if (cachedIdentity != null) return true
        return runCatching { keyStore.read() != null }.getOrDefault(false)
    }

    fun pair(host: String, port: Int, code: String) {
        AdbPairing(AdbTls(identity(forPairing = true), tlsExporter)).pair(host, port, code)
    }

    suspend fun findPairingPort(timeoutMs: Long = 2_500): Int? =
        findServicePort("_adb-tls-pairing._tcp.", timeoutMs)

    suspend fun findConnectPort(timeoutMs: Long = 2_500): Int? =
        findServicePort("_adb-tls-connect._tcp.", timeoutMs)

    private suspend fun findServicePort(serviceType: String, timeoutMs: Long): Int? {
        val manager = app.getSystemService(NsdManager::class.java) ?: return null
        val found = Channel<NsdServiceInfo>(Channel.UNLIMITED)
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { found.close() }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) { found.trySend(serviceInfo) }
        }
        runCatching { manager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener) }
            .onFailure { found.close() }
        return try {
            withTimeoutOrNull(timeoutMs) {
                while (true) {
                    val service = found.receiveCatching().getOrNull() ?: return@withTimeoutOrNull null
                    val port = resolveLocal(manager, service) ?: continue
                    return@withTimeoutOrNull port
                }
                @Suppress("UNREACHABLE_CODE") null
            }
        } finally {
            runCatching { manager.stopServiceDiscovery(listener) }
            found.close()
        }
    }

    fun connect(port: Int) = AdbConnection.open("127.0.0.1", port, AdbTls(identity(forPairing = false), tlsExporter))

    fun exec(port: Int, command: String, nonce: String, awaitHandoff: () -> Boolean) {
        val connection = AdbConnection.open("127.0.0.1", port, AdbTls(identity(forPairing = false), tlsExporter))
        connection.use {
            val stream = it.exec(command)
            stream.use { opened ->
                opened.write("$nonce\n".toByteArray(Charsets.UTF_8))
                val draining = Thread({ runCatching { opened.readAll() } }, "phoneui-adb-output").apply {
                    isDaemon = true
                    start()
                }
                try {
                    check(awaitHandoff()) { "Phone helper did not connect." }
                } finally {
                    opened.close()
                    draining.join(1_000)
                }
            }
        }
    }

    fun forget() {
        cachedIdentity = null
        keyStore.clear()
    }

    private suspend fun resolveLocal(manager: NsdManager, service: NsdServiceInfo): Int? {
        val answer = Channel<NsdServiceInfo>(1)
        @Suppress("DEPRECATION")
        manager.resolveService(service, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { answer.close() }
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) { answer.trySend(serviceInfo) }
        })
        val resolved = withTimeoutOrNull(1_500) { answer.receiveCatching().getOrNull() } ?: return null
        @Suppress("DEPRECATION")
        val host = resolved.host ?: return null
        val local = host.isLoopbackAddress || runCatching {
            NetworkInterface.getNetworkInterfaces().asSequence().any { iface ->
                iface.inetAddresses.asSequence().any { it == host }
            }
        }.getOrDefault(false)
        return resolved.port.takeIf { local && it in 1..65535 }
    }

    private class KeystoreAdbKeyStore(context: Context) : PhoneUiKeyStore {
        private val app = context.applicationContext

        override fun read(): ByteArray? {
            if (!file.isFile) return null
            return try {
                val bytes = file.readBytes()
                val ivLength = bytes.firstOrNull()?.toInt()?.and(0xff) ?: error("empty key file")
                require(ivLength in 12..16 && bytes.size > ivLength + 1)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, wrappingKey(create = false), GCMParameterSpec(128, bytes.copyOfRange(1, 1 + ivLength)))
                cipher.doFinal(bytes, 1 + ivLength, bytes.size - 1 - ivLength)
            } catch (error: Exception) {
                throw AdbKeyUnreadableException("Cannot decrypt the saved Wireless debugging identity.", error)
            }
        }

        override fun write(pkcs8: ByteArray) {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(create = true))
            val iv = cipher.iv
            val encrypted = byteArrayOf(iv.size.toByte()) + iv + cipher.doFinal(pkcs8)
            file.parentFile?.mkdirs()
            val temp = File(file.parentFile, file.name + ".tmp")
            temp.writeBytes(encrypted)
            check(temp.renameTo(file)) { "Could not persist the Wireless debugging identity." }
        }

        override fun clear() {
            file.delete()
            runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY_ALIAS) }
        }

        private fun wrappingKey(create: Boolean): SecretKey {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
            if (!create) throw AdbKeyUnreadableException("The Wireless debugging key wrapper is missing.")
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(
                    KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
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

        private val file by lazy { File(app.noBackupFilesDir, "phoneui/adbkey.bin") }

        private companion object {
            const val KEY_ALIAS = "dexbot_phoneui_adb_wrap"
        }
    }

    private companion object {
        const val AdbServiceType = "_adb-tls-connect._tcp."
        const val PAIRED_PREFS = "lunabot.phoneui.adb"
        const val PAIRED_FLAG = "paired"
    }
}
