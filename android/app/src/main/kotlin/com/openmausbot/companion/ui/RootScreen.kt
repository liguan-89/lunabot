package com.openmausbot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.NotificationAuthorizationState
import com.openmausbot.companion.core.NotificationOnboardingPolicy
import com.openmausbot.companion.core.NotificationTarget
import com.openmausbot.companion.core.OnboardingContext
import com.openmausbot.companion.core.OnboardingPairingState
import com.openmausbot.companion.core.OnboardingRoute
import com.openmausbot.companion.core.OnboardingRouter
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.storage.ThemeMode
import kotlinx.coroutines.launch

/**
 * Which of the six worlds the app is in — the port of `RootView` in
 * `ios/App/CompanionApp.swift`.
 *
 * The decision itself is not here. It is
 * [com.openmausbot.companion.core.OnboardingRouter], in `:core`, because the
 * orderings that matter are invisible until they are wrong: revocation has to
 * outrank a pending deep link, a deep link has to outrank the unpaired home,
 * and a
 * pairing someone already had must never be handed first-pair education. This
 * file's job is to hand the router honest inputs and to render what it answers.
 *
 * **Nothing here asks the system for a permission.** It used to: the first frame
 * fired a batch request for notifications *and* nearby devices before the app
 * had said what it was, which made refusing both the reasonable answer. Each
 * permission now belongs to the moment it is earned — notifications to the
 * explained step after a first pairing ([NotificationOnboardingScreen]), nearby
 * devices to opening the list of computers ([PairingScreen]).
 */
@Composable
fun CompanionRoot(
    pendingNotification: NotificationTarget?,
    onPendingTargetConsumed: (NotificationTarget) -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val onboarding = environment.onboarding
    val scope = rememberCoroutineScope()

    val status by session.status.collectAsState()
    val connection by session.connection.collectAsState()
    val connections by session.connections.collectAsState()
    val pairingRequested by session.pairingRequested.collectAsState()
    val invite by session.pairingInvite.collectAsState()
    val restoreState by session.restoreState.collectAsState()
    val notificationAccess by environment.notifications.access.collectAsState()
    val notificationPromptSeen by onboarding.notificationPromptSeen.collectAsState()
    val notificationPending by onboarding.notificationPending.collectAsState()

    // Settings, reachable from the unpaired home. iOS puts it in a toolbar
    // `NavigationLink`; there is no navigator in the unpaired world, so this is
    // the whole of that stack.
    var showingUnpairedSettings by rememberSaveable { mutableStateOf(false) }
    var enablingNotifications by remember { mutableStateOf(false) }

    val authorization = notificationAuthorization(notificationAccess)
    val route = OnboardingRouter.route(
        OnboardingContext(
            pairingState = onboardingPairingState(status, connection),
            pairingRequested = pairingRequested,
            hasPendingPairingInvite = invite != null,
            notificationOnboardingPending = notificationPending,
            hasSeenNotificationPrompt = notificationPromptSeen,
            notificationAuthorization = authorization,
        ),
    )

    /**
     * Settle the durable marker against what is now known.
     *
     * Reads the flows rather than the values captured by this composition: the
     * coroutine may run after another write landed, and the marker is the one
     * piece of state here that a stale snapshot could destroy.
     */
    fun reconcileNotificationOnboarding() {
        scope.launch {
            onboarding.setNotificationOnboardingPending(
                NotificationOnboardingPolicy.shouldKeepPending(
                    isPending = onboarding.notificationPending.value,
                    hasCompletedStep = onboarding.notificationPromptSeen.value,
                    authorization = authorization,
                ),
            )
        }
    }

    fun startPairing() {
        session.beginPairing()
    }

    /**
     * Both answers to the education step end it: the step records that it was
     * answered, and that is *all* it records.
     *
     * Spending the marker is deliberately not done here. It belongs to
     * [NotificationOnboardingPolicy] and reaches disk through the one
     * reconciliation below, so there is a single place that decides when a
     * marker is spent instead of three that have to agree.
     */
    fun finishNotificationStep() {
        scope.launch { onboarding.setNotificationPromptSeen(true) }
    }

    // Back closes Settings rather than the app. The paired world gets this from
    // its navigator; the unpaired home has no navigator, and without this line
    // the first thing a person who opened Settings from it presses puts them
    // back on the launcher.
    BackHandler(enabled = showingUnpairedSettings) { showingUnpairedSettings = false }
    // Leaving this world closes it too, so a later unpair does not land on a
    // Settings screen nobody asked for.
    LaunchedEffect(route) {
        if (route != OnboardingRoute.UNPAIRED_HOME) showingUnpairedSettings = false
    }

    // The only thing that spends the marker. One effect, keyed on every input
    // the policy reads, so it runs at launch and again whenever any of them
    // moves — an answer arriving, the step being answered, a fresh pairing
    // setting the marker. Splitting this across the screens that happen to be
    // on top when each changes is how a rule ends up true in one copy and false
    // in another.
    LaunchedEffect(authorization, notificationPromptSeen, notificationPending) {
        reconcileNotificationOnboarding()
    }

    // Resolve above every screen so a tap while unpaired or unauthorized is
    // consumed (and cannot open against the next bond). Re-runs when restoreState
    // leaves Pending so a deferred target is not stranded after a cold-start
    // restore that finishes unpaired. The coordinator owns every consume:
    // identified no-chat inside onPending, and navigate→consume inside commit.
    // RootScreen cannot omit or invert.
    val tapCoordinator = remember { NotificationTapCoordinator() }
    val resolution by tapCoordinator.resolution.collectAsState()
    // Persistable: bumping this keys the navigator saver with a generation that
    // is also written into the saved value, so a stack captured while
    // Unauthorized/Unpaired was landing cannot restore after the next pair (§6).
    var bondGeneration by rememberSaveable { mutableIntStateOf(0) }

    LaunchedEffect(status) {
        if (NotificationTapCoordinator.leavesBond(status)) {
            tapCoordinator.discardResolved()
            bondGeneration += 1
        }
    }
    LaunchedEffect(pendingNotification, status, restoreState) {
        val target = pendingNotification ?: return@LaunchedEffect
        tapCoordinator.onPending(session, target, onPendingTargetConsumed)
    }

    // A draft names a thread on one computer. Pairing again, or switching to
    // another computer, replaces the fleet; a half-typed line from the old one
    // must not reappear under the new names.
    val boundComputer by session.connection.collectAsState()
    var draftsComputer by remember { mutableStateOf(boundComputer?.id) }
    LaunchedEffect(boundComputer?.id) {
        if (boundComputer?.id != draftsComputer) {
            draftsComputer = boundComputer?.id
            environment.chatDrafts.clearAll()
        }
    }

    // The phone's answer unless someone chose otherwise in Settings → 外观.
    val themeMode by environment.chatPreferences.themeMode.collectAsState()
    val systemDark = isSystemInDarkTheme()
    val darkTheme = when (themeMode) {
        ThemeMode.SYSTEM -> systemDark
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }

    CompanionTheme(darkTheme = darkTheme) {
        // One place for system insets: the app draws edge to edge, and every
        // screen keeps clear of the gesture bar and keyboard. Conversation
        // owns its top inset so the transcript and its haze can reach the
        // status bar; other destinations keep the shared safe area.
        //
        // The strips outside the inset Surface are painted here, and a screen
        // that is deliberately full-bleed (the computer viewer) may replace
        // that colour for as long as it is the one on screen.
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(SystemBarBackdrop.color ?: minisCanvas),
        ) {
            Surface(
                color = minisCanvas,
                modifier = Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(
                        WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal),
                    )
                    .imePadding(),
            ) {
                // A face that has not been touched in a while falls asleep. The
                // clock only needs to know that a finger moved somewhere on the
                // screen, so this observes the Initial pass and consumes
                // nothing — every gesture below still arrives untouched.
                val faceClock = rememberFaceClock()
                // The observer's own origin, so a local touch can be handed to
                // the face in window pixels — the same space the portrait
                // measures itself in.
                val observerOrigin = remember { mutableStateOf(Offset.Zero) }
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .then(
                            if (route == OnboardingRoute.CHATS) Modifier
                            else Modifier.windowInsetsPadding(
                                WindowInsets.safeDrawing.only(WindowInsetsSides.Top),
                            ),
                        )
                        .onGloballyPositioned { observerOrigin.value = it.positionInWindow() }
                        .pointerInput(faceClock) {
                            val clock = faceClock ?: return@pointerInput
                            awaitPointerEventScope {
                                while (true) {
                                    val event = awaitPointerEvent(PointerEventPass.Initial)
                                    val change = event.changes.firstOrNull { it.pressed }
                                    if (change != null) {
                                        clock.touched(
                                            observerOrigin.value.x + change.position.x,
                                            observerOrigin.value.y + change.position.y,
                                        )
                                    } else {
                                        clock.touch()
                                    }
                                }
                            }
                        },
                ) {
                    when (route) {
                        OnboardingRoute.PAIRING -> {
                            // Being on this screen *is* the request, and it is what
                            // keeps the screen up after `PairingScreen` consumes the
                            // invite that opened it — at which point
                            // `hasPendingPairingInvite` goes false and this is the only
                            // thing left holding the route.
                            LaunchedEffect(Unit) {
                                session.beginPairing()
                            }
                            PairingScreen(
                                onCancel = { session.endPairing() },
                            )
                        }

                        OnboardingRoute.UNPAIRED_HOME -> when {
                            // A stored bond has not been read yet, so "unpaired"
                            // is not an answer — only the absence of one. Show
                            // the mark until the read says which world this is.
                            // An Offline status is the exception: Pending then
                            // means the read failed, and that is an answer the
                            // unpaired home can show (and Settings can explain).
                            restoreState is Session.RestoreState.Pending &&
                                status !is Session.Status.Offline -> StartingScreen()
                            showingUnpairedSettings -> {
                                // The same Settings screen, minus what needs a pairing.
                                // Notifications can be recovered from here without first
                                // entering a connection flow this person just declined.
                                SettingsScreen(
                                    onBack = { showingUnpairedSettings = false },
                                    onConnect = {
                                        showingUnpairedSettings = false
                                        startPairing()
                                    },
                                )
                            }
                            else -> UnpairedHomeScreen(
                                onConnect = ::startPairing,
                                onOpenSettings = { showingUnpairedSettings = true },
                            )
                        }

                        OnboardingRoute.NOTIFICATION_PROMPT -> {
                            NotificationOnboardingScreen(
                                enabling = enablingNotifications,
                                onEnable = {
                                    enablingNotifications = true
                                    scope.launch {
                                        // Marked before the prompt is launched, the way
                                        // [PermissionRequests] records every asking as
                                        // part of launching it: a process that dies while
                                        // the system sheet is up has still spent the
                                        // prompt, and re-showing this step afterwards
                                        // would offer a button the OS silently drops.
                                        onboarding.setNotificationPromptSeen(true)
                                        environment.notifications.act()
                                        enablingNotifications = false
                                    }
                                },
                                onSkip = ::finishNotificationStep,
                            )
                        }

                        OnboardingRoute.CHATS -> {
                            PairedScreen(
                                resolution = resolution,
                                bondGeneration = bondGeneration,
                                onCommit = { held, navigator ->
                                    tapCoordinator.commit(held, navigator, onPendingTargetConsumed)
                                },
                            )
                        }

                        OnboardingRoute.REVOKED -> UnpairedScreen(
                            onPairAgain = {
                                session.signOut()
                                startPairing()
                            },
                            onChooseAnother = connections.firstOrNull { it.id != connection?.id }
                                ?.let { other -> { session.switchComputer(other.id) } },
                        )
                    }
                    val pendingShare by environment.shareInbox.pending.collectAsState()
                    pendingShare?.let { share ->
                        ShareSheet(pending = share, onDismiss = environment.shareInbox::consume)
                    }

                    // Pairing failures are shown inline on the pairing form, where
                    // the action was — a modal on top of it would say the same
                    // thing twice. Every other action error lands in the bottom
                    // notice rather than a dialog: the failed action happened on
                    // the screen the person is already looking at, so the answer
                    // belongs there and must not interrupt them mid-gesture.
                    if (route != OnboardingRoute.PAIRING) {
                        ActionNoticeHost(session)
                    }
                }
            }
        }
    }
}

/**
 * Which of the three worlds the pairing is in, as the router asks the question.
 *
 * Revocation is tested first and unconditionally. A token the computer retired
 * is not an empty state and not a pairing: it has its own screen, and no pending
 * invite or requested pairing may push it aside.
 */
internal fun onboardingPairingState(
    status: Session.Status,
    connection: Connection?,
): OnboardingPairingState = when {
    status is Session.Status.Unauthorized -> OnboardingPairingState.REVOKED
    connection != null -> OnboardingPairingState.PAIRED
    else -> OnboardingPairingState.UNPAIRED
}

/**
 * The notification permission, as the marker's lifecycle asks about it.
 *
 * Android answers synchronously — `areNotificationsEnabled()` and
 * `shouldShowRequestPermissionRationale()` both return immediately — so unlike
 * iOS there is no launch window here where the answer is unknown, and
 * [NotificationAuthorizationState.UNRESOLVED] is not produced by this mapping.
 * It exists in the router because the rule it carries is the marker's
 * protection, not iOS's async quirk.
 *
 * [NotificationAccess.BLOCKED] is DETERMINED rather than a fourth case: it means
 * the system will not ask again — pre-33, where there is no runtime permission
 * at all, or a prompt already spent. Education that ends in a button the OS
 * silently drops is worse than no education, so the step is skipped and Settings
 * keeps the recovery path.
 */
internal fun notificationAuthorization(
    access: NotificationAccess,
): NotificationAuthorizationState = when (access) {
    NotificationAccess.ASKABLE -> NotificationAuthorizationState.NOT_DETERMINED
    NotificationAccess.GRANTED, NotificationAccess.BLOCKED ->
        NotificationAuthorizationState.DETERMINED
}

@Composable
private fun PairedScreen(
    resolution: NotificationTapCoordinator.Resolution?,
    bondGeneration: Int,
    onCommit: (NotificationTapCoordinator.Resolution, CompanionNavigator) -> Unit,
) {
    val navigator = rememberCompanionNavigator(bondGeneration)

    // Session already resolved the exact task; the coordinator records the
    // stack and consumes in one commit — keyed on generation so a superseded
    // tap cannot run against a newer pending target.
    LaunchedEffect(resolution?.generation) {
        val held = resolution ?: return@LaunchedEffect
        onCommit(held, navigator)
    }

    BackHandler(enabled = navigator.canGoBack) { navigator.pop() }

    // The stack is one place; moving through it gets one transition. Push and
    // pop slide opposite ways so the gesture and the motion agree, and a task
    // switch inside a conversation does not slide at all (same content key) —
    // the person did not travel, the address changed.
    AnimatedContent(
        targetState = navigator.current,
        transitionSpec = {
            when (navigator.lastMotion) {
                NavMotion.NONE -> fadeIn(tween(180)) togetherWith fadeOut(tween(120))
                NavMotion.FORWARD -> {
                    (slideInHorizontally(tween(NAV_MILLIS)) { it / 4 } + fadeIn(tween(NAV_MILLIS))) togetherWith
                        (slideOutHorizontally(tween(NAV_MILLIS)) { -it / 4 } + fadeOut(tween(NAV_MILLIS - 80)))
                }
                NavMotion.BACK -> {
                    (slideInHorizontally(tween(NAV_MILLIS)) { -it / 4 } + fadeIn(tween(NAV_MILLIS))) togetherWith
                        (slideOutHorizontally(tween(NAV_MILLIS)) { it / 4 } + fadeOut(tween(NAV_MILLIS - 80)))
                }
            }
        },
        contentKey = { destination ->
            // Every conversation is the same place on screen. Addressing another
            // task under it must not count as new travel.
            if (destination is Destination.Conversation) "conversation" else destination
        },
        label = "destination",
    ) { destination ->
        DestinationContent(destination, navigator)
    }
}

private const val NAV_MILLIS = 300

/** The one place a destination becomes a screen. */
@Composable
private fun DestinationContent(destination: Destination, navigator: CompanionNavigator) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .then(
                if (destination is Destination.Conversation) Modifier
                else Modifier.windowInsetsPadding(
                    WindowInsets.safeDrawing.only(WindowInsetsSides.Top),
                ),
            ),
    ) {
    when (destination) {
        Destination.Roster -> RosterScreen(navigator)
        Destination.Settings -> SettingsScreen(
            onBack = navigator::pop,
            onOpenRoutines = { navigator.push(Destination.Routines) },
            onOpenConnectedApps = { navigator.push(Destination.ConnectedApps) },
            onOpenVoice = { navigator.push(Destination.Voice) },
        )
        Destination.Routines -> TasksRoutinesScreen(
            onBack = navigator::pop,
            // A receipt's "Open task" pushes the chat above this screen, the way
            // iOS appends it to the same navigation path.
            onOpenChat = navigator::open,
        )
        Destination.ConnectedApps -> ConnectedAppsScreen(onBack = navigator::pop)
        Destination.Voice -> VoiceSettingsScreen(onBack = navigator::pop)
        // One branch for both shapes of chat address, so a notification's thread
        // becoming an addressed chat re-reads the same screen instead of
        // rebuilding it.
        is Destination.Conversation -> ChatScreen(
            destination = destination,
            onResolved = { target ->
                navigator.selectTask(destination, target)
            },
            onBack = navigator::pop,
            onOpenComputer = { navigator.push(Destination.Computer(it)) },
            onOpenOverview = { navigator.push(Destination.Overview(it)) },
            // Push Computer keeps the chat under the top; pop to roster does not.
            retainsDraft = navigator::retainsChatDraft,
            onOpenChat = navigator::open,
        )
        is Destination.Computer -> ComputerScreen(
            botId = destination.botId,
            onBack = navigator::pop,
        )
        is Destination.Overview -> BotOverviewScreen(
            botId = destination.botId,
            onBack = navigator::pop,
            onOpenRoutines = { navigator.push(Destination.BotRoutines(it)) },
            onOpenComputer = { navigator.push(Destination.Computer(it)) },
        )
        is Destination.BotRoutines -> TasksRoutinesScreen(
            onBack = navigator::pop,
            onOpenChat = navigator::open,
            botId = destination.botId,
        )
    }
    }
}

/**
 * The token stopped working. Almost always because someone revoked this phone on
 * the computer — which is exactly what that button is for, so the honest thing is
 * to say so and offer to pair again.
 */
@Composable
private fun UnpairedScreen(onPairAgain: () -> Unit, onChooseAnother: (() -> Unit)? = null) {
    EmptyState(
        title = "此手机已取消配对",
        description = "此手机已从电脑的「手机和设备」中移除，或配对已被重置。",
    ) {
        Button(onClick = onPairAgain) { Text("重新配对") }
        onChooseAnother?.let { choose ->
            TextButton(onClick = choose) { Text("使用其他电脑") }
        }
    }
}

/** SwiftUI's `ContentUnavailableView`, near enough. */
@Composable
fun EmptyState(
    title: String,
    description: String,
    modifier: Modifier = Modifier,
    actions: @Composable () -> Unit = {},
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            text = description,
            style = MaterialTheme.typography.bodyMedium,
            color = secondaryTint,
            textAlign = TextAlign.Center,
        )
        actions()
    }
}
