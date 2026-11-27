package com.lunabot.companion.core

import java.net.URI
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient

/** 语音消息转写结果；unavailable 只表示电脑或服务不可用，不代表没听清。 */
data class VoiceTranscription(
    val text: String?,
    val unavailable: Boolean,
)

sealed interface SecretCardProvideResult {
    data object Submitted : SecretCardProvideResult
    data class Rejected(val message: String) : SecretCardProvideResult
    data class Uncertain(val message: String) : SecretCardProvideResult
    data class Blocked(val message: String) : SecretCardProvideResult
    data object Unavailable : SecretCardProvideResult
}

/**
 * Stream lifecycle, pairing restore, and actions — port of `ios/App/Session.swift`.
 *
 * Pure JVM: storage, device name, notifications, and HTTP are injected so the
 * state machine can be unit-tested with virtual time (`kotlinx-coroutines-test`).
 */
class Session(
    private val scope: CoroutineScope,
    private val connectionStore: ConnectionStore,
    private val tokenStore: TokenStore,
    /**
     * The durable first-pair education marker. Deliberately has no default: the
     * marker is only useful if it outlives the process, and a default would let
     * a wiring slip in `OpenMausApp` silently swap durability for an in-memory
     * boolean that dies with the app — the exact failure the marker exists to
     * prevent, and one no runtime assertion would ever notice.
     */
    private val onboardingStore: OnboardingStore,
    private val deviceNameProvider: () -> String,
    private val notificationSink: NotificationSink = NoOpNotificationSink,
    private val httpClient: OkHttpClient = OkHttpClient(),
    /** Which of a pairing's routes this phone may open a socket to right now; read again on every walk. */
    private val routeAccess: RouteAccess = RouteAccess.ALL,
    private val clientFactory: (Connection, String?) -> CompanionClient = { connection, token ->
        CompanionClient(connection, token, httpClient, routeAccess = routeAccess)
    },
    private val pairFn: suspend (Connection, String, String, String) -> PairingOutcome =
        { connection, credential, deviceName, pairRequestId ->
            CompanionClient.pairFirstReachable(
                connection = connection,
                credential = credential,
                deviceName = deviceName,
                pairRequestId = pairRequestId,
                client = httpClient,
                routeAccess = routeAccess,
            )
        },
    /** Test seam: override the SSE Flow without subclassing [CompanionClient]. */
    private val eventsFn: (CompanionClient, String?, Boolean) -> Flow<StreamFrame> = { client, since, screens ->
        client.events(since, screens)
    },
    /** Test seam: override fleet hydrate. */
    private val hydrateFn: suspend (CompanionClient, Int?) -> Fleet = { client, messages ->
        client.fleet(messages)
    },
    /** Test seam: override the engine list read for composer wording. */
    private val instancesFn: suspend (CompanionClient) -> List<Instance> = { client ->
        client.instances()
    },
    /** Test seam: override the authenticated endpoint snapshot. */
    private val metadataFn: suspend (CompanionClient) -> CompanionConnectionMetadata = { client ->
        client.connectionMetadata()
    },
    /** Test seam for the handoff between a completed transfer and its caller. */
    private val afterAttachmentDownload: suspend () -> Unit = {},
    /**
     * The offline roster cache. [hydrate] writes the fetched fleet here —
     * message-bounded — and every restore path reads it back, so a launch that
     * cannot reach the computer still shows the roster it showed minutes ago
     * ([rosterSnapshotAt] says how old). Deliberately last in the list and
     * defaulted to a process-memory store: existing call sites keep compiling,
     * and only wiring that passes a durable store makes the cache survive a
     * relaunch. Every failure of this store is survivable by contract — the
     * cache is an amenity, never a precondition for a pairing.
     */
    private val rosterSnapshotStore: RosterSnapshotStore = InMemoryRosterSnapshotStore(),
    /** Test seam: the presence throttle reads its clock from here. */
    private val nowFn: () -> Long = { System.currentTimeMillis() },
) {
    sealed interface Status {
        data object Unpaired : Status
        data object Connecting : Status
        data object Live : Status
        data object Unauthorized : Status
        /** The computer refused this app version: only an update can connect. */
        data object OutdatedApp : Status
        /**
         * [hint] is the next step the failure has, when it has one: a stored
         * address that is gone needs a new address, a dropped socket only
         * needs the retry already running. Settings shows it under the
         * message rather than in the 连接状态 row, which is one line.
         */
        data class Offline(val message: String, val hint: String? = null) : Status
    }

    sealed interface RestoreState {
        data object Pending : RestoreState
        data object Ready : RestoreState
        data object Unpaired : RestoreState
    }

    private val _state = MutableStateFlow(CompanionState())
    val state: StateFlow<CompanionState> = _state.asStateFlow()

    /**
     * Engines that can take a message INTO a turn that is already running.
     * Loaded once per hydrate and only ever used to word the composer: an
     * empty set means "we do not know", and the wording falls back to the
     * weaker promise, which is the one that is always true.
     */
    private val _steeringInstanceIds = MutableStateFlow<Set<String>>(emptySet())
    val steeringInstanceIds: StateFlow<Set<String>> = _steeringInstanceIds.asStateFlow()

    private val _connection = MutableStateFlow<Connection?>(null)
    val connection: StateFlow<Connection?> = _connection.asStateFlow()

    /**
     * The exact client connection carrying traffic now; unlike [connection],
     * it follows route failover before promotion is persisted.
     */
    private val _transportConnection = MutableStateFlow<Connection?>(null)
    val transportConnection: StateFlow<Connection?> = _transportConnection.asStateFlow()

    private val _connections = MutableStateFlow<List<Connection>>(emptyList())
    /** All locally paired computers. Only [connection] has an active runtime. */
    val connections: StateFlow<List<Connection>> = _connections.asStateFlow()

    private val _status = MutableStateFlow<Status>(Status.Unpaired)
    val status: StateFlow<Status> = _status.asStateFlow()

    private val _restoreState = MutableStateFlow<RestoreState>(RestoreState.Pending)
    val restoreState: StateFlow<RestoreState> = _restoreState.asStateFlow()

    /**
     * When the sidebar is showing the offline roster cache: the moment that
     * snapshot was saved, or null while live data leads. Null does not mean
     * "empty" — it means what is on screen came from the computer just now.
     */
    private val _rosterSnapshotAt = MutableStateFlow<Long?>(null)
    val rosterSnapshotAt: StateFlow<Long?> = _rosterSnapshotAt.asStateFlow()

    /**
     * One emission per `device.job` frame. The frame names the computer's own
     * key for this phone, which the phone does not otherwise know, so it is a
     * wake signal and nothing more: the poll asks for the job.
     */
    private val _deviceJobNudge = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val deviceJobNudge: SharedFlow<Unit> = _deviceJobNudge.asSharedFlow()

    /** A tool server changed on the desktop; the MCP card reloads. */
    private val _mcpChanged = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val mcpChanged: SharedFlow<Unit> = _mcpChanged.asSharedFlow()

    /** The computer lease changed, possibly from another device. */
    private val _computerControl = MutableSharedFlow<Frame.ComputerControl>(extraBufferCapacity = 8)
    val computerControl: SharedFlow<Frame.ComputerControl> = _computerControl.asSharedFlow()

    /** A Live call started or ended on the desktop. */
    private val _liveCall = MutableSharedFlow<Frame.LiveCall>(extraBufferCapacity = 8)
    val liveCall: SharedFlow<Frame.LiveCall> = _liveCall.asSharedFlow()

    /** 实时到达且可自动朗读的 bot 语音事件；无 replay，订阅晚到就不补读。 */
    private val _botReplySpeechEvents = MutableSharedFlow<BotReplySpeechEvent>(extraBufferCapacity = 32)
    val botReplySpeechEvents: SharedFlow<BotReplySpeechEvent> = _botReplySpeechEvents.asSharedFlow()

    private val _actionError = MutableStateFlow<String?>(null)
    var actionError: String?
        get() = _actionError.value
        set(value) { _actionError.value = value }
    val actionErrorFlow: StateFlow<String?> = _actionError.asStateFlow()

    private val _focusedMessageId = MutableStateFlow<String?>(null)
    val focusedMessageId: StateFlow<String?> = _focusedMessageId.asStateFlow()

    private val _pairingInvite = MutableStateFlow<PairingInvite?>(null)
    val pairingInvite: StateFlow<PairingInvite?> = _pairingInvite.asStateFlow()

    private val _pairingRequested = MutableStateFlow(false)
    /** Pairing may be opened while the current computer stays live. */
    val pairingRequested: StateFlow<Boolean> = _pairingRequested.asStateFlow()

    private var registry = ConnectionRegistry()
    private var client: CompanionClient? = null
        set(value) {
            // Capability belongs to a computer, not a connection: a swapped
            // client must not answer with the previous one's cache.
            if (field !== value) liveCallRelayCapable = null
            field = value
            _transportConnection.value = value?.connection
        }
    private var token: String? = null
    private var rotation = CandidateRotation(emptyList())
    private var streamJob: Job? = null
    private var endpointRefreshJob: Job? = null
    private var streamGeneration = 0
    private var reconnectDelaySeconds: Long = 0
    private var screenWatchers = 0
    private val gate = Mutex()
    private val notificationGate = Mutex()
    private val attachmentDownloads = AttachmentDownloadCache(scope)
    private val restored = CompletableDeferred<Unit>()
    /** QR credentials authoritatively rejected or redeemed — never start a new request (§6). */
    private val spentQrCredentials = mutableSetOf<String>()

    /**
     * One pairing attempt at a time, plus the invite that arrived during it.
     *
     * [gate] already serialises the redemption, but it is a suspending Mutex and
     * a deep link lands synchronously on whatever thread delivered the Intent.
     * This monitor is the one both sides can hold, so "an attempt is in flight",
     * "an invite is waiting", and the published invite are read and written as a
     * single decision.
     */
    private val inviteLock = Any()
    private var pairingInFlight = false
    private var deferredInvite: PairingInvite? = null

    init {
        // No Exception other than cancellation leaves this launch: it is a root
        // coroutine with no caller to catch for it, so [restoreLocked] reports a
        // failed read instead of throwing it. An Error still propagates, on
        // purpose — a fatal one is not this boundary's to swallow.
        scope.launch {
            try {
                restore()
            } finally {
                restored.complete(Unit)
            }
        }
    }

    /** Wait until the launch-time restore attempt has finished (tests / connect). */
    suspend fun awaitRestored() {
        restored.await()
    }

    /** Rebuild the last connection at launch — three outcomes match iOS Keychain restore. */
    private suspend fun restore() = gate.withLock {
        restoreLocked()
    }

    /**
     * Redeem a one-time pairing credential. Persists only the long-lived device
     * token + connection — never the QR credential/code.
     *
     * A paired phone may add another computer. The active runtime is only
     * replaced after the new credential has committed; another [pair] still
     * cannot overlap this redeem+persist critical section.
     *
     * A route failure is retryable with the same in-memory request id because
     * it is either preflight-only or an ambiguous replay of the same logical
     * redemption. An authoritative response, or receiving the durable token,
     * burns a high-entropy QR before any local save. Six-digit codes remain
     * retryable for compatibility with manual pairing.
     *
     * This is also the one active attempt: from the moment it is marked in
     * flight until [settlePairingAttempt], a deep link waits in memory rather
     * than replacing the credential being redeemed.
     */
    suspend fun pair(
        connection: Connection,
        credential: String,
        pairRequestId: String = UUID.randomUUID().toString(),
    ) {
        awaitRestored()
        gate.withLock {
            if (pairingInFlight) throw PairingInProgressException()
            // An unsafe address has not submitted the code. Let the user correct it and retry.
            if (PairingInvite.normalizedServerCode(credential) != null) connection.requireServerTransport()
            if (isQrCredential(credential) && credential in spentQrCredentials) {
                _actionError.value = SPENT_QR_MESSAGE
                clearInviteIfCredential(credential)
                throw SpentPairingCredentialException()
            }

            // From here this is *the* active attempt. A deep link that arrives
            // now waits in memory instead of taking over the credential slot.
            synchronized(inviteLock) { pairingInFlight = true }
            try {
                val qr = isQrCredential(credential)
                val deviceName = deviceNameProvider()
                // A parsed QR already carries this policy. Manual/discovered entry establishes the
                // same boundary here, before pairFirstReachable can probe or redeem on any route.
                val invited = if (connection.allowedRouteKinds == null) {
                    connection.establishingRoutePolicyFromInvite()
                } else {
                    connection
                }
                val (pairedConnection, pairedToken) = try {
                    redeemPairing(invited, credential, deviceName, pairRequestId)
                } catch (error: Throwable) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    val routeFailure = error is PairingRouteError || error is ServerPairingRetryError
                    if (qr && !routeFailure) burnQrCredential(credential)
                    _actionError.value = if (qr && !routeFailure) qrFailureMessage(error) else pairingFailureText(error)
                    throw error
                }
                if (qr) burnQrCredential(credential)
                var stored = pairedConnection
                val winner = stored.activeEndpoint
                    ?: CompanionEndpoint.direct(stored.host, stored.port, priority = 10_000)
                registry.matchingConnection(stored)?.let { existing -> stored = stored.copy(id = existing.id) }
                val firstPairing = registry.connections.isEmpty()
                val updatedRegistry = registry.upsert(stored)

                try {
                    tokenStore.save(stored.id, pairedToken)
                    // The education marker goes down before the connection
                    // becomes restorable. A process that stops between the two
                    // leaves an orphan marker, which the router ignores while
                    // unpaired; the reverse order would leave a restorable
                    // pairing that skips first-pair education for good.
                    PairingCommitSequence.persist(
                        markNotificationOnboardingPending = {
                            if (firstPairing) onboardingStore.setNotificationOnboardingPending(true)
                        },
                        saveConnection = { connectionStore.saveRegistry(updatedRegistry) },
                    )
                } catch (error: Throwable) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    _actionError.value = if (qr) qrFailureMessage(error) else pairingFailureText(error)
                    throw error
                }

                stopActiveRuntimeLocked()
                registry = updatedRegistry
                _connections.value = registry.connections
                _connection.value = stored
                token = pairedToken
                // The route that just redeemed leads this session; later launches return to the
                // desktop's security-prioritized typed order.
                rotation = CandidateRotation(liveRoutes(stored, winner))
                client = clientFactory(stored, pairedToken)
                _state.value = CompanionState()
                _restoreState.value = RestoreState.Ready
                _pairingRequested.value = false
            } finally {
                settlePairingAttempt()
            }
        }
        connect()
    }

    private suspend fun redeemPairing(
        invited: Connection,
        credential: String,
        deviceName: String,
        requestId: String,
    ): Pair<Connection, String> {
        // A pairing link that carries the e2e descriptor is redeemed inside the
        // encrypted tunnel: the credential is the pre-shared key, so the relay
        // never sees it and there is no plain fallback (spec §3).
        val e2eDescriptor = invited.e2eDescriptor
        if (e2eDescriptor != null) {
            val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                com.lunabot.companion.core.e2e.E2ePairing.pair(
                    connector = com.lunabot.companion.core.e2e.OkHttpE2eConnector(httpClient),
                    descriptor = e2eDescriptor,
                    credential = credential,
                    deviceName = deviceName,
                    app = "lunabot-android",
                    directWsUrl = invited.e2eDirectUrl(routeAccess),
                    pairRequestId = requestId,
                )
            }
            var stored = invited.copy(
                name = result.serverName?.takeIf { it.isNotEmpty() } ?: invited.name,
                allowedRouteKinds = invited.allowedRouteKinds,
                allowedLocalRouteURLs = invited.allowedLocalRouteURLs,
                // The computer's own descriptor wins; the pinned QR value stays otherwise.
                e2e = result.descriptor?.encode() ?: invited.e2e,
                companionDeviceId = result.deviceId ?: invited.companionDeviceId,
            )
            // The routes it advertises for this device, under the consent the QR already carried — the same rule the
            // plain pairing path applies. Without them a relay-only QR or a server pairing learns no direct route.
            stored = stored.applyingPairingAdvertisement(result.hosts, result.endpoints)
            return stored to result.token
        }
        val serverCode = PairingInvite.normalizedServerCode(credential)
        if (serverCode != null) {
            val descriptor: ServerEnvironment
            val paired: ServerPairResponse
            try {
                descriptor = CompanionClient(invited, null, httpClient).environment()
                paired = CompanionClient.pairWithServer(invited, serverCode, deviceName, requestId, httpClient)
            } catch (error: java.io.IOException) {
                if (error is APIError.Status && error.code < 500 && error.code != 429) throw error
                throw ServerPairingRetryError(error)
            }
            check(paired.environment.environmentId == descriptor.environmentId) {
                "配对期间服务器发生了变化。请扫描新的二维码后重试。"
            }
            return invited.copy(
                name = paired.environment.label.ifEmpty { invited.name },
                serverEnvironmentId = paired.environment.environmentId,
                serverScopes = paired.session.scopes,
            ) to paired.token
        }
        // Probing a route the platform refuses costs its whole timeout and cannot succeed. The credential stays
        // retryable: the next attempt reads the grant again.
        if (invited.usesLocalNetwork && invited.dialableEndpoints(routeAccess).isEmpty()) {
            throw PairingRouteError(emptyList(), LocalNetworkRefused.PAIR + LocalNetworkRefused.SETTINGS)
        }
        val outcome = pairFn(invited, credential, deviceName, requestId)
        val paired = outcome.response
        var stored = outcome.connection.copy(
            allowedRouteKinds = invited.allowedRouteKinds,
            allowedLocalRouteURLs = invited.allowedLocalRouteURLs,
            secretPublicKey = invited.secretPublicKey,
            companionDeviceId = paired.device.id,
        )
        if (paired.serverName.isNotEmpty()) stored = stored.copy(name = paired.serverName)
        stored = stored.applyingPairingAdvertisement(paired.hosts, paired.endpoints)
        val winner = outcome.connection.activeEndpoint
            ?: CompanionEndpoint.direct(outcome.connection.host, outcome.connection.port, priority = 10_000)
        stored = winner?.let(stored::promoting) ?: stored.promoting(stored.host)
        return stored to paired.token
    }

    suspend fun pair(
        invite: PairingInvite,
        pairRequestId: String = UUID.randomUUID().toString(),
    ) = pair(invite.connection, invite.credential, pairRequestId)

    /**
     * Accept a deep-link invite after restore has settled. A paired phone can
     * add another computer; the current runtime remains intact until that
     * invitation commits successfully.
     */
    fun receivePairingURL(url: String) {
        if (restored.isCompleted) {
            acceptPairingURL(url)
            return
        }
        scope.launch {
            restored.await()
            acceptPairingURL(url)
        }
    }

    fun receivePairingURI(uri: URI) = receivePairingURL(uri.toString())

    /** The screen took the published invite. A waiting one is not touched. */
    fun consumePairingInvite() = synchronized(inviteLock) {
        _pairingInvite.value = null
    }

    fun beginPairing() {
        _pairingRequested.value = true
    }

    fun endPairing() {
        _pairingRequested.value = false
        consumePairingInvite()
    }

    private fun acceptPairingURL(url: String) {
        synchronized(inviteLock) {
            val invite = PairingInvite.parse(url)
            if (invite == null) {
                _actionError.value =
                    "该配对邀请无效。请在电脑上重新发起配对。"
                return
            }
            if (isQrCredential(invite.credential) && invite.credential in spentQrCredentials) {
                _actionError.value = SPENT_QR_MESSAGE
                return
            }
            // An attempt already in flight owns the screen and the credential
            // slot. This invite waits in memory until that attempt settles;
            // publishing it now would let the finishing attempt erase a
            // credential it never redeemed, and the user would be sent back to
            // the computer for a third QR code (§6).
            if (pairingInFlight) {
                deferredInvite = invite
                return
            }
            _pairingInvite.value = invite
            _pairingRequested.value = true
        }
    }

    /**
     * Close the single active attempt and answer for any invite that arrived
     * while it was in flight.
     *
     * Port of the `defer` block of `submit(_:credential:)` in
     * `ios/App/PairingView.swift`: the waiting invite is presented only while
     * pairing is still requested (`pairingRequested`); a successful pairing
     * clears that flag first and therefore consumes the waiting invite, because
     * §6 gives a one-time credential no second life.
     */
    private fun settlePairingAttempt() {
        synchronized(inviteLock) {
            pairingInFlight = false
            val waiting = deferredInvite
            deferredInvite = null
            if (_pairingRequested.value.not()) {
                _pairingInvite.value = null
                return
            }
            val invite = waiting ?: return
            if (isQrCredential(invite.credential) && invite.credential in spentQrCredentials) return
            _pairingInvite.value = invite
        }
    }

    /** Hold the paired-but-unproven state and say why the phone is offline. */
    private fun markRestoreInconclusive(error: Throwable) {
        _restoreState.value = RestoreState.Pending
        _status.value = Status.Offline(storeFailureMessage(error))
    }

    private fun storeFailureMessage(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: STORAGE_UNAVAILABLE_MESSAGE

    /**
     * Held under [inviteLock] so adding to the spent set and dropping the invite
     * are one step: an accept that had already read the set must not publish an
     * invite this call is in the middle of burning.
     */
    private fun burnQrCredential(credential: String) = synchronized(inviteLock) {
        spentQrCredentials += credential
        clearInviteIfCredential(credential)
    }

    private fun clearInviteIfCredential(credential: String) = synchronized(inviteLock) {
        val current = _pairingInvite.value
        if (current?.credential == credential) {
            _pairingInvite.value = null
        }
    }

    private fun qrFailureMessage(error: Throwable): String =
        "${pairingFailureText(error)} 请在电脑上重新发起配对，并重新扫描新的二维码。"

    fun signOut() {
        attachmentSendIds.clear()
        streamJob?.cancel()
        streamJob = null
        scope.launch {
            gate.withLock { unpairLocked() }
            connect()
        }
    }

    /** Suspending unpair for tests / callers that need completion. */
    suspend fun signOutAndAwait() {
        streamJob?.cancel()
        streamJob = null
        gate.withLock { unpairLocked() }
        connect()
    }

    /** Remove only the selected computer. Other saved computers remain usable. */
    private suspend fun unpairLocked() {
        val connection = _connection.value
        val id = connection?.id ?: registry.activeConnectionId
        // A server-direct pairing leaves a session on the server. Revoke it
        // while the token still exists, best effort: losing the network must
        // not leave this phone paired locally because the goodbye failed.
        if (connection?.pairedWithServer == true) {
            runCatching { client?.logout() }
        }
        stopActiveRuntimeLocked()
        if (id != null) {
            tokenStore.remove(id)
            // The pairing is gone; the roster it cached must not outlive it
            // and resurface if the same computer is ever paired again.
            clearRosterCacheBestEffort(id)
        }
        registry = id?.let(registry::remove) ?: ConnectionRegistry()
        _connections.value = registry.connections
        connectionStore.saveRegistry(registry)
        if (registry.connections.isEmpty()) {
            // The pairing that earned the education step is gone, so its marker
            // goes too. Removing one of several computers must not consume the
            // first-pair marker for the others.
            onboardingStore.setNotificationOnboardingPending(false)
        }
        _connection.value = null
        _status.value = Status.Unpaired
        _restoreState.value = RestoreState.Unpaired
        restoreSelectedConnectionLocked()
        emptyInviteQueue()
        // Two branches, matching iOS signOut:
        // - Had a computer (id != null): forgetConnection — leave pairingRequested
        //   alone. Pair again does signOut() then beginPairing(); a late clear
        //   here would overwrite the new true after the first suspension above.
        // - Nothing to forget (id == null): clearActiveConnection — zero the flag.
        if (id == null) {
            _pairingRequested.value = false
        }
    }

    /** Switches active runtime only after the chosen computer's token is readable. */
    fun switchComputer(id: String) {
        scope.launch {
            awaitRestored()
            gate.withLock {
                val saved = registry.connection(id) ?: return@withLock
                if (_connection.value?.id == id) {
                    restartStreamLocked()
                    return@withLock
                }
                when (val stored = tokenStore.read(id)) {
                    is TokenStore.ReadResult.Found -> {
                        stopActiveRuntimeLocked()
                        registry = registry.select(id) ?: registry
                        _connections.value = registry.connections
                        connectionStore.saveRegistry(registry)
                        configureActiveConnectionLocked(saved, stored.token)
                        // The other computer's cache, not the previous one's:
                        // hydrateRosterCacheLocked re-stamps only what it can
                        // actually load for this id.
                        hydrateRosterCacheLocked(saved.id)
                    }
                    is TokenStore.ReadResult.Unavailable -> {
                        _actionError.value = if (stored.locked) {
                            "请解锁此手机后再尝试切换电脑。"
                        } else {
                            stored.message
                        }
                    }
                    TokenStore.ReadResult.Missing -> {
                        _actionError.value =
                            "此手机上已保存的该连接已失效。请移除后重新配对。"
                    }
                }
            }
            connect()
        }
    }

    fun forgetConnection(id: String) {
        scope.launch {
            awaitRestored()
            gate.withLock {
                if (registry.connection(id) == null) return@withLock
                val wasActive = registry.activeConnectionId == id
                if (wasActive) stopActiveRuntimeLocked()
                tokenStore.remove(id)
                clearRosterCacheBestEffort(id)
                registry = registry.remove(id)
                _connections.value = registry.connections
                connectionStore.saveRegistry(registry)
                if (registry.connections.isEmpty()) onboardingStore.setNotificationOnboardingPending(false)
                if (wasActive) {
                    _connection.value = null
                    _status.value = Status.Unpaired
                    _restoreState.value = RestoreState.Unpaired
                    restoreSelectedConnectionLocked()
                }
            }
            connect()
        }
    }

    private fun stopActiveRuntimeLocked() {
        attachmentDownloads.clear()
        streamGeneration += 1
        streamJob?.cancel()
        streamJob = null
        endpointRefreshJob?.cancel()
        endpointRefreshJob = null
        reconnectDelaySeconds = 0
        screenWatchers = 0
        client = null
        token = null
        rotation = CandidateRotation(emptyList())
        _state.value = CompanionState()
        // The cached-roster stamp belongs to the state that just went away.
        // The restore path that follows may immediately re-stamp it from the
        // next computer's cache; nothing here may outlive its state.
        _rosterSnapshotAt.value = null
        notificationSink.setBadge(0)
    }

    /**
     * Unpairing takes the invite queue with it. An invite that outlived the
     * binding it was meant for comes back on a later pairing screen and
     * redeems a credential the computer retired long ago.
     *
     * There is never a waiting invite left to clear here: [settlePairingAttempt]
     * releases or drops it inside the same [gate] section sign-out is waiting on.
     */
    private fun emptyInviteQueue() = synchronized(inviteLock) {
        _pairingInvite.value = null
    }

    /** Called when the app comes to the front, and once at launch. */
    fun connect() {
        scope.launch {
            restored.await()
            gate.withLock {
                if (client == null && _restoreState.value is RestoreState.Pending) {
                    restoreLocked()
                }
                if (client == null || streamJob != null) return@withLock
                reconnectDelaySeconds = 0
                streamGeneration += 1
                val generation = streamGeneration
                // Publish the handle while still holding `gate`, exactly as
                // restartStreamLocked() does. On a scope that starts children
                // eagerly or on another thread, a stream that fails without ever
                // suspending can reach its `finally` before the launching
                // coroutine's next line: it would clear a streamJob still null
                // and the finished job would then be published behind it, after
                // which connect() — which only tests `streamJob != null` — never
                // reopens the stream. Holding the lock makes that `finally` wait.
                streamJob = scope.launch {
                    try {
                        runStream()
                    } finally {
                        gate.withLock {
                            if (streamGeneration == generation) {
                                streamJob = null
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Rebuild the saved pairing, reporting a failed read instead of throwing it.
     *
     * Cancellation still propagates, and so does anything that is not an
     * `Exception`: an `Error` is left to the handler it was always headed for.
     *
     * Two of the three callers are fire-and-forget launches, where a thrown
     * failure has no one to catch it and reaches the uncaught handler. A read
     * that could not complete is also inconclusive: it did not establish that
     * this phone is unpaired, so the pairing is left standing (`Pending` keeps
     * the session in a protected pending state) and the phone reads offline. That extends the
     * answer `ios/App/Session.swift` already gives for a Keychain it cannot
     * open, and that a locked token already gets here, to a store that throws.
     */
    private suspend fun restoreLocked() {
        try {
            restoreFromStoresLocked()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            markRestoreInconclusive(error)
        }
    }

    private suspend fun restoreFromStoresLocked() {
        val restoredRegistry = connectionStore.loadRegistry()
        registry = restoredRegistry.registry.normalized()
        _connections.value = registry.connections
        if (restoredRegistry.migratedLegacyConnection) {
            // The old record is still intact until a v1 write succeeds. A
            // read-only/transiently failing store must not turn an otherwise
            // usable legacy pairing into an offline state merely because this
            // optional migration could not be committed today.
            try {
                connectionStore.saveRegistry(registry)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Keep the in-memory registry; the next launch retries the
                // one-way migration from the untouched legacy record.
            }
        }
        restoreSelectedConnectionLocked()
    }

    /** Restore the selected record, dropping only records whose token is truly missing. */
    private suspend fun restoreSelectedConnectionLocked() {
        while (true) {
            val saved = registry.activeConnection
            if (saved == null) {
                _connection.value = null
                _restoreState.value = RestoreState.Unpaired
                _status.value = Status.Unpaired
                return
            }
            val stored = try {
                tokenStore.read(saved.id)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                TokenStore.ReadResult.Unavailable(locked = false, message = storeFailureMessage(error))
            }
            when (stored) {
                is TokenStore.ReadResult.Unavailable -> {
                    _connection.value = saved
                    _restoreState.value = RestoreState.Pending
                    _status.value = Status.Offline(
                        if (stored.locked) "请解锁此手机以连接电脑。" else stored.message,
                    )
                    return
                }
                TokenStore.ReadResult.Missing -> {
                    registry = registry.remove(saved.id)
                    _connections.value = registry.connections
                    connectionStore.saveRegistry(registry)
                }
                is TokenStore.ReadResult.Found -> {
                    configureActiveConnectionLocked(saved, stored.token)
                    // The offline cache goes under the live one before the
                    // first connect: a launch that cannot reach the computer
                    // must still show the roster it showed minutes ago, not
                    // an empty sidebar. Best-effort — an unreadable cache is
                    // simply no cache.
                    hydrateRosterCacheLocked(saved.id)
                    return
                }
            }
        }
    }

    private fun configureActiveConnectionLocked(saved: Connection, storedToken: String) {
        _connection.value = saved
        val dialable = liveRoutes(saved, null)
        if (dialable.isEmpty() && !saved.reachesComputerByRelay && saved.usesLocalNetwork) {
            // Nothing is dialled and — as with a locked token store — the next connect() asks the platform again.
            _restoreState.value = RestoreState.Pending
            _status.value = Status.Offline(LocalNetworkRefused.CONNECT, LocalNetworkRefused.SETTINGS)
            return
        }
        token = storedToken
        // A restored pairing walks the desktop's advertised priority, and it walks
        // it credential-safely: a connection already on a protected route never
        // reaches for a local one. Surviving a failover is not a promotion — the
        // computer still decides which protected route leads.
        rotation = CandidateRotation(dialable)
        val first = rotation.currentEndpoint?.let(saved::dialing) ?: saved
        client = clientFactory(first, storedToken)
        _restoreState.value = RestoreState.Ready
        _status.value = Status.Connecting
        // No eager `/api/config` here. Its answer is the socket-relay capability, and both readers ask for it themselves:
        // `liveCallRelayReady` when someone opens a call, `configStatus` when a screen shows voice settings. A probe on
        // every restore spent a request the person did not ask for and put an unexpected `/api/config` in front of every
        // request a test harness expects to see first.
    }

    /**
     * Lay the saved roster under the live one, best effort — both restore
     * paths call this ([restoreSelectedConnectionLocked] at launch and
     * [switchComputer] mid-session), so a switch to another computer shows
     * THAT computer's cache, never the previous one's fleet under the wrong
     * name.
     *
     * The stamp clears first: for a computer whose cache cannot be read, an
     * empty sidebar is what is actually true, and a stale stamp would have the
     * banner vouch for data that is not on screen. The next non-resumed hello
     * hydrates over this wholesale and leaves the stamp null.
     */
    private suspend fun hydrateRosterCacheLocked(connectionId: String) {
        _rosterSnapshotAt.value = null
        val snapshot = try {
            rosterSnapshotStore.load(connectionId)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // An unreadable cache is "no cache", never a pairing fault — the
            // same answer a locked token store gets.
            return
        }
        if (snapshot == null || (snapshot.fleet.bots.isEmpty() && snapshot.fleet.groups.isEmpty())) return
        _state.update { it.hydrate(snapshot.fleet) }
        _rosterSnapshotAt.value = snapshot.savedAtMillis
    }

    /**
     * Forgetting a computer takes its roster cache with it. Best effort like
     * every other store call: a cache file that refuses to die is a privacy
     * blemish, not a broken unpair — the pairing and its token are already
     * gone, and the snapshot carries no credential.
     */
    private suspend fun clearRosterCacheBestEffort(connectionId: String) {
        try {
            rosterSnapshotStore.clear(connectionId)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
        }
    }

    /** Update only the active record; never overwrite the other saved computers. */
    private suspend fun persistActiveConnectionLocked(updated: Connection) {
        registry = registry.upsert(updated, makeActive = false)
        _connections.value = registry.connections
        _connection.value = updated
        connectionStore.saveRegistry(registry)
    }

    /**
     * Pull-to-refresh: reopen the stream and wait until status leaves connecting
     * or 10s — so the spinner means what it appears to mean.
     *
     * Restarts under the session mutex (not a fire-and-forget enqueue) so a
     * caller on any dispatcher observes Connecting before the wait loop runs.
     */
    suspend fun refresh() {
        awaitRestored()
        gate.withLock {
            if (client == null && _restoreState.value is RestoreState.Pending) {
                restoreLocked()
            }
            if (client == null) return@withLock
            streamJob?.cancel()
            streamJob = null
            reconnectDelaySeconds = 0
            streamGeneration += 1
            val generation = streamGeneration
            _status.value = Status.Connecting
            val job = scope.launch {
                try {
                    runStream()
                } finally {
                    gate.withLock {
                        if (streamGeneration == generation) {
                            streamJob = null
                        }
                    }
                }
            }
            streamJob = job
        }
        withTimeoutOrNull(10_000) {
            while (_status.value is Status.Connecting && currentCoroutineContext().isActive) {
                delay(120)
            }
        }
    }

    /**
     * One fresh frame for the computer viewer, outside the live turn stream.
     *
     * Every surface with an HTTP capture route answers here: cloud/Box, the Local VM, and this computer's own screen.
     * The last one is the person's real Mac, so it is its own route and its own grant on the computer; the shape it
     * returns also carries the screen size a tap must be expressed in, which is why [captureDesktopScreen] exists.
     */
    suspend fun captureScreen(bot: Bot): ScreenFrame? {
        val activeClient = client ?: return null
        return try {
            when (bot.computer) {
                "cloud" -> activeClient.computerScreenshot(bot.id, bot.threadId)
                "vm" -> activeClient.localComputerScreenshot(bot.id, bot.threadId)
                "local" -> activeClient.desktopScreenScreenshot(bot.id).let { ScreenFrame(it.png, it.mime) }
                // Auto leaves `computer` to the desktop, but a configured cloud
                // backend is still a remote surface the phone may ask for.
                null -> if (bot.cloudBackend != null) {
                    activeClient.computerScreenshot(bot.id, bot.threadId)
                } else {
                    null
                }
                else -> null
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        }
    }

    /** This computer's own screen, with the sizes a tap has to be scaled against. Null when it cannot answer. */
    suspend fun captureDesktopScreen(botId: String): DesktopScreenFrame? {
        val activeClient = client ?: return null
        return try {
            activeClient.desktopScreenScreenshot(botId)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        }
    }

    /** One tap, key or typed run on this computer. Throws what the server said, so the view can show it. */
    suspend fun desktopScreenAction(botId: String, body: JsonObject) {
        val activeClient = client ?: throw IllegalStateException("not connected")
        activeClient.desktopScreenAction(botId, body)
    }

    /** A bot's browser as the view sees it: the stream itself, and the actions it posts back. Both go through the
     * active client, so the session's own bearer and route carry them like every other request. */
    fun browserLive(botId: String, threadId: String? = null, size: Pair<Int, Int>? = null, resume: String? = null): Flow<SSEEvent>? =
        client?.browserLive(botId, threadId, size, resume)

    suspend fun browserAction(botId: String, viewerId: String, threadId: String?, body: JsonObject) {
        client?.browserAction(botId, viewerId, body, threadId)
    }

    fun watchScreen(ofBotId: String) {
        scope.launch {
            gate.withLock {
                screenWatchers += 1
                if (screenWatchers == 1) restartStreamLocked()
            }
        }
    }

    fun stopWatchingScreen(ofBotId: String) {
        scope.launch {
            gate.withLock {
                screenWatchers = maxOf(0, screenWatchers - 1)
                if (screenWatchers == 0) {
                    _state.update { it.clearScreen(ofBotId) }
                    restartStreamLocked()
                }
            }
        }
    }

    private fun restartStream() {
        scope.launch {
            gate.withLock { restartStreamLocked() }
        }
    }

    private fun restartStreamLocked() {
        if (streamJob == null) return
        streamJob?.cancel()
        streamJob = null
        if (client == null) return
        reconnectDelaySeconds = 0
        streamGeneration += 1
        val generation = streamGeneration
        // Launch without holding the mutex across runStream — the job handle is
        // published immediately so a concurrent connect() sees it.
        val job = scope.launch {
            try {
                runStream()
            } finally {
                gate.withLock {
                    if (streamGeneration == generation) {
                        streamJob = null
                    }
                }
            }
        }
        streamJob = job
    }

    /** Called when the app leaves the screen — deliberate disconnect so the cursor is known. */
    fun disconnect() {
        streamJob?.cancel()
        streamJob = null
        endpointRefreshJob?.cancel()
        endpointRefreshJob = null
    }

    private suspend fun runStream() {
        while (currentCoroutineContext().isActive) {
            val activeClient = client ?: return
            // A retry is not news. Flipping back to "connecting" before every
            // attempt made the roster's notice cross-fade with itself on each
            // backoff step — every 15 s, forever, while the computer stayed
            // away. The first attempt of a run announces itself; the retries
            // leave the failure on screen until it is no longer true.
            if (_status.value !is Status.Offline) _status.value = Status.Connecting
            var receivedHello = false
            try {
                activeClient.connection.serverEnvironmentId?.let { expected ->
                    // Fail closed before sending the bearer if the address serves a new workspace.
                    if (activeClient.environment().environmentId != expected) {
                        _status.value = Status.Unauthorized
                        return
                    }
                }
                eventsFn(activeClient, _state.value.cursor, screenWatchers > 0)
                    .collect { frame ->
                        currentCoroutineContext().ensureActive()
                        reconnectDelaySeconds = 0

                        when (val payload = frame.frame) {
                            is Frame.Hello -> {
                                receivedHello = true
                                if (!payload.resumed) {
                                    hydrate()
                                    _state.update { it.resetCursor(payload.cursor) }
                                }
                                _status.value = Status.Live
                                promoteWorkingRoute()
                                refreshConnectionMetadata(activeClient)
                            }
                            is Frame.CompanionEndpoints -> {
                                // The computer's routes changed mid-session: apply
                                // the snapshot without waiting for a reconnect.
                                refreshConnectionMetadata(activeClient, payload.metadata)
                            }
                            // Nothing to fold: the phone's job runner polls now
                            // instead of waiting out its long poll.
                            is Frame.DeviceJob -> _deviceJobNudge.tryEmit(Unit)
                            else -> {
                                _state.update { it.apply(frame) }
                                spokenReplySpeechEvent(_state.value, payload)?.let(_botReplySpeechEvents::tryEmit)
                                when (payload) {
                                    is Frame.Notify -> notificationSink.deliver(payload.notification, frame.seq)
                                    Frame.McpChanged -> _mcpChanged.tryEmit(Unit)
                                    is Frame.ComputerControl -> _computerControl.tryEmit(payload)
                                    is Frame.LiveCall -> _liveCall.tryEmit(payload)
                                    else -> Unit
                                }
                                notificationSink.setBadge(_state.value.unreadCount)
                                _state.update { it.advance(frame.seq) }
                            }
                        }
                    }
                // A live stream may close normally and should reopen on the working route.
                // An empty/comment-only response never connected: retrying it forever would
                // strand the phone even when another advertised route can reach the computer.
                if (!receivedHello) throw MissingStreamHelloException()
                _status.value = Status.Offline("连接已断开。")
            } catch (error: Throwable) {
                com.lunabot.companion.core.e2e.E2eLog.line(
                    "stream ${error.javaClass.simpleName}: ${error.message}",
                )
                if (!currentCoroutineContext().isActive || error is kotlinx.coroutines.CancellationException) {
                    return
                }
                val apiError = error as? APIError
                if (apiError?.isUnauthorized == true) {
                    _status.value = Status.Unauthorized
                    return
                }
                if (error.carriesRemovedDevice()) {
                    // GoAway(3) inside the tunnel: the owner removed this phone.
                    _status.value = Status.Unauthorized
                    return
                }
                if (apiError is APIError.Status && apiError.code == 426) {
                    // The computer only serves the encrypted link from here:
                    // this build is too old to open it.
                    _status.value = Status.OutdatedApp
                    return
                }
                _status.value = Status.Offline(
                    failureMessage(error),
                    ConnectionAdvice.remedy(error),
                )
            }

            if (!currentCoroutineContext().isActive) return
            reconnectDelaySeconds = if (reconnectDelaySeconds == 0L) 1L else minOf(reconnectDelaySeconds * 2, 15L)
            delay(reconnectDelaySeconds * 1_000)
        }
    }

    private suspend fun hydrate() {
        val activeClient = client ?: return
        val fleet = hydrateFn(activeClient, 50)
        _state.update { it.hydrate(fleet) }
        notificationSink.setBadge(_state.value.unreadCount)
        // The fetched fleet supersedes the offline cache, on screen and in
        // truth: the stamp clears now, and the bounded snapshot is written
        // off the stream's critical path — a slow, failing, or cancelled
        // store must never cost a hydrate, exactly like the composer wording
        // beside it. Only the message-bounded fleet goes down; never cursor,
        // screens, notifications, or any credential.
        _rosterSnapshotAt.value = null
        val connectionId = _connection.value?.id
        if (connectionId != null) {
            scope.launch {
                try {
                    rosterSnapshotStore.save(
                        connectionId,
                        RosterSnapshot(System.currentTimeMillis(), fleet.rosterCacheBounded()),
                    )
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                }
            }
        }
        // Deliberately off hydrate's critical path: this only words the
        // composer, and the cursor commit — and with it the whole stream —
        // must not wait on a request that says nothing about the transcript.
        // An older harness omits the flag and every engine reads as
        // non-steering, which is the conservative wording.
        scope.launch {
            _steeringInstanceIds.value = try {
                instancesFn(activeClient)
                    .filter { it.capabilities?.queueing == true }
                    .map { it.instanceId }
                    .toSet()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                emptySet()
            }
        }
    }

    /**
     * Turn a stream failure into advice a person can act on and, when the failure belongs to the
     * route rather than to the pairing, move the dial so the retry that follows tries somewhere
     * new. The trust ratchet in [CandidateRotation] decides what "somewhere new" may be, so the
     * banner only names a route the client was actually rebuilt for — it can no longer promise a
     * switch a policy guard then refuses.
     *
     * A 401 never reaches here: the unauthorized path returns before this is called.
     */
    private suspend fun failureMessage(error: Throwable): String {
        val moved = gate.withLock { advanceRouteLocked(error) }
            ?: return error.message?.takeIf { it.isNotBlank() } ?: "无法连接到电脑。"
        ConnectionAdvice.gatewayStatus(error)?.let { status ->
            return ConnectionAdvice.message(status, moved.failedAddress, moved.next)
        }
        if (ConnectionAdvice.isMissingRoute(error)) return ConnectionAdvice.MISSING_ROUTE_MESSAGE
        val failure = ConnectionAdvice.classify(error)
        return if (failure == ConnectionFailure.OTHER) {
            error.message?.takeIf { it.isNotBlank() }
                ?: ConnectionAdvice.message(failure, moved.failedAddress, moved.failedPort, moved.next)
        } else {
            ConnectionAdvice.message(failure, moved.failedAddress, moved.failedPort, moved.next)
        }
    }

    /**
     * Advance the walk and rebuild the client for the route it landed on, as one
     * step under [gate]. Null when there is no pairing to move.
     *
     * `rotation` and `client` are one fact in two fields — which route the next
     * attempt uses, and the client that will make it. Every other writer of that
     * pair ([updateAddress], [refreshConnectionMetadata], [unpairLocked]) already
     * changes them under [gate], and each of those writers *suspends* on a store
     * in the middle. `Dispatchers.Main.immediate` does not help there: a
     * suspension is exactly where another coroutine on the same thread runs. A
     * failure that advanced the walk in that window used to be overwritten a line
     * later by a refresh that had read the old rotation, leaving `client` dialing
     * one route while `rotation.currentEndpoint` named another — and
     * [promoteWorkingRoute] then persists the one that did not carry the stream.
     */
    private fun advanceRouteLocked(error: Throwable): RouteMove? {
        val connection = _connection.value ?: return null
        val failed = rotation.currentEndpoint
            ?: connection.activeEndpoint
            ?: CompanionEndpoint.direct(connection.host, connection.port, priority = 10_000)
        var next: String? = null
        val candidate = rotation.advanceEndpoint(error)
        val activeToken = token
        if (candidate != null && activeToken != null) {
            client = clientFactory(connection.dialing(candidate), activeToken)
            next = candidate.displayAddress
        }
        return RouteMove(
            failedAddress = failed?.displayAddress ?: connection.host,
            failedPort = failed?.port ?: connection.port,
            next = next,
        )
    }

    /** What [advanceRouteLocked] decided, for the banner to describe. */
    private data class RouteMove(
        val failedAddress: String,
        val failedPort: Int,
        val next: String?,
    )

    /**
     * Persist the route that carried a live stream.
     *
     * A legacy host list promotes the winner for the next launch. A typed list is *not*
     * reordered: the desktop's advertised priority keeps deciding which protected route leads,
     * so a route that merely survived a failover does not outrank a hosted route the computer
     * put first. The one thing recording a protected winner changes is that cleartext routes it
     * superseded stop leading — see [Connection.orderedEndpoints].
     *
     * Under [gate], and that is the point rather than decoration. This used to read `_connection`,
     * write it, and *then* suspend in [ConnectionStore.save] with nothing held. Every other writer
     * of the stored connection — a manual address edit, a metadata refresh, a sign-out — runs
     * inside [gate], so one of them could take the whole section during that suspension and save
     * its own connection first; the promotion's older save then landed on top of it. The measured
     * case is the address edit: the phone came back on the address the user had just replaced,
     * because memory and disk disagreed and the next launch believes the disk.
     *
     * [gate] is safe to hold here: [runStream] is always its own coroutine and never enters this
     * function holding the mutex.
     */
    private suspend fun promoteWorkingRoute() = gate.withLock {
        val winner = rotation.currentEndpoint ?: return@withLock
        val updated = _connection.value ?: return@withLock
        if (updated.activeEndpoint?.url == winner.url) return@withLock
        val promoted = updated.promoting(winner)
        persistActiveConnectionLocked(promoted)
    }

    /**
     * Learn routes the computer enabled after this phone paired. The snapshot is authenticated
     * with the device token already in hand and carries no account or pairing credential, so an
     * already-paired phone can discover hosted HTTPS without another QR code.
     *
     * Failure is deliberately non-fatal: an older sidecar answers 404 and a transient refresh
     * error must not tear down a healthy event stream.
     *
     * The live route is not swapped underneath the stream either, and that is worth being exact
     * about: the replacement order takes effect **on the next launch and on the next route
     * change** — not on every reconnect. [runStream] re-reads `client` each lap but nothing here
     * rebuilds it, so a stream that simply ends and reopens comes back on the same authority it
     * was already using. That is deliberate. The live route is at the head of the walk precisely
     * because the advertised head just failed; re-preferring it after every clean reconnect would
     * pay that failure's timeout again and again, and would move a working session onto another
     * authority for no reason. A route change — a real failure that advances the walk — reads the
     * refreshed list, and a launch reads the persisted order, which is where the new policy lands.
     *
     * And it is the computer's order that lands there. This request is how the desktop restates
     * its transport policy, so nothing local may quietly outrank it; if it could, the refresh
     * would be decorative.
     */
    /** Walks the cause chain for the tunnel's "removed" signal. */
    private fun Throwable.carriesRemovedDevice(): Boolean {
        var current: Throwable? = this
        while (current != null) {
            if (current is com.lunabot.companion.core.e2e.E2eRemovedException) return true
            current = current.cause
        }
        return false
    }

    private fun refreshConnectionMetadata(
        source: CompanionClient,
        snapshot: CompanionConnectionMetadata? = null,
    ) {
        val connectionId = _connection.value?.id ?: return
        val workingEndpoint = rotation.currentEndpoint ?: source.connection.activeEndpoint
        endpointRefreshJob?.cancel()
        endpointRefreshJob = scope.launch {
            // Best-effort from end to end, and this is a root coroutine: a store that cannot
            // write is as survivable here as a sidecar that answers 404, and neither has a
            // caller left to catch for it.
            try {
                val metadata = snapshot ?: metadataFn(source)
                gate.withLock {
                    val current = _connection.value ?: return@withLock
                    // The stream that asked for this snapshot may already have been replaced by
                    // a sign-out, a manual address edit or a route advance. Applying it then
                    // would reorder a walk that no longer belongs to this client.
                    if (current.id != connectionId) return@withLock
                    if (client?.connection?.baseUrl != source.connection.baseUrl) return@withLock
                    // A server pairing learns routes under the consent its link carried (`applyingPairingAdvertisement`
                    // filters through that policy), so a moved origin or a new address of the same kind is adopted.
                    // It never adopts a descriptor: that key is the relay's, and taking it would move the phone's
                    // traffic onto an encrypted route the owner never agreed to at pairing.
                    val updated = if (current.pairedWithServer) {
                        current.applyingPairingAdvertisement(metadata.hosts, metadata.endpoints)
                    } else {
                        current.reconciling(metadata)
                    }
                    persistActiveConnectionLocked(updated)
                    rotation = CandidateRotation(liveRoutes(updated, workingEndpoint?.takeIf(routeAccess::allows)))
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                return@launch
            }
        }
    }

    /**
     * [winner] first, then the stored policy order — the walk a live session may take without
     * abandoning the route that is already carrying it.
     *
     * The head here is a transient cursor for one session, not a stored preference: what gets
     * written down is [Connection.orderedEndpoints], where the desktop's priority governs.
     */
    /** What [routeAccess] answered for the active pairing's routes when its walk was last built. */
    private var routeAnswers: List<Boolean> = emptyList()

    private fun liveRoutes(
        connection: Connection,
        winner: CompanionEndpoint?,
    ): List<CompanionEndpoint> {
        routeAnswers = connection.orderedEndpoints.map(routeAccess::allows)
        val routes = connection.dialableEndpoints(routeAccess)
        return if (winner == null) routes else listOf(winner) + routes.filterNot { it.url == winner.url }
    }

    /**
     * The platform changed its mind about a route: the person answered the local-network prompt or came back from
     * Settings. A pairing that was waiting on that answer is restored now. A live session moves onto the route the
     * stored order leads with, the way a route change moves it; one already there is left alone.
     */
    fun onRouteAccessChanged() {
        scope.launch {
            restored.await()
            gate.withLock {
                val active = client
                if (active == null) {
                    if (_restoreState.value is RestoreState.Pending) restoreLocked()
                    return@withLock
                }
                val current = _connection.value ?: return@withLock
                val activeToken = token ?: return@withLock
                if (current.orderedEndpoints.map(routeAccess::allows) == routeAnswers) return@withLock
                val routes = liveRoutes(current, null)
                val inPlace = if (current.e2eDescriptor != null) {
                    // An encrypted session is where its tunnel dials — the first route it is allowed, or the relay —
                    // which the head of the walk alone does not say.
                    active.e2eDirectUrl == current.e2eDirectUrl(routeAccess) &&
                        routes.firstOrNull()?.url == rotation.currentEndpoint?.url
                } else {
                    routes.firstOrNull()?.url == active.connection.activeEndpoint?.url
                }
                if (inPlace) return@withLock
                val lead = routes.firstOrNull() ?: return@withLock
                rotation = CandidateRotation(routes)
                client = clientFactory(current.dialing(lead), activeToken)
                restartStreamLocked()
            }
        }
    }

    /** Replace the stored address by hand, keeping the pairing and its token. */
    fun updateAddress(text: String): Boolean {
        val parsed = Connection.parse(text) ?: return false
        val current = _connection.value ?: return false
        val endpoint = parsed.activeEndpoint
            ?: CompanionEndpoint.direct(parsed.host, parsed.port, priority = 0)
            ?: return false
        val updated = current.resettingRoutePolicy(endpoint)
        scope.launch {
            gate.withLock {
                persistActiveConnectionLocked(updated)
                rotation = CandidateRotation(liveRoutes(updated, endpoint))
                val activeToken = token
                if (activeToken != null) {
                    client = clientFactory(updated, activeToken)
                }
                restartStreamLocked()
            }
        }
        return true
    }

    suspend fun updateAddressAndAwait(text: String): Boolean {
        val parsed = Connection.parse(text) ?: return false
        val current = _connection.value ?: return false
        val endpoint = parsed.activeEndpoint
            ?: CompanionEndpoint.direct(parsed.host, parsed.port, priority = 0)
            ?: return false
        val updated = current.resettingRoutePolicy(endpoint)
        gate.withLock {
            persistActiveConnectionLocked(updated)
            rotation = CandidateRotation(liveRoutes(updated, endpoint))
            val activeToken = token
            if (activeToken != null) {
                client = clientFactory(updated, activeToken)
            }
            restartStreamLocked()
        }
        return true
    }

    // MARK: - Actions

    suspend fun send(text: String, to: Chat): Boolean {
        return perform {
            val receipt = when (to) {
                is Chat.BotChat -> it.sendToBot(to.bot.id, text, to.threadId)
                is Chat.RoomChat -> it.sendToRoom(to.room.id, text, to.threadId)
            }
            record(receipt, text, to.threadId)
        }
    }

    /**
     * The POST receipt is authoritative even when its stream frame is still in
     * flight: an accepted line joins the transcript now, while a held send has
     * to stay on screen or the words vanish until the turn settles. [text] is
     * what the person typed; the harness echoes back only an id for a hold.
     */
    private fun record(receipt: SendReceipt, text: String, fallbackThreadId: String) {
        when (receipt) {
            is SendReceipt.Queued -> {
                val threadId = receipt.threadId.ifEmpty { fallbackThreadId }
                _state.update { it.rememberQueued(QueuedSend(receipt.queueId, text), threadId) }
            }
            is SendReceipt.Sent -> {
                val message = receipt.message ?: return
                val threadId = receipt.threadId?.takeIf(String::isNotEmpty) ?: fallbackThreadId
                _state.update { it.apply(Frame.Message(threadId, message)) }
            }
        }
    }

    /**
     * Take back a held message before its turn settles. The row goes only
     * once the harness confirms, so a failed cancel leaves the words on
     * screen still waiting — which is what is actually true.
     */
    /** True only when the computer confirmed cancellation, so an
     * edit never hands back words that already joined a turn. */
    suspend fun cancelQueued(send: QueuedSend, chat: Chat): Boolean {
        val activeClient = client ?: return false
        val destination = when (chat) {
            is Chat.BotChat -> MessageDestination.Bot(chat.bot.id, chat.threadId)
            is Chat.RoomChat -> MessageDestination.Room(chat.room.id, chat.threadId)
        }
        try {
            val cancelled = activeClient.cancelQueued(send.queueId, destination)
            if (client !== activeClient) return false
            _state.update { it.forgetQueued(send.queueId, chat.threadId) }
            return cancelled
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (client !== activeClient) return false
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            _actionError.value = error.message
            return false
        }
    }

    /**
     * Steer a held message into the turn it waits behind. The queue frame is
     * the authority on the row either way — the harness answers 200 whether
     * the words joined the turn or admission kept them waiting — so this only
     * surfaces a failure to act, never mutates queue state itself.
     */
    suspend fun steerQueued(send: QueuedSend, chat: Chat): Boolean {
        val activeClient = client ?: return false
        val destination = when (chat) {
            is Chat.BotChat -> MessageDestination.Bot(chat.bot.id, chat.threadId)
            is Chat.RoomChat -> MessageDestination.Room(chat.room.id, chat.threadId)
        }
        try {
            val steered = activeClient.steerQueued(send.queueId, destination)
            if (client !== activeClient) return false
            return steered
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (client !== activeClient) return false
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            _actionError.value = error.message
            return false
        }
    }

    /**
     * The conversation on screen, if any — presence reports carry it as the
     * chat the person is looking at. Set by the chat screen while it is
     * composed; leaving the screen clears it. Opening a chat is itself a
     * moment of use, so it reports right away.
     */
    @Volatile private var openThreadId: String? = null

    private val presenceLock = Any()
    // Seeded one repeat-window in the past, so the first ping of a process is never throttled.
    private var presenceReportedAt = -PRESENCE_REPEAT_MS
    private var presenceReportedThread: String? = null

    fun noteChatOpen(threadId: String?) {
        openThreadId = threadId
        if (threadId != null) reportPresence()
    }

    /**
     * The person is using the app: tell the computer, so the arrival brief and
     * the presence context work when the phone is the device in hand. Quiet by
     * design — this is a ping, and a failed one is never an action error.
     * Throttled: the same conversation is not re-reported inside a minute, and
     * nothing is reported twice inside five seconds, so an app switch or a
     * quick thread hop cannot turn into a stream of posts.
     */
    fun reportPresence() {
        val activeClient = client ?: return
        val threadId = openThreadId
        synchronized(presenceLock) {
            val now = nowFn()
            if (now - presenceReportedAt < PRESENCE_FLOOR_MS) return
            if (threadId == presenceReportedThread && now - presenceReportedAt < PRESENCE_REPEAT_MS) return
            presenceReportedAt = now
            presenceReportedThread = threadId
        }
        scope.launch {
            try {
                activeClient.reportPresence(
                    threadId,
                    java.util.TimeZone.getDefault().id,
                    java.util.Locale.getDefault().toLanguageTag(),
                )
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // A ping that never arrived is indistinguishable from the app not being used; say nothing.
            }
        }
    }

    /**
     * A widget press. Unlike [send] this lets [APIError] bubble: the card shows
     * the server's own refusal words ("This widget changed. Check it and press
     * again.") rather than the app-wide error banner, and a non-status failure
     * means the press may be retried under the same sendId.
     */
    suspend fun sendWidgetAction(botId: String, widgetAction: JsonObject, threadId: String, sendId: String): SendReceipt {
        val activeClient = client ?: throw IllegalStateException("此电脑当前离线。")
        try {
            return activeClient.sendWidgetAction(botId, widgetAction, threadId, sendId)
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            throw error
        }
    }

    /** Fetch an app document for a row that is about to mount. */
    suspend fun appDocument(threadId: String, messageId: String, origin: String? = null): AppDocument {
        val activeClient = client ?: throw IllegalStateException("此电脑当前离线。")
        try {
            return activeClient.appDocument(threadId, messageId, origin)
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            throw error
        }
    }

    /** One app-initiated RPC, with the server's refusal shape preserved for the View. */
    suspend fun appRpc(botId: String, threadId: String, messageId: String, method: String, params: JsonObject): AppRpcOutcome {
        val activeClient = client ?: return AppRpcOutcome.Refusal(-32000, "Offline", offline = true)
        return try {
            activeClient.appRpc(botId, threadId, messageId, method, params)
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            AppRpcOutcome.Refusal(-32000, if (error is APIError.Transport) "Offline" else error.message ?: "The app's server refused this.", offline = error is APIError.Transport)
        }
    }

    suspend fun postAppContext(botId: String, threadId: String, messageId: String, update: JsonObject) {
        val activeClient = client ?: throw IllegalStateException("此电脑当前离线。")
        try {
            activeClient.appContext(botId, threadId, messageId, update)
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            throw error
        }
    }

    suspend fun sendAppMessage(botId: String, threadId: String, messageId: String, text: String, sendId: String): SendReceipt {
        val activeClient = client ?: throw IllegalStateException("此电脑当前离线。")
        try {
            return activeClient.sendAppMessage(botId, threadId, messageId, text, sendId)
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            throw error
        }
    }

    /**
     * Update Claude Code for the engine a failed turn ran on. The answer is
     * for the card that asked, not the app-wide error banner: it shows the
     * version on success and the harness's own words (already written for a
     * person — "stop the running turn first") on failure.
     */
    suspend fun updateClaude(instanceId: String): ClaudeUpdateResult {
        val activeClient = client ?: return ClaudeUpdateResult.Failed("此电脑当前离线。")
        return try {
            ClaudeUpdateResult.Updated(activeClient.updateClaude(instanceId))
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            ClaudeUpdateResult.Failed(error.message ?: "无法更新 Claude Code。")
        }
    }

    /**
     * An ambiguous network failure may happen after the server accepted a
     * message. Reusing the id for the exact same retained draft makes Retry
     * idempotent instead of sending the attachment twice.
     */
    private data class AttachmentDraftKey(
        val destination: MessageDestination,
        val text: String,
        val attachmentIds: List<String>,
    )

    private val attachmentSendIds = LinkedHashMap<AttachmentDraftKey, String>()

    /**
     * Send a composer draft with app-owned attachments — the port of
     * `Session.send(text:attachments:to:)`. The destination includes the exact
     * active thread at tap time, so neither a desktop task switch nor an upload
     * delay can move the message elsewhere. Callers only clear their draft when
     * this returns true.
     */
    suspend fun send(text: String, attachments: List<PendingMessageAttachment>, to: Chat): Boolean {
        val activeClient = client ?: run {
            _actionError.value = "此电脑当前离线。"
            return false
        }
        val connectionId = _connection.value?.id
        _actionError.value = null
        return try {
            AttachmentPolicy.validate(attachments)
            if (text.isBlank() && attachments.isEmpty()) {
                _actionError.value = "请先输入消息或添加文件附件。"
                return false
            }
            if (attachments.any { it.kind == PendingMessageAttachment.Kind.IMAGE }) {
                val capable = try {
                    activeClient.imageCapableInstanceIds()
                } catch (error: APIError.Status) {
                    if (error.code != 404) throw error
                    _actionError.value = "发送图片前请先在此电脑上更新 Luna Bot。"
                    return false
                }
                if (!imageSupported(to, capable)) {
                    _actionError.value = imageCompatibilityMessage(to)
                    return false
                }
            }
            val destination = when (to) {
                is Chat.BotChat -> MessageDestination.Bot(to.bot.id, to.bot.threadId)
                is Chat.RoomChat -> MessageDestination.Room(to.room.id, to.room.threadId)
            }
            val key = AttachmentDraftKey(destination, text, attachments.map { it.id })
            if (attachmentSendIds.size >= 20 && key !in attachmentSendIds) attachmentSendIds.clear()
            val sendId = attachmentSendIds.getOrPut(key) { UUID.randomUUID().toString() }

            val uploaded = attachments.map { attachment ->
                currentCoroutineContext().ensureActive()
                val mime = AttachmentPolicy.normalizedMime(attachment.mime)
                when (attachment.kind) {
                    PendingMessageAttachment.Kind.IMAGE -> SharedAttachmentReference(
                        path = activeClient.uploadImage(attachment.data, mime, attachment.id),
                        kind = SharedAttachmentKind.IMAGE,
                        displayName = attachment.name,
                    )
                    PendingMessageAttachment.Kind.FILE -> {
                        val file = activeClient.uploadFile(attachment.data, attachment.name, mime, attachment.id)
                        SharedAttachmentReference(file.path, SharedAttachmentKind.FILE, file.name)
                    }
                }
            }
            val message = SharedMessageComposer.compose(
                instruction = text,
                text = emptyList(),
                urls = emptyList(),
                attachments = uploaded,
            )
            val receipt = activeClient.send(message, destination, sendId)
            // The row shows what was typed, not what was sent: `message`
            // carries the <attached-file …> tags the harness reads, and a
            // held message is a person's own words waiting, not transport.
            // An attachment-only send has no words, so it falls back.
            record(receipt, text.trim().ifEmpty { message }, to.threadId)
            attachmentSendIds.remove(key)
            _actionError.value = null
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) {
                gate.withLock {
                    if (connectionId != null && _connection.value?.id == connectionId) {
                        _status.value = Status.Unauthorized
                    }
                }
            }
            _actionError.value = error.message
            false
        } catch (error: Throwable) {
            _actionError.value = error.message
            false
        }
    }

    private fun imageSupported(chat: Chat, capableInstances: Set<String>): Boolean = when (chat) {
        is Chat.BotChat -> chat.bot.modelSelection.instanceId in capableInstances
        is Chat.RoomChat -> chat.room.memberIds.isNotEmpty() && chat.room.memberIds.all { id ->
            val bot = _state.value.bot(id) ?: return@all false
            bot.modelSelection.instanceId in capableInstances
        }
    }

    private fun imageCompatibilityMessage(chat: Chat): String = when (chat) {
        is Chat.BotChat ->
            "${chat.bot.name} 当前使用的模型不支持图片。请更换其他模型或移除图片。"
        is Chat.RoomChat ->
            "在此群聊中可能回复的每个智能体都必须使用支持图片的模型。"
    }

    /**
     * Download one desktop path through its originating transcript message.
     * Where the bytes are kept for viewing is the app's business (it owns a
     * cache directory); this only fetches and reports.
     */
    suspend fun downloadFile(
        threadId: String,
        messageId: String,
        path: String,
        reportError: Boolean = true,
        cacheResult: Boolean = false,
    ): DownloadedFile? {
        val activeClient = client ?: run {
            if (reportError) _actionError.value = "此电脑当前离线。"
            return null
        }
        val connectionId = _connection.value?.id
        if (reportError) _actionError.value = null
        return try {
            val id = connectionId ?: throw APIError.Transport("此电脑当前离线。")
            val download = attachmentDownloads.getOrLoad(
                AttachmentDownloadKey(id, threadId, messageId, path),
                retainResult = cacheResult,
            ) {
                activeClient.downloadFile(threadId, messageId, path)
            }
            afterAttachmentDownload()
            currentCoroutineContext().ensureActive()
            // A computer switch invalidates the meaning of every local path.
            // The cache is cleared during the switch, but a transfer that won
            // the completion race must still never surface old-computer bytes.
            if (_connection.value?.id != id) return null
            download
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) {
                gate.withLock {
                    if (connectionId != null && _connection.value?.id == connectionId) {
                        _status.value = Status.Unauthorized
                    }
                }
            }
            if (reportError) _actionError.value = error.message
            null
        } catch (error: Throwable) {
            if (reportError) _actionError.value = error.message
            null
        }
    }

    /**
     * Executes one idempotent share operation against the selected computer.
     * A network/gateway failure may advance only through [CandidateRotation],
     * which retains the HTTPS trust ratchet. Callers supply stable upload/send
     * ids, so replaying this lambda cannot create duplicate server objects.
     */
    suspend fun <T> withShareClient(connectionId: String, action: suspend (CompanionClient) -> T): T {
        val first = client ?: throw IllegalStateException("分享前请先连接到所选电脑。")
        if (_connection.value?.id != connectionId) {
            throw IllegalStateException("所选电脑已变更。请重新选择发送目标。")
        }
        try {
            return action(first)
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            val retry = gate.withLock {
                if (_connection.value?.id != connectionId) null else {
                    // Only the live computer's 401 may mark this session revoked.
                    if (error.isUnauthorized) _status.value = Status.Unauthorized
                    advanceRouteLocked(error)
                    client
                }
            }
            if (retry != null && retry !== first && _connection.value?.id == connectionId) {
                return action(retry)
            }
            throw error
        } catch (error: Throwable) {
            val retry = gate.withLock {
                if (_connection.value?.id != connectionId) null else {
                    advanceRouteLocked(error)
                    client
                }
            }
            if (retry != null && retry !== first && _connection.value?.id == connectionId) {
                return action(retry)
            }
            throw error
        }
    }

    /**
     * One share/upload against a saved computer without moving the live stream.
     *
     * The active pairing keeps its HTTPS ratchet via [withShareClient]. A share
     * aimed at another saved computer walks only that computer's credential-
     * approved routes and must not mark this session unauthorized: a 401 there
     * is about that pairing, not the one currently on screen.
     */
    suspend fun <T> withPairedShareClient(
        connectionId: String,
        action: suspend (CompanionClient) -> T,
    ): T {
        awaitRestored()
        if (_connection.value?.id == connectionId) {
            return withShareClient(connectionId, action)
        }
        val saved = registry.connection(connectionId)
            ?: throw APIError.Transport("此手机上已保存的该连接已失效。请移除后重新配对。")
        val pairedToken = when (val stored = tokenStore.read(connectionId)) {
            is TokenStore.ReadResult.Found -> stored.token
            is TokenStore.ReadResult.Unavailable -> throw APIError.Transport(
                if (stored.locked) {
                    "请解锁此手机后再尝试分享。"
                } else {
                    stored.message
                },
            )
            TokenStore.ReadResult.Missing -> throw APIError.Transport(
                "此手机上已保存的该连接已失效。请移除后重新配对。",
            )
        }
        val endpoints = saved.automaticEndpoints
        if (endpoints.isEmpty()) {
            throw APIError.Transport(
                "无法连接到 ${saved.name}。请保持 Luna Bot 打开并开启手机访问，然后重试。",
            )
        }
        var lastError: Throwable? = null
        for (endpoint in endpoints) {
            val candidate = clientFactory(saved.dialing(endpoint), pairedToken)
            try {
                return action(candidate)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                lastError = error
                if (!canRetryShareOnAnotherRoute(error)) throw error
            }
        }
        throw lastError ?: APIError.Transport(
            "无法连接到 ${saved.name}。请保持 Luna Bot 打开并开启手机访问，然后重试。",
        )
    }

    private fun canRetryShareOnAnotherRoute(error: Throwable): Boolean {
        val api = generateSequence(error) { it.cause }.filterIsInstance<APIError>().firstOrNull()
        return if (api != null) {
            ConnectionAdvice.shouldRetryPairingOnAnotherRoute(api)
        } else {
            ConnectionAdvice.shouldTryAnotherHost(error)
        }
    }

    suspend fun answer(
        chat: Chat,
        card: OptionCard,
        choice: String,
        rememberingPermission: Boolean = true,
    ) {
        val requestId = card.requestId ?: return
        if (
            rememberingPermission &&
            card.shouldRememberPermission(choice) &&
            chat is Chat.BotChat
        ) {
            alwaysAllow(chat.bot, card)
        }
        answer(
            threadId = chat.threadId,
            requestId = requestId,
            choice = choice,
            isPermission = card.isPermission,
            reviewedSha256 = card.skillRequest?.reviewedSha256,
        )
    }

    suspend fun answer(
        threadId: String,
        requestId: String,
        choice: String,
        isPermission: Boolean,
        reviewedSha256: String? = null,
    ) {
        perform {
            val behavior = OptionCard.responseBehavior(choice, isPermission)
            it.respond(
                threadId = threadId,
                requestId = requestId,
                behavior = behavior,
                message = choice.takeIf { behavior == "answer" },
                reviewedSha256 = reviewedSha256.takeIf { behavior == "allow" },
            )
        }
    }

    suspend fun alwaysAllow(bot: Bot, card: OptionCard) {
        val key = card.allowKey ?: return
        perform { it.alwaysAllow(bot.id, key, bot.threadId) }
    }

    /**
     * Answer a card of choices that is not a live request — an onboarding
     * quiz, an engine-switch offer, a routine or profile question. The words
     * go as an ordinary message first, because that is what the bot acts on;
     * the card's own patch only settles the row. If the patch fails, the row
     * still disappears under the same rule the desktop hides it by: a later
     * user text now exists. Rooms never take this path, same as the desktop.
     */
    suspend fun answerOpenQuestion(chat: Chat.BotChat, messageId: String, choice: String): Boolean {
        val destination = MessageDestination.Bot(chat.bot.id, chat.threadId)
        return perform {
            it.send(choice, destination, UUID.randomUUID().toString())
            it.patchCard(chat.bot.id, messageId, chat.threadId, answered = choice, dismissed = true)
        }
    }

    /** The x on an open question card: settled without an answer, no message sent. */
    suspend fun dismissOpenQuestion(chat: Chat.BotChat, messageId: String): Boolean =
        perform { it.patchCard(chat.bot.id, messageId, chat.threadId, dismissed = true) }

    /**
     * A tool activity's whole output, when the wire carried it truncated.
     * Null when the message has no output server-side (its 404), which the
     * detail sheet reads as "nothing more to show" rather than an error.
     */
    suspend fun toolOutput(threadId: String, messageId: String): String? {
        val activeClient = client ?: return null
        return runCatching { activeClient.messageToolOutput(threadId, messageId) }.getOrNull()
    }

    /**
     * Answer a temporary-permission proposal: granted starts the grant until
     * its deadline, refused ends it. The harness refuses non-owner sessions,
     * exactly like the desktop — the error surfaces through actionError.
     */
    suspend fun answerGrant(threadId: String, messageId: String, granted: Boolean): Boolean =
        perform { it.answerGrant(threadId, messageId, if (granted) "granted" else "refused") }

    /**
     * "Not now" on the proactive add-a-helper-key suggestion. Adding the key
     * itself stays on the computer, whose settings own the decision-model keys.
     */
    suspend fun dismissHelperSuggestion(threadId: String, messageId: String): Boolean =
        perform { it.dismissHelperSuggestion(threadId, messageId) }

    /**
     * The two buttons on an approval notification, resolved against the newest
     * pending card on [threadId].
     *
     * A learned-skill proposal and a structured question are refused here on
     * purpose: both carry a body that has to be read before a decision is safe,
     * and the shade can only show a title and a line. Those taps fall back to
     * the normal notification, which opens the conversation.
     */
    suspend fun decideApprovalFromNotification(threadId: String, allow: Boolean): Boolean {
        val activeClient = client ?: return false
        return try {
            val page = activeClient.messages(threadId, limit = 50)
            val card = page.messages.asReversed()
                .firstNotNullOfOrNull { message -> message.card?.takeIf { it.isPending } }
                ?: return false
            val requestId = card.requestId ?: return false
            if (card.skillRequest != null || card.questions.isNotEmpty()) return false
            val choice = if (allow) {
                card.options.firstOrNull { !OptionCard.isRefusal(it) }
            } else {
                card.options.firstOrNull { OptionCard.isRefusal(it) }
            } ?: return false
            val behavior = OptionCard.responseBehavior(choice, card.isPermission)
            activeClient.respond(
                threadId = threadId,
                requestId = requestId,
                behavior = behavior,
                message = choice.takeIf { behavior == "answer" },
            )
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    suspend fun createBot(): Bot? {
        val activeClient = client ?: return null
        return try {
            val bot = activeClient.createBot()
            _state.update { it.apply(Frame.Bot(bot)) }
            bot
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    suspend fun createRoom(name: String?, memberIds: List<String>): Room? {
        val activeClient = client ?: return null
        return try {
            val room = activeClient.createRoom(name, memberIds)
            _state.update { it.apply(Frame.Room(room)) }
            room
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    /**
     * Create or extend a derived sidebar section in one server transaction.
     * The desktop has no standalone section resource yet, so we merge the
     * returned bot snapshots and let SSE reconcile later desktop-side changes.
     */
    suspend fun assignSection(name: String, botIds: List<String>): List<Bot>? {
        val activeClient = client ?: return null
        return try {
            activeClient.assignSection(name, botIds).also { updatedBots ->
                _state.update { state ->
                    updatedBots.fold(state) { current, bot -> current.apply(Frame.Bot(bot)) }
                }
            }
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    suspend fun interrupt(bot: Bot) {
        perform { it.interrupt(bot.id, bot.threadId) }
    }

    /** The same stop, for a room: the endpoint takes the room, not a bot. */
    suspend fun interrupt(chat: Chat) {
        perform {
            when (chat) {
                is Chat.BotChat -> it.interrupt(chat.bot.id, chat.threadId)
                is Chat.RoomChat -> it.interruptRoom(chat.room.id, chat.threadId)
            }
        }
    }

    suspend fun cloudDesktop(forBot: Bot): URI {
        val activeClient = client ?: throw APIError.Transport("此电脑当前离线。")
        val connectionId = _connection.value?.id
        return try {
            activeClient.cloudDesktop(forBot.id).url
        } catch (error: APIError) {
            if (error.isUnauthorized) {
                gate.withLock {
                    // Only the live computer's 401 may mark this session revoked.
                    if (connectionId != null && _connection.value?.id == connectionId) {
                        _status.value = Status.Unauthorized
                    }
                }
            }
            throw error
        }
    }

    suspend fun markRead(chat: Chat) {
        perform(quietly = true) {
            when (chat) {
                is Chat.BotChat -> it.markBotRead(chat.bot.id, chat.threadId)
                is Chat.RoomChat -> it.markRoomRead(chat.room.id, chat.threadId)
            }
        }
    }

    suspend fun loadThread(threadId: String) {
        val activeClient = client ?: return
        try {
            val page = activeClient.messages(threadId, limit = 50)
            _state.update { it.merge(page, threadId) }
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
        }
    }

    suspend fun loadThreadIfNeeded(threadId: String) {
        if (!_state.value.hasLoadedPage(threadId)) loadThread(threadId)
    }

    suspend fun loadOlder(threadId: String) {
        val activeClient = client ?: return
        val oldest = _state.value.transcript(threadId).firstOrNull() ?: return
        try {
            val page = activeClient.messages(threadId, before = oldest.id, limit = 50)
            _state.update { it.prepend(page, threadId) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun image(threadId: String, messageId: String): ByteArray? =
        try {
            client?.image(threadId, messageId)
        } catch (_: Throwable) {
            null
        }

    suspend fun search(query: String): List<SearchHit> {
        val trimmed = query.trim()
        if (trimmed.length < 2) return emptyList()
        val activeClient = client ?: return emptyList()
        return try {
            activeClient.search(trimmed)
        } catch (error: Throwable) {
            _actionError.value = error.message
            emptyList()
        }
    }

    suspend fun open(hit: SearchHit): Chat? {
        val activeClient = client ?: return null
        return try {
            val botId = hit.botId
            if (botId != null) {
                if (_state.value.bot(botId)?.forTask(hit.threadId) == null && !refreshNavigationState(activeClient)) return null
                val bot = _state.value.bot(botId)?.forTask(hit.threadId)
                    ?: throw APIError.Status(404, THREAD_GONE_MESSAGE)
                if (!hit.onActivePath) {
                    val leaf = activeClient.setActiveBranch(bot.id, hit.messageId, hit.threadId)
                    _state.update { it.apply(Frame.Thread(hit.threadId, leaf)) }
                }
                val page = activeClient.messagesAround(hit.threadId, hit.messageId)
                _state.update { it.merge(page, hit.threadId) }
                _focusedMessageId.value = hit.messageId
                return _state.value.chat(ChatTarget.Bot(bot.id, hit.threadId))
            }
            val groupId = hit.groupId
            if (groupId != null) {
                var room = _state.value.rooms.firstOrNull { it.id == groupId } ?: return null
                if (room.threadId != hit.threadId) {
                    room = activeClient.switchRoomTask(room.id, hit.threadId)
                    _state.update { it.apply(Frame.Room(room)) }
                }
                val page = activeClient.messagesAround(hit.threadId, hit.messageId)
                _state.update { it.merge(page, hit.threadId) }
                _focusedMessageId.value = hit.messageId
                return _state.value.chat(ChatTarget.Room(groupId, hit.threadId))
            }
            null
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun openNotification(target: NotificationTarget): Chat? {
        awaitRestored()
        return notificationGate.withLock {
            val activeClient = client
            if (activeClient == null) {
                _actionError.value = "请将此手机与电脑配对以打开该任务。"
                return@withLock null
            }

            try {
                _state.value.roomOwningTask(target.threadId)?.let { room ->
                    return@withLock openRoomNotification(activeClient, room, target.threadId)
                }

                if (_state.value.bot(target.botId)?.forTask(target.threadId) == null) {
                    if (!refreshNavigationState(activeClient)) return@withLock null
                    _state.value.roomOwningTask(target.threadId)?.let { room ->
                        return@withLock openRoomNotification(activeClient, room, target.threadId)
                    }
                }

                val selected = _state.value.bot(target.botId)
                    ?: throw APIError.Status(404, "该智能体已不存在。")
                Chat.BotChat(selected.forTask(target.threadId)
                    ?: throw APIError.Status(404, THREAD_GONE_MESSAGE))
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                if (client !== activeClient) return@withLock null
                _actionError.value = error.message
                null
            }
        }
    }

    /** Refresh only navigation metadata; keep already loaded scrollback and live tails. */
    private suspend fun refreshNavigationState(activeClient: CompanionClient): Boolean {
        val before = _state.value
        val fleet = hydrateFn(activeClient, 50)
        currentCoroutineContext().ensureActive()
        return gate.withLock {
            if (client !== activeClient) return@withLock false
            // A newer live frame wins over this HTTP snapshot, including when
            // a fresh connection has not established an SSE cursor yet.
            _state.update { current ->
                if (current !== before) current else current.copy(bots = fleet.bots, rooms = fleet.groups)
            }
            notificationSink.setBadge(_state.value.unreadCount)
            true
        }
    }

    /** A room notification can name any channel task, not just the active one. */
    private suspend fun openRoomNotification(
        activeClient: CompanionClient,
        room: Room,
        threadId: String,
    ): Chat.RoomChat {
        if (room.threadId == threadId) return Chat.RoomChat(room)
        val switched = activeClient.switchRoomTask(room.id, threadId)
        currentCoroutineContext().ensureActive()
        if (client !== activeClient) throw CancellationException("当前活动的电脑已变更。")
        _state.update { it.apply(Frame.Room(switched)) }
        return Chat.RoomChat(_state.value.rooms.firstOrNull { it.id == room.id } ?: switched)
    }

    fun consumeFocus(messageId: String) {
        if (_focusedMessageId.value == messageId) _focusedMessageId.value = null
    }

    /**
     * A tapped "Opened thread #Title on Scout" chip. Lands on that thread by
     * the route a thread row uses, which only changes what this phone is
     * looking at — a bot mid-turn keeps working where it was. A thread the
     * computer no longer has reports that it is gone, keeping the current
     * conversation in place.
     *
     * @return the bot pinned to the exact thread; null when it is gone,
     *   opening fails, or the connection changes.
     */
    suspend fun openThread(ref: ThreadRef): Bot? {
        currentCoroutineContext().ensureActive()
        val activeClient = client
        if (activeClient == null) {
            _actionError.value = "请将此手机与电脑配对以打开该会话。"
            return null
        }
        _actionError.value = null
        return try {
            if (_state.value.bot(ref.botId)?.forTask(ref.threadId) == null) {
                if (!refreshNavigationState(activeClient)) return null
            }
            val selected = _state.value.bot(ref.botId)
                ?: throw APIError.Status(404, "该智能体已不存在。")
            selected.forTask(ref.threadId) ?: throw APIError.Status(404, THREAD_GONE_MESSAGE)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            currentCoroutineContext().ensureActive()
            if (client !== activeClient) return null
            _actionError.value = error.message
            null
        }
    }

    /**
     * The one policy behind every task mutation below: offline yields
     * [offline], cancellation is not an error and propagates, and anything
     * else is reported as the action error and also yields [offline]. Each
     * method differs only in its endpoint and the frame that commits its
     * result, so no Bot-versus-Room copy can drift again. Internal rather
     * than private only so SessionTaskCrudTest can pin the cancellation
     * contract directly.
     */
    internal suspend fun <T> mutateTask(offline: T, mutation: suspend (CompanionClient) -> T): T {
        val activeClient = client ?: return offline
        return try {
            mutation(activeClient)
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            _actionError.value = error.message
            // Cancellation that lands while the failure is being reported
            // still wins: a cancelled caller throws instead of observing the
            // offline value.
            currentCoroutineContext().ensureActive()
            offline
        }
    }

    suspend fun createTask(forBot: Bot, title: String?): Bot? = mutateTask(null) { client ->
        client.createTask(forBot.id, title).also { updated ->
            _state.update { it.apply(Frame.Bot(updated)) }
        }
    }

    suspend fun switchTask(task: BotTask, forBot: Bot): Bot? {
        if (task.threadId == forBot.threadId) return forBot
        return mutateTask(null) { client ->
            client.switchTask(forBot.id, task.threadId).also { updated ->
                _state.update { it.apply(Frame.Bot(updated)) }
            }
        }
    }

    /**
     * Fold the outcome the caller already knows into the stored task. The PATCH
     * endpoints return void, but title, pin, archive and snooze all end in the
     * value the caller asked for, so the state can move the moment the request
     * succeeds. The bot frame lands on the stream right after and overwrites
     * the same fields — applying the known value first only skips the wait.
     * A full stream rebuild used to do this job and cost ten-plus seconds per
     * mutation while killing every in-flight upload with it.
     */
    private fun applyBotTaskEdit(botId: String, threadId: String, edit: (BotTask) -> BotTask) {
        _state.update { state ->
            val bot = state.bot(botId) ?: return@update state
            val tasks = bot.tasks ?: return@update state
            if (tasks.none { it.threadId == threadId }) return@update state
            state.apply(Frame.Bot(bot.copy(tasks = tasks.map { if (it.threadId == threadId) edit(it) else it })))
        }
    }

    private fun applyRoomTaskEdit(roomId: String, threadId: String, edit: (BotTask) -> BotTask) {
        _state.update { state ->
            val room = state.rooms.firstOrNull { it.id == roomId } ?: return@update state
            val tasks = room.tasks ?: return@update state
            if (tasks.none { it.threadId == threadId }) return@update state
            state.apply(Frame.Room(room.copy(tasks = tasks.map { if (it.threadId == threadId) edit(it) else it })))
        }
    }

    suspend fun renameTask(task: BotTask, forBot: Bot, title: String): Boolean = mutateTask(false) { client ->
        client.renameTask(forBot.id, task.threadId, title)
        applyBotTaskEdit(forBot.id, task.threadId) { it.copy(title = title) }
        true
    }

    suspend fun pinTask(task: BotTask, chat: Chat, pinned: Boolean): Boolean = mutateTask(false) { client ->
        when (chat) {
            is Chat.BotChat -> {
                client.setTaskPinned(chat.bot.id, task.threadId, pinned)
                applyBotTaskEdit(chat.bot.id, task.threadId) { it.copy(pinned = pinned) }
            }
            is Chat.RoomChat -> {
                client.setRoomTaskPinned(chat.room.id, task.threadId, pinned, task.title)
                applyRoomTaskEdit(chat.room.id, task.threadId) { it.copy(pinned = pinned) }
            }
        }
        true
    }

    suspend fun archiveTask(task: BotTask, forBot: Bot, archivedAt: Double?): Boolean = mutateTask(false) { client ->
        client.setTaskArchived(forBot.id, task.threadId, archivedAt)
        applyBotTaskEdit(forBot.id, task.threadId) { it.copy(archivedAt = archivedAt) }
        true
    }

    suspend fun deleteTask(task: BotTask, forBot: Bot): Bot? = mutateTask(null) { client ->
        client.deleteTask(forBot.id, task.threadId).also { updated ->
            _state.update { it.apply(Frame.Bot(updated)) }
        }
    }

    /** Snooze or wake one thread, applying the requested stamp on success. */
    suspend fun snoozeTask(task: BotTask, forBot: Bot, snoozedUntil: Long?): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.snoozeTask(forBot.id, task.threadId, snoozedUntil)
            applyBotTaskEdit(forBot.id, task.threadId) { it.copy(snoozedUntil = snoozedUntil?.toDouble()) }
            true
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    suspend fun createTask(forRoom: Room, title: String?): Room? = mutateTask(null) { client ->
        client.createRoomTask(forRoom.id, title).also { updated ->
            _state.update { it.apply(Frame.Room(updated)) }
        }
    }

    suspend fun switchTask(task: BotTask, forRoom: Room): Room? {
        if (task.threadId == forRoom.threadId) return forRoom
        return mutateTask(null) { client ->
            client.switchRoomTask(forRoom.id, task.threadId).also { updated ->
                _state.update { it.apply(Frame.Room(updated)) }
            }
        }
    }

    suspend fun renameTask(task: BotTask, forRoom: Room, title: String): Boolean = mutateTask(false) { client ->
        client.renameRoomTask(forRoom.id, task.threadId, title)
        applyRoomTaskEdit(forRoom.id, task.threadId) { it.copy(title = title) }
        true
    }

    suspend fun deleteTask(task: BotTask, forRoom: Room): Room? = mutateTask(null) { client ->
        client.deleteRoomTask(forRoom.id, task.threadId).also { updated ->
            _state.update { it.apply(Frame.Room(updated)) }
        }
    }

    suspend fun updateProfile(patch: BotProfilePatch, forBot: Bot): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.updateProfile(forBot.id, patch)
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    /**
     * The model catalog lives on the paired computer because availability
     * depends on which engines are installed and signed in there.
     */
    suspend fun modelInstances(): List<Instance> {
        val activeClient = client ?: return emptyList()
        return try {
            activeClient.instances()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            emptyList()
        }
    }

    suspend fun updateModel(selection: ModelSelection, forBot: Bot): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.updateModel(forBot.id, selection, forBot.threadId)
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated.forTask(forBot.threadId)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    /**
     * Ask the computer to summarize this thread's context. The 202 means the
     * work was accepted; the summary itself arrives on the stream as a message,
     * so there is nothing to apply here.
     */
    suspend fun compact(forBot: Bot): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.compact(forBot.id, forBot.threadId)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    suspend fun uploadAvatar(
        data: ByteArray,
        mime: String,
        forBot: Bot,
        crop: AvatarCrop,
    ): Bot? {
        val activeClient = client ?: return null
        return try {
            val avatarUrl = activeClient.uploadAvatar(data, mime)
            currentCoroutineContext().ensureActive()
            val current = _state.value.bot(forBot.id) ?: forBot
            updateProfile(
                BotProfilePatch(
                    avatarUrl = BotProfilePatch.AvatarURL.Set(avatarUrl),
                    avatarCrop = crop,
                ),
                current,
            )
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun generateAvatar(prompt: String, forBot: Bot): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.generateAvatar(forBot.id, prompt)
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun avatarData(forBot: Bot): ByteArray? {
        val path = forBot.avatarUrl ?: return null
        return avatarMedia(path)
    }

    suspend fun avatarMedia(path: String): ByteArray? = try {
        client?.avatar(path)
    } catch (error: Throwable) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        null
    }

    suspend fun generateAvatarState(
        forBot: Bot,
        state: String,
        style: String? = null,
        prompt: String? = null,
        resolution: String = "720p",
        loop: Boolean = state != "working",
    ): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.generateAvatarState(
                botId = forBot.id,
                state = state,
                style = style,
                prompt = prompt,
                resolution = resolution,
                loop = loop,
            )
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun uploadAvatarState(
        forBot: Bot,
        state: String,
        data: ByteArray,
        mime: String,
    ): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.uploadAvatarState(forBot.id, state, data, mime)
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun voiceOptions(): List<Voice> {
        val activeClient = client ?: return emptyList()
        return try {
            activeClient.voices()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            emptyList()
        }
    }

    suspend fun previewVoice(voiceId: String, forBot: Bot): ByteArray? {
        val activeClient = client ?: return null
        return try {
            activeClient.previewVoice("Hello, I'm ${forBot.name}.", voiceId)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun liveCallActive(): Boolean {
        val activeClient = client ?: throw APIError.Transport("此电脑当前离线。")
        val call = activeClient.liveCall() ?: return false
        return call.status != "ended"
    }

    /**
     * A reply as utterances the computer can voice, or `ready = false` when it
     * has no voice set up — so a call can say so rather than fall silent.
     * Throws: a call reads the failure itself instead of an action banner.
     */
    /** 自动朗读仲裁心跳；安静失败，断网就等于手机不在场。 */
    suspend fun reportReplySpeechListener(active: Boolean) {
        val activeClient = client ?: return
        try {
            activeClient.reportReplySpeechListener(active)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
        }
    }

    /** 自动朗读一个 turn 前认领它；离线按失败处理，不静默冒充成功。 */
    suspend fun claimReplySpeech(threadId: String, turnId: String?): Boolean {
        val activeClient = client ?: throw APIError.Transport("此电脑当前离线。")
        return activeClient.claimReplySpeech(threadId, turnId)
    }

    suspend fun prepareSpeech(text: String, voiceId: String?): PreparedSpeech {
        val activeClient = client ?: throw APIError.Transport("此电脑当前离线。")
        return activeClient.prepareSpeech(text, voiceId)
    }

    suspend fun speak(text: String, voiceId: String?): ByteArray {
        val activeClient = client ?: throw APIError.Transport("此电脑当前离线。")
        return activeClient.speak(text, voiceId)
    }

    /** 语音消息在电脑端转写；音频本体总会发送，所以失败只降级转写，不阻塞消息。 */
    suspend fun transcribeVoice(wav: ByteArray): VoiceTranscription {
        val activeClient = client ?: return VoiceTranscription(text = null, unavailable = true)
        return try {
            VoiceTranscription(
                text = activeClient.transcribe(wav).trim().ifEmpty { null },
                unavailable = false,
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            VoiceTranscription(text = null, unavailable = true)
        }
    }

    suspend fun updateVoiceProvider(provider: String): String? {
        val activeClient = client ?: return "此电脑当前离线。"
        return try {
            activeClient.updateVoiceProvider(provider)
            null
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            voiceWriteFailure(error)
        }
    }

    /**
     * 旧桌面拒绝手机的一切 `/api/config` 写入；新桌面也只接受窄口径语音引擎切换。
     * 403 原文写给 API 调用者，这里换成持机人能执行的去处。
     */
    private fun voiceWriteFailure(error: Throwable): String =
        if ((error as? APIError)?.isForbidden == true) {
            "新版电脑端已不允许手机修改语音设置，请在电脑上的 Luna Bot 中修改。"
        } else {
            error.message ?: "无法修改语音设置。"
        }

    suspend fun configStatus(): ConfigStatus? = try {
        client?.config()?.also { liveCallRelayCapable = it.hasSocketLiveCall }
    } catch (error: Throwable) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        null
    }

    /**
     * Switch the workspace's voice engine. The sheet reloads the voice list
     * afterwards, because every engine names its own voices.
     */
    suspend fun switchVoiceProvider(provider: VoiceProvider): ConfigStatus? {
        val activeClient = client ?: return null
        return try {
            activeClient.updateVoiceProvider(provider)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = voiceWriteFailure(error)
            null
        }
    }

    suspend fun loadConnectorCatalog(): ConnectorCatalog? {
        val activeClient = client ?: return null
        return try {
            activeClient.connectorCatalog()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun loadAllConnectorStatuses(): ConnectorStatuses? {
        val activeClient = client ?: return null
        return try {
            activeClient.allConnectorStatuses()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun authorizeConnector(slug: String, alias: String?): URI? {
        val activeClient = client ?: return null
        return try {
            activeClient.authorizeConnector(slug, alias)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    /** Revoke one connected account. The caller reloads the inventory. */
    suspend fun disconnectConnectorAccount(slug: String, accountId: String): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.deleteConnectorAccount(slug, accountId)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    /**
     * Resume or dismiss an inline connector request.
     *
     * The card is a message on the computer: the answer is a patch to that
     * message, which arrives over the event stream, so nothing is returned
     * here beyond "the request was accepted".
     */
    suspend fun connectorCardAction(
        botId: String,
        messageId: String,
        threadId: String,
        action: ConnectorCardAction,
    ): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.connectorCardAction(botId, messageId, threadId, action)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    /** The same for a credential request; the value itself stays on the host. */
    suspend fun secretCardAction(
        botId: String,
        messageId: String,
        threadId: String,
        action: SecretCardAction,
    ): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.secretCardAction(botId, messageId, threadId, action)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    /**
     * Submit an already sealed credential envelope. 4xx answers are authoritative;
     * transport/5xx uncertainty means the caller must retry the same envelope.
     */
    suspend fun provideSecretCard(
        botId: String,
        messageId: String,
        envelope: PhoneSecretCrypto.Envelope,
    ): SecretCardProvideResult {
        val activeClient = client ?: return SecretCardProvideResult.Unavailable
        val transport = activeClient.connection
        val transportKeyId = transport.secretPublicKey?.let { key ->
            runCatching { PhoneSecretCrypto.keyId(key) }.getOrNull()
        }
        if (
            transport.phoneSecretEntryBlocker() != null ||
            transportKeyId != envelope.keyId ||
            transport.companionDeviceId != envelope.deviceId
        ) {
            return SecretCardProvideResult.Blocked("当前连接不能安全提交凭据。请改用受保护路由，或重新扫码配对。")
        }
        return try {
            activeClient.provideSecretCard(botId, messageId, envelope)
            SecretCardProvideResult.Submitted
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            val status = error as? APIError.Status
            if (status != null && status.code in listOf(400, 401, 403, 404, 409)) {
                SecretCardProvideResult.Rejected(error.message ?: "电脑拒绝了这次凭据提交。")
            } else {
                SecretCardProvideResult.Uncertain(error.message ?: "凭据提交结果未知。请重试。")
            }
        }
    }

    /** Answer a sign-in card; false when the computer refused or could not be reached. */
    suspend fun signInCardAction(
        botId: String,
        messageId: String,
        threadId: String,
        action: SignInCardAction,
    ): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.signInCardAction(botId, messageId, threadId, action)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    suspend fun loadRoutines(): RoutinesResponse {
        val activeClient = client ?: return RoutinesResponse(emptyList(), emptyList())
        return try {
            activeClient.routines()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            RoutinesResponse(emptyList(), emptyList())
        }
    }

    suspend fun loadOverview(botId: String): BotOverview? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val overview = activeClient.overview(botId)
            currentCoroutineContext().ensureActive()
            overview.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            if (_connection.value?.id == connectionId) _actionError.value = error.message
            null
        }
    }

    /**
     * The bot's MCP servers, or null when the computer refused or could not be
     * reached. Null is a state the screen draws — a Team Cloud member's session
     * is refused by scope, and that is not worth an error banner.
     */
    suspend fun loadMcpServers(botId: String): List<McpServerEntry>? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val servers = activeClient.mcpServers(botId).servers
            currentCoroutineContext().ensureActive()
            servers.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    /**
     * 这个智能体的活动记录行，或 null——电脑拒答（团队成员会话没有 admin 范围）、
     * 版本太旧没有这条路由、或够不到电脑。与 [loadMcpServers] 同一个先例：
     * null 是屏幕要画的一种状态，不是错误横幅。
     */
    suspend fun loadBotActivity(botId: String, limit: Int = 300): List<BotActivityRow>? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val rows = activeClient.botActivity(botId, limit).rows
            currentCoroutineContext().ensureActive()
            rows.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    /**
     * 给被额度限制停住的回合安排「到点继续」。
     *
     * 404 与 403 都折成 [LimitResetContinueResult.Unavailable]：404 是旧版电脑
     * 没有这条路由（旁车对未放行的路由也答 404，两者本就不可区分）或会话已被
     * 删掉，403 是没有权限的会话——两种情形下按钮都该安静消失，而不是报错。
     */
    suspend fun continueAtLimitReset(botId: String, threadId: String): LimitResetContinueResult {
        val activeClient = client ?: return LimitResetContinueResult.Failed("此电脑当前离线。")
        return try {
            activeClient.continueAtLimitReset(botId, threadId)
            LimitResetContinueResult.Set
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            if (error is APIError.Status && (error.code == 404 || error.code == 403)) {
                LimitResetContinueResult.Unavailable
            } else {
                LimitResetContinueResult.Failed(error.message ?: "无法安排到点继续。")
            }
        }
    }

    // MARK: - 通知与收件箱
    //
    // 与 loadMcpServers 同一个纪律：拒答、旧电脑、够不到都不是错误横幅，
    // 折叠成屏幕要画的一种状态。

    /** 这台电脑的通知日志，或 null——电脑拒答、太旧或够不到。 */
    suspend fun loadNotifications(): List<NotificationLogRow>? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val rows = activeClient.notifications().notifications
            currentCoroutineContext().ensureActive()
            rows.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    /** 一条通知已读；false 静默——下一次刷新会带回真实状态。 */
    suspend fun markNotificationRead(id: String): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.markNotificationRead(id)
            true
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            false
        }
    }

    /** 全部通知已读；false 静默。 */
    suspend fun markAllNotificationsRead(): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.markAllNotificationsRead()
            true
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            false
        }
    }

    /**
     * 这个人的收件箱，三态分开是因为屏幕要画三种样子：[InboxResult.Loaded]
     * 画列表；[InboxResult.Missing] 画「这里没有收件箱」的说明（不是错误——
     * 团队云上没有收件箱的人、或没有这条路由的旧电脑，两者同码不可区分）；
     * [InboxResult.Unreachable] 是够不到电脑或电脑出错。
     */
    suspend fun loadInbox(): InboxResult {
        val activeClient = client ?: return InboxResult.Unreachable
        val connectionId = _connection.value?.id
        return try {
            val view = activeClient.inbox()
            currentCoroutineContext().ensureActive()
            if (_connection.value?.id == connectionId) InboxResult.Loaded(view) else InboxResult.Unreachable
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error is APIError.Status && error.code == 404) InboxResult.Missing else InboxResult.Unreachable
        }
    }

    /** 等待处理的行数，供入口行的徽章；任何失败都是 null——徽章静默缺席。 */
    suspend fun loadInboxCount(): Int? {
        val activeClient = client ?: return null
        return try {
            activeClient.inboxCount()
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    /**
     * 收件箱一行已读（[done] 为 false）或办结（true），成功时答回服务端的
     * 最新整个视图，调用方直接换列表。任何失败都是 null——行保持原样，
     * 下一次刷新带回真实状态；409（ask 必须回答不能办结）也走这条路。
     */
    suspend fun markInboxRow(id: String, done: Boolean): InboxViewResponse? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val view = activeClient.markInboxRow(id, done)
            currentCoroutineContext().ensureActive()
            view.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    // MARK: - 团队记忆

    /** 一个团队分区的共享记忆，或 null——拒答、旧电脑、够不到或分区已不存在。 */
    suspend fun loadTeamMemory(section: String): TeamMemoryResponse? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val view = activeClient.teamMemory(section)
            currentCoroutineContext().ensureActive()
            view.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    /** 共享记忆写入的统一折叠：409/428 是版本已被别处改走，其余失败都是不可用。 */
    private suspend fun writeTeamMemory(call: suspend (CompanionClient) -> TeamMemoryMutationResponse): TeamMemoryWriteResult {
        val activeClient = client ?: return TeamMemoryWriteResult.Unavailable
        val connectionId = _connection.value?.id
        return try {
            val view = call(activeClient)
            currentCoroutineContext().ensureActive()
            if (_connection.value?.id == connectionId) TeamMemoryWriteResult.Saved(view) else TeamMemoryWriteResult.Unavailable
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error is APIError.Status && (error.code == 409 || error.code == 428)) {
                TeamMemoryWriteResult.Changed
            } else {
                TeamMemoryWriteResult.Unavailable
            }
        }
    }

    suspend fun addTeamMemory(section: String, kind: String, name: String, detail: String): TeamMemoryWriteResult =
        writeTeamMemory { it.addTeamMemory(section, kind, name, detail) }

    suspend fun acceptTeamMemory(section: String, entry: TeamMemoryEntry): TeamMemoryWriteResult =
        writeTeamMemory { it.patchTeamMemory(section, entry.id, entry.revision, accept = true) }

    suspend fun editTeamMemory(section: String, entry: TeamMemoryEntry, name: String, detail: String): TeamMemoryWriteResult =
        writeTeamMemory { it.patchTeamMemory(section, entry.id, entry.revision, name = name, detail = detail) }

    suspend fun pinTeamMemory(section: String, entry: TeamMemoryEntry, pinned: Boolean): TeamMemoryWriteResult =
        writeTeamMemory { it.patchTeamMemory(section, entry.id, entry.revision, pinned = pinned) }

    suspend fun removeTeamMemory(section: String, entry: TeamMemoryEntry): TeamMemoryWriteResult =
        writeTeamMemory { it.deleteTeamMemory(section, entry.id, entry.revision) }

    // MARK: - Data 只读

    /** 这个智能体的 Data（sheet 与表目录），或 null——拒答、太旧、够不到或数据引擎不可用。 */
    /** 团队地图，或 null——连接失效/电脑太旧时干脆不画，同 loadBotData。 */
    suspend fun loadTeamMap(): TeamMapResponse? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val data = activeClient.teamMap()
            currentCoroutineContext().ensureActive()
            data.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    suspend fun loadBotData(botId: String): BotDataResponse? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val data = activeClient.botData(botId)
            currentCoroutineContext().ensureActive()
            data.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    /** 表或卡片结果的一页行，或 null——同上。 */
    suspend fun loadBotDataPage(botId: String, table: String?, cardId: String?, offset: Int, limit: Int): DataPageResponse? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val page = activeClient.botDataPage(botId, table, cardId, offset, limit)
            currentCoroutineContext().ensureActive()
            page.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    /** 图表卡的 PNG 字节，或 null——失败的图表干脆不画图，列表其余部分不受影响。 */
    suspend fun loadBotDataCardImage(botId: String, cardId: String, width: Int, scale: Int, dark: Boolean): ByteArray? {
        val activeClient = client ?: return null
        return try {
            activeClient.botDataCardImage(botId, cardId, width, scale, dark)
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            null
        }
    }

    // MARK: - Phone apps as bot tools
    //
    // These run in the background and must not paint the UI red: a refused
    // registration already has a consent screen, and a poll that fails while
    // the computer is asleep is ordinary. Failure is a return value.

    /** What the phone-tools runner last achieved, for the Settings row. */
    sealed interface PhoneToolsStatus {
        data object Idle : PhoneToolsStatus
        data object Registered : PhoneToolsStatus
        data class Failed(val message: String) : PhoneToolsStatus
    }

    private val _phoneToolsStatus = MutableStateFlow<PhoneToolsStatus>(PhoneToolsStatus.Idle)
    val phoneToolsStatus: StateFlow<PhoneToolsStatus> = _phoneToolsStatus.asStateFlow()

    /**
     * For the app's phone-tools runner: the status the Settings row shows.
     * Public because the runner lives in the app module, which cannot see
     * `internal` here.
     */
    fun reportPhoneTools(status: PhoneToolsStatus) {
        _phoneToolsStatus.value = status
    }

    /** Null on success, or the sentence that explains the refusal. */
    suspend fun registerPhone(registration: PhoneRegistration): String? {
        val active = client ?: return "尚未连接到这台电脑。"
        return try {
            active.registerPhone(registration)
            null
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            // A phone-tools refusal is read in Settings, not in a log: a transport
            // failure there is the computer being unreachable, and its raw OkHttp
            // text ("Failed to connect to /192.168…") is not a sentence for a
            // person. The connection advice already says it in Chinese.
            val connection = _connection.value
            if (error is APIError.Transport && connection != null) {
                ConnectionAdvice.message(error, connection.host, connection.port)
            } else {
                error.message ?: "无法在电脑上登记这台手机。"
            }
        }
    }

    suspend fun unregisterPhone(): Boolean = guardPhone {
        client?.unregisterPhone()
        true
    } ?: false

    /** True when the computer holds a registration for this phone; null when it could not be asked. */
    suspend fun myPhoneRegistered(): Boolean? = guardPhone { client?.myPhone() }

    // MARK: - Local VM takeover

    suspend fun takeLocalComputer(botId: String, leaseId: String): Boolean = guardPhone {
        client?.takeLocalComputer(botId, leaseId)?.held
    } ?: false

    suspend fun releaseLocalComputer(botId: String, leaseId: String): Boolean = guardPhone {
        client?.releaseLocalComputer(botId, leaseId)?.let { !it.held }
    } ?: false

    suspend fun joinLocalComputer(botId: String, leaseId: String): LocalComputerJoin? =
        guardPhone { client?.joinLocalComputer(botId, leaseId) }

    suspend fun closeComputerViewer(botId: String): Boolean = guardPhone {
        client?.closeComputerViewer(botId)
        true
    } ?: false

    /** Null when there is no paired client, or the address cannot be dialled. */
    fun openViewerSocket(path: String, listener: okhttp3.WebSocketListener): okhttp3.WebSocket? =
        try {
            client?.openViewerSocket(path, listener)
        } catch (_: Throwable) {
            null
        }

    /** Null under the same conditions as [openViewerSocket]. */
    fun openLiveCallSocket(botId: String, threadId: String, listener: okhttp3.WebSocketListener): okhttp3.WebSocket? =
        try {
            client?.openSocket(LiveRelay.PATH, LiveRelay.query(botId, threadId), listener)
        } catch (_: Throwable) {
            null
        }

    /**
     * Whether the computer can hold a socket-relay Live call: a provider the
     * relay speaks, with its key. Unreachable or not configured both read
     * false — the caller then falls back to the half-duplex call.
     */
    /**
     * Last confirmed socket-relay capability. The answer only changes when the
     * computer's Live settings change, so a transient probe miss keeps the
     * previous answer instead of silently picking the other call UI.
     */
    private var liveCallRelayCapable: Boolean? = null

    suspend fun liveCallRelayReady(): Boolean = try {
        val status = client?.config()
        com.lunabot.companion.core.e2e.E2eLog.line("relay probe client=${client != null} live=${status?.live} ready=${status?.hasSocketLiveCall}")
        if (status != null) liveCallRelayCapable = status.hasSocketLiveCall
        liveCallRelayCapable == true
    } catch (error: Throwable) {
        if (error is CancellationException) throw error
        com.lunabot.companion.core.e2e.E2eLog.line("relay probe failed: ${error::class.simpleName}: ${error.message}")
        liveCallRelayCapable == true
    }

    suspend fun pollPhoneJob(): PhoneJob? = try {
        client?.pollPhoneJob().also { lastPhonePollError = null }
    } catch (error: Throwable) {
        if (error is CancellationException) throw error
        lastPhonePollError = error.message ?: error::class.simpleName
        null
    }

    /**
     * Why the last poll returned nothing. Kept because the poll's failure is a
     * background one — the Settings row and the runner's log are the only
     * places it can be seen.
     */
    var lastPhonePollError: String? = null
        private set

    /** The computer's places search, with transport and provider failures kept distinct for the job answer. */
    suspend fun findNearbyPlaces(request: PhonePlacesRequest): PhonePlacesLookup {
        val active = client ?: return PhonePlacesLookup.Failure("尚未连接到这台电脑。", "offline")
        return try {
            PhonePlacesLookup.Success(active.findNearbyPlaces(request))
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError.Status) {
            val code = when (error.code) {
                503 -> "unconfigured"
                502 -> "upstream"
                403 -> "denied"
                404 -> "unsupported"
                else -> null
            }
            PhonePlacesLookup.Failure(error.serverMessage ?: error.message ?: "电脑上的地点搜索失败。", code)
        } catch (_: Throwable) {
            PhonePlacesLookup.Failure("无法连接电脑搜索附近地点。", "offline")
        }
    }

    suspend fun leasePhoneJob(jobId: String): Boolean =
        guardPhone { client?.leasePhoneJob(jobId) } ?: false

    suspend fun completePhoneJob(jobId: String, outcome: JsonObject): Boolean {
        // The post fails fast on purpose; a retry on a fresh connection is the
        // recovery for a dead pooled socket or a briefly congested computer.
        for (attempt in 1..2) {
            if (guardPhone {
                    client?.completePhoneJob(jobId, outcome)
                    true
                } == true
            ) {
                return true
            }
            if (attempt == 1) delay(1_000)
        }
        return false
    }

    /** Push one inbound SMS for the channels relay; false when the computer could not be told. */
    suspend fun postPhoneEvent(event: PhoneSmsEvent): Boolean {
        val active = client ?: return false
        return try {
            active.postPhoneEvent(event)
            true
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            com.lunabot.companion.core.e2e.E2eLog.line("sms post failed: ${error.message}")
            false
        }
    }

    /** Push one allowed notification for notice learning; false when the computer could not be told. */
    suspend fun postPhoneNotice(event: PhoneNoticeEvent): Boolean {
        val active = client ?: return false
        return try {
            active.postPhoneNotice(event)
            true
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            com.lunabot.companion.core.e2e.E2eLog.line("notice post failed: ${error.message}")
            false
        }
    }

    /** Push the shade's key set so the server can drop records already handled on the phone. */
    suspend fun postPhoneShade(event: PhoneShadeEvent): Boolean {
        val active = client ?: return false
        return try {
            active.postPhoneShade(event)
            true
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            com.lunabot.companion.core.e2e.E2eLog.line("shade post failed: ${error.message}")
            false
        }
    }

    private suspend fun <T> guardPhone(block: suspend () -> T?): T? = try {
        block()
    } catch (error: Throwable) {
        if (error is CancellationException) throw error
        // Job delivery, lease and result posts used to fail here without a trace.
        com.lunabot.companion.core.e2e.E2eLog.line("phone call failed: ${error.message}")
        null
    }

    suspend fun loadRoutineRunAvailability(): RoutineRunAvailability? {
        val activeClient = client ?: return null
        return try {
            coroutineScope {
                val config = async { activeClient.config() }
                val instances = async { activeClient.instances() }
                RoutineRunAvailability(config.await(), instances.await())
            }
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun saveRoutine(input: RoutineInput, id: String?): Routine? {
        val activeClient = client ?: return null
        return try {
            if (id == null) activeClient.createRoutine(input) else activeClient.updateRoutine(id, input)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun setRoutineEnabled(routine: Routine, enabled: Boolean): Routine? {
        val activeClient = client ?: return null
        return try {
            activeClient.setRoutineEnabled(routine.id, enabled)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun runRoutine(routine: Routine): RoutineRun? {
        val activeClient = client ?: return null
        return try {
            activeClient.runRoutine(routine.id)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun deleteRoutine(routine: Routine): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.deleteRoutine(routine.id)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    suspend fun markRoutineRunSeen(run: RoutineRun): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.markRoutineRunSeen(run.id)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    suspend fun cancelRoutineRun(run: RoutineRun): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.cancelRoutineRun(run.id)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    suspend fun react(to: Message, inThreadId: String, emoji: String) {
        val activeClient = client ?: return
        try {
            val patched = activeClient.toggleReaction(inThreadId, to.id, emoji)
            _state.update { it.apply(Frame.MessagePatch(inThreadId, patched)) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    /**
     * Edit and retry. The edited text replaces the old message on screen the
     * moment it is sent, hiding the old answer, and the computer's fork takes
     * over as soon as either its response or its stream frames land. A failed
     * edit simply drops the stand-in, so the old branch returns.
     */
    suspend fun edit(message: Message, forBot: Bot, text: String) {
        if (client == null) return
        val threadId = forBot.threadId
        val connectionId = _connection.value?.id
        val pending = PendingEdit(message.id, text, baseLeafId = _state.value.botForThread(threadId)?.activeLeafId)
        _state.update { it.copy(pendingEdits = it.pendingEdits + (threadId to pending)) }
        try {
            perform { activeClient ->
                val fork = activeClient.edit(forBot.id, message.id, text, threadId, pending.requestId)
                if (fork != null && _connection.value?.id == connectionId) {
                    _state.update { it.adoptEdit(fork, threadId, expectedPending = pending) }
                }
            }
        } finally {
            _state.update {
                if (it.pendingEdits[threadId] == pending) it.copy(pendingEdits = it.pendingEdits - threadId) else it
            }
        }
    }

    suspend fun switchVersion(to: Message, forBot: Bot) {
        val activeClient = client ?: return
        try {
            val leaf = activeClient.setActiveBranch(forBot.id, to.id, forBot.threadId)
            _state.update { it.apply(Frame.Thread(forBot.threadId, leaf)) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun export(threadId: String, format: String): ExportedTranscript? {
        val activeClient = client ?: return null
        return try {
            val exported = activeClient.export(threadId, format)
            ExportedTranscript(exported.data, exported.filename, exported.contentType)
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    private suspend fun perform(quietly: Boolean = false, body: suspend (CompanionClient) -> Unit): Boolean {
        val activeClient = client ?: return false
        val connectionId = _connection.value?.id
        try {
            body(activeClient)
            return true
        } catch (error: APIError) {
            if (error.isUnauthorized) {
                gate.withLock {
                    // Only the live computer's 401 may mark this session revoked.
                    if (connectionId != null && _connection.value?.id == connectionId) {
                        _status.value = Status.Unauthorized
                    }
                }
            } else if (!quietly) {
                _actionError.value = error.message
            }
        } catch (error: Throwable) {
            if (!quietly) _actionError.value = error.message
        }
        return false
    }

    companion object {
        private const val PRESENCE_FLOOR_MS = 5_000L
        private const val PRESENCE_REPEAT_MS = 60_000L
        const val STORAGE_UNAVAILABLE_MESSAGE =
            "此手机刚才无法读取已保存的连接信息。"
        const val SPENT_QR_MESSAGE =
            "该配对码已被使用。请在电脑上重新发起配对，并重新扫描新的二维码。"
        const val THREAD_GONE_MESSAGE = "该会话已不在你的电脑上。"

        /** High-entropy QR token — distinct from a retryable six-digit code. */
        fun isQrCredential(credential: String): Boolean =
            credential.startsWith("omb_pair_") ||
                !(credential.length == 6 && credential.all { it in '0'..'9' })
    }
}

/** Thrown only when another pairing redemption is already running. */
class PairingInProgressException : IllegalStateException("另一个配对请求正在进行中。")

/** Thrown when a burned QR credential is presented again. */
class SpentPairingCredentialException : IllegalStateException(Session.SPENT_QR_MESSAGE)

/** What became of an in-chat Claude Code update. */
sealed interface ClaudeUpdateResult {
    data class Updated(val version: String) : ClaudeUpdateResult
    data class Failed(val message: String) : ClaudeUpdateResult
}

/** 「到点继续」安排的结果。 */
sealed interface LimitResetContinueResult {
    /** 安排好了：新建的（201）或早已存在的（200）都算，两者是同一个终态。 */
    data object Set : LimitResetContinueResult

    /** 这台电脑没有这个能力或不允许这个会话用——按钮安静消失，不报错。 */
    data object Unavailable : LimitResetContinueResult

    data class Failed(val message: String) : LimitResetContinueResult
}

sealed interface TeamMemoryWriteResult {
    data class Saved(val mutation: TeamMemoryMutationResponse) : TeamMemoryWriteResult
    data object Changed : TeamMemoryWriteResult
    data object Unavailable : TeamMemoryWriteResult
}

/** 收件箱的读取结果，三态各是屏幕要画的一种样子。 */
sealed interface InboxResult {
    data class Loaded(val view: InboxViewResponse) : InboxResult

    /** 这里没有收件箱（团队云上没有的人，或太旧的电脑）——画一行说明，不是错误。 */
    data object Missing : InboxResult

    /** 够不到电脑或电脑出错——与 Missing 分开，因为这台电脑明明该有。 */
    data object Unreachable : InboxResult
}
