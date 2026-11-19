package com.lunabot.companion.account

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** One Cloud desktop the account owns, as the control plane lists it. */
data class CloudMachine(
    val id: String,
    val name: String,
    val status: String,
    val origin: String?,
)

/** A one-time pairing code for one of the account's Clouds, minted by the control plane. */
data class CloudPairingGrant(
    val origin: String,
    val code: String,
    val expiresAt: Long,
)

/** Everything the Settings section draws. [codeSentTo] is set between "send the code" and a successful sign-in. */
data class CloudAccountUi(
    val phase: Phase = Phase.LOADING,
    val email: String? = null,
    val clouds: List<CloudMachine> = emptyList(),
    val busy: Boolean = false,
    val codeSentTo: String? = null,
    val error: String? = null,
) {
    enum class Phase { LOADING, SIGNED_OUT, SIGNED_IN }
}

/**
 * A refusal or failure worth showing, with the one bit the caller acts on:
 * whether the stored session is gone (clear it and ask to sign in again).
 */
class CloudAccountException(
    message: String,
    val unauthorized: Boolean = false,
) : Exception(message)

/**
 * The DEX Cloud companion control plane: email-code sign-in for a phone, the
 * installations the account owns, and the Cloud desktops it can open.
 *
 * This is the same account the desktop signs in with, so one address manages the
 * Mac, this phone, and any Cloud. Only `https://` is accepted; the app never
 * sends a password, because the server only ever asks for an eight-digit code.
 */
class CloudAccountApi(private val origin: String = CLOUD_ORIGIN) {
    init {
        require(origin.startsWith("https://")) { "DEX Cloud must be HTTPS." }
    }

    suspend fun sendCode(email: String) {
        val answer = call(
            "/api/auth/email-otp/send-verification-otp",
            "POST",
            JSONObject().put("type", "sign-in").put("email", email),
        )
        if (answer.status !in 200..299) throw problem(answer)
    }

    /** @return the `cps_` control session token. */
    suspend fun signIn(email: String, code: String): String {
        val answer = call(
            "/api/auth/sign-in/email-otp",
            "POST",
            JSONObject().put("email", email).put("otp", code),
        )
        if (answer.status !in 200..299) throw problem(answer)
        return answer.authToken ?: throw CloudAccountException("服务器没有返回登录令牌。")
    }

    suspend fun me(token: String): String {
        val answer = call("/v1/me", "GET", null, token)
        if (answer.status == 401) throw CloudAccountException("登录已过期，请重新登录。", unauthorized = true)
        if (answer.status !in 200..299) throw problem(answer)
        return answer.body?.optJSONObject("user")?.optString("email").orEmpty()
    }

    suspend fun clouds(token: String): List<CloudMachine> {
        val answer = call("/v1/clouds", "GET", null, token)
        if (answer.status == 401) throw CloudAccountException("登录已过期，请重新登录。", unauthorized = true)
        if (answer.status !in 200..299) throw problem(answer)
        val list = answer.body?.optJSONArray("clouds") ?: return emptyList()
        return buildList {
            for (index in 0 until list.length()) {
                val row = list.optJSONObject(index) ?: continue
                val id = row.optString("id")
                if (id.isBlank()) continue
                add(
                    CloudMachine(
                        id = id,
                        name = row.optString("name").ifBlank { "My Cloud" },
                        status = row.optString("status").ifBlank { "unknown" },
                        origin = row.optString("origin").takeIf { it.isNotBlank() },
                    ),
                )
            }
        }
    }

    /** Registers this phone so the desktop's device list shows it. Best effort: sign-in stands if it fails. */
    suspend fun registerInstallation(token: String, clientInstanceId: String, name: String, appVersion: String) {
        val answer = call(
            "/v1/installations",
            "POST",
            JSONObject()
                .put("clientInstanceId", clientInstanceId)
                .put("name", name)
                .put("platform", "android")
                .put("appVersion", appVersion)
                .put("kind", "phone"),
            token,
        )
        if (answer.status !in 200..299) throw problem(answer)
    }

    /** A one-time pairing code for one of this account's Clouds. The phone redeems
     * it against [CloudPairingGrant.origin] with the ordinary pairing flow. */
    suspend fun pairCloud(token: String, cloudId: String): CloudPairingGrant {
        val answer = call("/v1/clouds/$cloudId/pairing", "POST", JSONObject(), token)
        if (answer.status == 401) throw CloudAccountException("登录已过期，请重新登录。", unauthorized = true)
        if (answer.status == 404) throw CloudAccountException("这台云电脑已不在账号下。")
        if (answer.status == 409) throw CloudAccountException("云电脑还没就绪，稍后再试。")
        if (answer.status !in 200..299) throw problem(answer)
        val body = answer.body ?: throw CloudAccountException("服务器没有返回配对信息。")
        val origin = body.optString("origin").takeIf { it.startsWith("https://") }
            ?: throw CloudAccountException("服务器没有返回云电脑地址。")
        val code = body.optString("code").takeIf { it.matches(CODE_3X4) }
            ?: throw CloudAccountException("服务器返回的配对码无效。")
        val expiresAt = body.optLong("expiresAt")
        if (expiresAt <= 0) throw CloudAccountException("服务器返回的配对码没有有效期。")
        return CloudPairingGrant(origin = origin, code = code, expiresAt = expiresAt)
    }

    suspend fun signOut(token: String) {
        call("/api/auth/sign-out", "POST", JSONObject(), token)
    }

    private data class Answer(val status: Int, val body: JSONObject?, val authToken: String?)

    private suspend fun call(
        path: String,
        method: String,
        payload: JSONObject?,
        token: String? = null,
    ): Answer = withContext(Dispatchers.IO) {
        val url = URL(origin + path)
        val connection = url.openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("accept", "application/json")
            token?.let { connection.setRequestProperty("authorization", "Bearer $it") }
            if (payload != null) {
                connection.doOutput = true
                connection.setRequestProperty("content-type", "application/json")
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            val body = text.takeIf { it.isNotBlank() }?.let { runCatching { JSONObject(it) }.getOrNull() }
            Answer(status, body, connection.getHeaderField("set-auth-token"))
        } catch (error: CloudAccountException) {
            throw error
        } catch (error: Exception) {
            throw CloudAccountException("连不上 DEX Cloud，请检查网络后重试。")
        } finally {
            connection.disconnect()
        }
    }

    private fun problem(answer: Answer): CloudAccountException {
        val code = answer.body?.optString("error").orEmpty()
        val message = when {
            answer.status == 429 || code == "request_limited" -> "请求太频繁，请稍后再试。"
            answer.status == 401 || answer.status == 403 || code == "invalid_code" -> "登录码不正确或已过期。"
            code == "signup_closed" -> "这个服务器暂不开放新账号。"
            code == "email_unavailable" -> "服务器暂时发不了邮件，请稍后再试。"
            answer.status in 400..499 -> "请求没有被接受，请检查邮箱或登录码。"
            else -> "DEX Cloud 暂时不可用（${answer.status}）。"
        }
        return CloudAccountException(message, unauthorized = answer.status == 401)
    }

    companion object {
        const val CLOUD_ORIGIN = "https://cloud.dexai.vip"
        private const val TIMEOUT_MS = 15_000
        private val CODE_3X4 = Regex("^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$")
    }
}

/**
 * The control session, Keystore-encrypted and device-only, in its own file so a
 * cleared pairing never touches the DEX account and vice versa.
 */
class CloudAccountStore(context: Context) {
    private val appContext = context.applicationContext
    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    suspend fun token(): String? = withContext(Dispatchers.IO) {
        prefs.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }
    }

    suspend fun save(token: String, email: String) = withContext(Dispatchers.IO) {
        // KTX's edit(commit = true) hides commit()'s boolean, so the read-back
        // is what proves the session landed before a request relies on it.
        prefs.edit(commit = true) {
            putString(KEY_TOKEN, token)
            putString(KEY_EMAIL, email)
        }
        check(prefs.getString(KEY_TOKEN, null) == token) {
            "The DEX account session write did not land."
        }
    }

    suspend fun clear() = withContext(Dispatchers.IO) {
        prefs.edit(commit = true) {
            remove(KEY_TOKEN)
            remove(KEY_EMAIL)
        }
    }

    /** Stable for this install; the server keys the installation row on it. */
    suspend fun clientInstanceId(): String = withContext(Dispatchers.IO) {
        prefs.getString(KEY_CLIENT, null)?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString().also {
            prefs.edit(commit = true) { putString(KEY_CLIENT, it) }
            check(prefs.getString(KEY_CLIENT, null) == it) { "The install id write did not land." }
        }
    }

    companion object {
        const val PREFS_NAME = "dex_cloud_account"
        private const val KEY_TOKEN = "session"
        private const val KEY_EMAIL = "email"
        private const val KEY_CLIENT = "client_instance"
    }
}

/**
 * Sign-in and the account's Cloud list, app-scoped like [Session]: leaving
 * Settings during a request must not cancel it.
 */
class CloudAccountController(
    private val api: CloudAccountApi,
    private val store: CloudAccountStore,
    private val scope: CoroutineScope,
    private val deviceName: String,
    private val appVersion: String,
) {
    private val _state = MutableStateFlow(CloudAccountUi())
    val state: StateFlow<CloudAccountUi> = _state.asStateFlow()

    /** Reads the stored session once at launch. */
    fun start() {
        scope.launch { restore() }
    }

    fun refresh() {
        scope.launch {
            val token = storedToken() ?: run {
                _state.value = CloudAccountUi(phase = CloudAccountUi.Phase.SIGNED_OUT)
                return@launch
            }
            _state.update { it.copy(busy = true, error = null) }
            load(token)
        }
    }

    fun sendCode(email: String) {
        val address = email.trim().lowercase()
        if (!EMAIL.matches(address)) {
            _state.update { it.copy(error = "请输入有效的邮箱地址。") }
            return
        }
        scope.launch {
            _state.update { it.copy(busy = true, error = null) }
            try {
                api.sendCode(address)
                _state.update { it.copy(busy = false, codeSentTo = address, phase = CloudAccountUi.Phase.SIGNED_OUT) }
            } catch (error: CloudAccountException) {
                _state.update { it.copy(busy = false, error = error.message) }
            }
        }
    }

    fun verify(code: String) {
        val email = _state.value.codeSentTo
        if (email == null) {
            _state.update { it.copy(error = "请先发送登录码。") }
            return
        }
        if (!CODE.matches(code.trim())) {
            _state.update { it.copy(error = "登录码是 8 位数字。") }
            return
        }
        scope.launch {
            _state.update { it.copy(busy = true, error = null) }
            try {
                val token = api.signIn(email, code.trim())
                // A Keystore that cannot be opened (a restored device, a
                // locked credential store) must report that, not leave the
                // person signed in for this process only or crash the scope.
                val saved = runCatching { store.save(token, email) }
                if (saved.isFailure) {
                    _state.update {
                        it.copy(busy = false, error = "无法在此手机上安全保存登录信息。")
                    }
                    return@launch
                }
                runCatching {
                    api.registerInstallation(token, store.clientInstanceId(), deviceName, appVersion)
                }
                load(token, justSignedIn = true)
            } catch (error: CloudAccountException) {
                _state.update { it.copy(busy = false, error = error.message) }
            }
        }
    }

    fun signOut() {
        scope.launch {
            val token = storedToken()
            runCatching { store.clear() }
            _state.value = CloudAccountUi(phase = CloudAccountUi.Phase.SIGNED_OUT)
            if (token != null) runCatching { api.signOut(token) }
        }
    }

    /** A result line the section shows without changing phase (opening a Cloud, for example). */
    fun report(message: String?) {
        _state.update { it.copy(error = message) }
    }

    fun clearError() {
        _state.update { it.copy(error = null) }
    }

    /** Mints a one-time pairing code for [cloud]; null (with the section's error
     * set) when the account session is gone or the server refused. The caller
     * redeems the grant with the ordinary pairing flow. */
    suspend fun pairCloud(cloud: CloudMachine): CloudPairingGrant? {
        val token = storedToken() ?: run {
            _state.update { it.copy(error = "请先登录 DEX 账号。") }
            return null
        }
        _state.update { it.copy(busy = true, error = null) }
        return try {
            val grant = api.pairCloud(token, cloud.id)
            _state.update { it.copy(busy = false) }
            grant
        } catch (error: CloudAccountException) {
            if (error.unauthorized) {
                runCatching { store.clear() }
                _state.value = CloudAccountUi(phase = CloudAccountUi.Phase.SIGNED_OUT, error = error.message)
            } else {
                _state.update { it.copy(busy = false, error = error.message) }
            }
            null
        }
    }

    /**
     * The stored session, or null when the Keystore cannot be opened.
     *
     * Losing the Keystore means this install has no usable session; it is not
     * a reason to take the process down at launch. The person signs in again,
     * which is the same recovery the token store asks for.
     */
    private suspend fun storedToken(): String? =
        runCatching { store.token() }.getOrNull()

    private suspend fun restore() {
        val token = storedToken()
        if (token == null) {
            _state.value = CloudAccountUi(phase = CloudAccountUi.Phase.SIGNED_OUT)
            return
        }
        _state.update { it.copy(busy = true, phase = CloudAccountUi.Phase.LOADING) }
        load(token)
    }

    private suspend fun load(token: String, justSignedIn: Boolean = false) {
        try {
            val email = api.me(token).ifBlank { _state.value.email.orEmpty() }
            val clouds = api.clouds(token)
            val codeSentTo = if (justSignedIn) null else _state.value.codeSentTo
            _state.value = CloudAccountUi(
                phase = CloudAccountUi.Phase.SIGNED_IN,
                email = email,
                clouds = clouds,
                busy = false,
                codeSentTo = codeSentTo,
            )
        } catch (error: CloudAccountException) {
            if (error.unauthorized) {
                runCatching { store.clear() }
                _state.value = CloudAccountUi(
                    phase = CloudAccountUi.Phase.SIGNED_OUT,
                    error = error.message,
                )
            } else {
                _state.update { it.copy(busy = false, error = error.message) }
            }
        }
    }

    companion object {
        private val EMAIL = Regex("^[^\\s@<>()\\[\\]\\\\,;:\"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")
        private val CODE = Regex("^\\d{8}$")
    }
}
