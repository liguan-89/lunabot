package com.openmausbot.companion.phoneui

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import java.util.UUID
import kotlin.text.isNullOrEmpty
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One element of an observed snapshot, already redacted and clamped. */
data class PhoneUiElement(
    val ref: String,
    val viewId: String?,
    val className: String?,
    val text: String?,
    val description: String?,
    /** Left, top, right, bottom in the target display's screen coordinates. */
    val bounds: List<Int>,
    val clickable: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val password: Boolean,
)

/** A snapshot of one virtual display's application windows, with its refs held in memory. */
data class PhoneUiSnapshot(
    val id: String,
    val displayId: Int,
    val takenAtMs: Long,
    val truncated: Boolean,
    val elements: List<PhoneUiElement>,
)

/**
 * The accessibility side of the phone-UI slice. It exposes no user-facing
 * behaviour: connected instances are published on [instance] so the executor
 * can fail closed when the service is off, and [snapshot] reads the
 * system-provided UI tree of one caller-supplied helper virtual display.
 *
 * Security invariants:
 * - only TYPE_APPLICATION windows of the requested display are read;
 * - password fields are never read — their text and description stay null;
 * - node refs are opaque and die with the snapshot ([refs]);
 * - nothing here captures or returns screen pixels.
 */
class PhoneUiAccessibilityService : AccessibilityService() {
    companion object {
        private val _instance = MutableStateFlow<PhoneUiAccessibilityService?>(null)

        /** The connected service, or null while Android's accessibility switch is off. */
        val instance: StateFlow<PhoneUiAccessibilityService?> = _instance.asStateFlow()

        private const val EVENT_TIMEOUT_MS = 100L
        private const val SETTINGS_PACKAGE = "com.android.settings"
        private const val PAIRING_NODE_LIMIT = 400
        private const val PAIRING_TEXT_LIMIT = 200
        private const val PAIRING_READ_DEPTH = 30

        /** Fingerprints stay cheap: the first few hundred nodes are enough to see a screen change. */
        private const val FINGERPRINT_NODES = 300
        private const val FNV_OFFSET = -3750763034362895579L
        private const val FNV_PRIME = 1099511628211L
    }

    private val refLock = Any()
    val refs = PhoneUiRefRegistry<AccessibilityNodeInfo>()

    /** The display the current snapshot was taken on; -1 before the first snapshot. */
    private var snapshotDisplayId: Int = -1

    /** When the last accessibility event of any kind arrived, for quiet-time measurement. */
    private var lastEventAtMs = 0L

    /** When the person last touched the phone's own screen, or 0. */
    private val mainTouchAtMs = java.util.concurrent.atomic.AtomicLong(0L)

    val lastMainScreenTouchAtMs: Long get() = mainTouchAtMs.get()

    internal inline fun <T> withLatestSnapshot(block: () -> T): T = synchronized(refLock, block)

    override fun onServiceConnected() {
        // Merged onto whatever the manifest's meta-data configures, so this
        // class never silently narrows a configuration the manifest chose.
        serviceInfo = serviceInfo.apply {
            flags = flags or
                AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            eventTypes = eventTypes or AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                AccessibilityEvent.TYPE_VIEW_CLICKED or
                AccessibilityEvent.TYPE_TOUCH_INTERACTION_START
            feedbackType = feedbackType or AccessibilityServiceInfo.FEEDBACK_GENERIC
            notificationTimeout = EVENT_TIMEOUT_MS
        }
        _instance.value = this
    }

    override fun onUnbind(intent: Intent?): Boolean {
        forgetInstance()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        forgetInstance()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val now = System.currentTimeMillis()
        lastEventAtMs = now
        // A touch on the person's own screen means they are driving; a spill
        // check must not move what they just opened themselves.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            event.displayId == Display.DEFAULT_DISPLAY && isUserTouch(event.eventType)
        ) {
            mainTouchAtMs.set(now)
        }
        // Only a window change means a different window is in front, so refs
        // issued for the previous window must not resolve. Content changes are
        // routine — clocks tick, lists scroll and the UI updates after our own
        // taps — so clearing on those would invalidate a ref between the
        // observe and the action that follows it. Node liveness is checked in
        // [resolveNode] instead.
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val eventDisplayId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            event.displayId
        } else {
            synchronized(refLock) {
                windows.firstOrNull { it.id == event.windowId }?.let { Display.DEFAULT_DISPLAY }
            } ?: return
        }
        synchronized(refLock) {
            if (eventDisplayId == snapshotDisplayId) {
                refs.clear()
                snapshotDisplayId = -1
            }
        }
    }

    override fun onInterrupt() = Unit

    /**
     * Observe application windows on [displayId]. Null below Android 11, where
     * the accessibility API cannot select window groups by display.
     */
    fun snapshot(displayId: Int): PhoneUiSnapshot? = synchronized(refLock) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return@synchronized null
        val id = UUID.randomUUID().toString()
        refs.rotate(id)
        snapshotDisplayId = displayId
        val builder = Builder(id)
        val windows = runCatching { windowsOnAllDisplays[displayId].orEmpty() }.getOrDefault(emptyList())
        for (window in windows) {
            if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
            val root = window.root ?: continue
            builder.walk(root)
        }
        builder.build(displayId)
    }

    /**
     * The node behind [ref], only when the ref belongs to the latest snapshot
     * and that snapshot was taken on [displayId]. This is the only way a bot
     * action reaches a node. The node is refreshed first: content updates can
     * detach it without a window change, and a detached node must not be acted
     * on.
     */
    fun resolveNode(ref: String?, displayId: Int): AccessibilityNodeInfo? {
        if (displayId != snapshotDisplayId) return null
        val node = refs.resolve(ref) ?: return null
        return if (runCatching { node.refresh() }.getOrDefault(false)) node else null
    }

    /**
     * One reading for [PhoneUiStability]: the tree fingerprint plus how long
     * the screen has been quiet. Registers no refs, so it never invalidates a
     * snapshot a bot is still working from.
     */
    fun reading(displayId: Int): PhoneUiStability.Reading =
        PhoneUiStability.Reading(
            fingerprint(displayId),
            (System.currentTimeMillis() - lastEventAtMs).coerceAtLeast(0),
        )

    /**
     * A cheap fingerprint of the application windows on [displayId]: node
     * count, classes, text, descriptions and bounds, folded with FNV-1a.
     * Password fields contribute their bounds only. Two screens that look the
     * same to a bot produce the same fingerprint, which is exactly what
     * "did my action change anything" needs.
     */
    fun fingerprint(displayId: Int): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "unsupported"
        var hash = FNV_OFFSET
        var count = 0
        val windows = runCatching { windowsOnAllDisplays[displayId].orEmpty() }.getOrDefault(emptyList())
        for (window in windows) {
            if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
            val root = window.root ?: continue
            val seen = HashSet<AccessibilityNodeInfo>()
            val pending = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
            pending.addLast(root to 0)
            while (pending.isNotEmpty() && count < FINGERPRINT_NODES) {
                val (node, depth) = pending.removeFirst()
                if (!seen.add(node)) continue
                count++
                val password = runCatching { node.isPassword }.getOrDefault(false)
                val text = if (password) null else runCatching { node.text?.toString() }.getOrNull()
                val description = if (password) null else runCatching { node.contentDescription?.toString() }.getOrNull()
                val className = runCatching { node.className?.toString() }.getOrNull()
                val bounds = runCatching { Rect().also(node::getBoundsInScreen) }.getOrNull()
                hash = fold(hash, text)
                hash = fold(hash, description)
                hash = fold(hash, className)
                hash = fold(hash, bounds?.let { "${it.left},${it.top},${it.right},${it.bottom}" })
                if (depth < PhoneUiRules.MAX_TREE_DEPTH) {
                    for (index in 0 until node.childCount) {
                        node.getChild(index)?.let { pending.addLast(it to depth + 1) }
                    }
                }
            }
        }
        return "$count:${java.lang.Long.toHexString(hash)}"
    }

    private fun fold(hash: Long, value: String?): Long {
        val next = (hash xor (value?.hashCode()?.toLong() ?: 0L)) * FNV_PRIME
        return next
    }

    private fun isUserTouch(eventType: Int): Boolean = when (eventType) {
        AccessibilityEvent.TYPE_VIEW_CLICKED,
        AccessibilityEvent.TYPE_TOUCH_INTERACTION_START,
        -> true
        else -> false
    }

    /**
     * The system pairing dialog's code and port, read from the Settings windows
     * on the default display. Null when the dialog is not showing, when
     * accessibility is off, or when the read is ambiguous.
     *
     * This is the only read outside the helper's own displays. The controller
     * calls it only while the pairing sheet's auto-read window is open; it
     * filters to the Settings package, skips password fields, registers no
     * refs and never logs what it read.
     */
    fun readPairingCode(): PhoneUiPairingCode? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val perWindow = runCatching {
            windows.orEmpty().mapNotNull { window ->
                if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION) return@mapNotNull null
                val root = window.root ?: return@mapNotNull null
                if (runCatching { root.packageName?.toString() }.getOrNull() != SETTINGS_PACKAGE) {
                    return@mapNotNull null
                }
                collectTexts(root)
            }
        }.getOrDefault(emptyList())
        return PhoneUiPairingScreen.read(perWindow)
    }

    /** Bounded, side-effect-free text collection for [readPairingCode]. */
    private fun collectTexts(root: AccessibilityNodeInfo): List<String> {
        val texts = ArrayList<String>()
        val seen = HashSet<AccessibilityNodeInfo>()
        val pending = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        pending.addLast(root to 0)
        var visited = 0
        while (pending.isNotEmpty() && visited < PAIRING_NODE_LIMIT && texts.size < PAIRING_TEXT_LIMIT) {
            val (node, depth) = pending.removeFirst()
            visited++
            if (!seen.add(node)) continue
            val password = runCatching { node.isPassword }.getOrDefault(false)
            if (!password) {
                runCatching { node.text?.toString() }.getOrNull()?.let(texts::add)
                runCatching { node.contentDescription?.toString() }.getOrNull()?.let(texts::add)
            }
            if (depth < PAIRING_READ_DEPTH) {
                for (index in 0 until node.childCount) {
                    node.getChild(index)?.let { pending.addLast(it to depth + 1) }
                }
            }
        }
        return texts
    }

    private fun forgetInstance() {
        refs.clear()
        snapshotDisplayId = -1
        if (_instance.value === this) _instance.value = null
    }

    private class Builder(private val id: String) {
        private val elements = ArrayList<PhoneUiElement>(PhoneUiRules.MAX_ELEMENTS)
        private val seen = HashSet<AccessibilityNodeInfo>()
        private val pending = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        private var usedChars = 0
        private var truncated = false

        fun walk(root: AccessibilityNodeInfo) {
            if (elements.size >= PhoneUiRules.MAX_ELEMENTS) {
                truncated = true
                return
            }
            pending.addLast(root to 0)
            while (pending.isNotEmpty() && elements.size < PhoneUiRules.MAX_ELEMENTS) {
                val (node, depth) = pending.removeFirst()
                if (!seen.add(node)) continue
                val info = describe(node, depth)
                if (info != null) {
                    val payload = PhoneUiRules.elementPayloadChars(info.text, info.description, info.viewId, info.className)
                    if (!PhoneUiRules.budgetHasRoom(usedChars, payload)) {
                        truncated = true
                        pending.clear()
                        return
                    }
                    elements.add(info)
                    usedChars += payload
                }
                if (depth < PhoneUiRules.MAX_TREE_DEPTH) {
                    for (index in 0 until node.childCount) {
                        val child = node.getChild(index) ?: continue
                        pending.addLast(child to depth + 1)
                    }
                }
            }
            if (pending.isNotEmpty()) truncated = true
            pending.clear()
        }

        /** Null when the node carries nothing a bot could act on; children still enqueue. */
        private fun describe(node: AccessibilityNodeInfo, depth: Int): PhoneUiElement? {
            if (depth > PhoneUiRules.MAX_TREE_DEPTH) return null
            // Determine whether this is a password field before asking the node
            // for text or content description; these getters may expose its value.
            val password = runCatching { node.isPassword }.getOrDefault(false)
            val text = if (password) null else runCatching { PhoneUiRules.clampText(node.text?.toString()) }.getOrNull()
            val description = if (password) null else runCatching { PhoneUiRules.clampText(node.contentDescription?.toString()) }.getOrNull()
            val clickable = runCatching { node.isClickable }.getOrDefault(false)
            val scrollable = runCatching { node.isScrollable }.getOrDefault(false)
            val editable = runCatching { node.isEditable }.getOrDefault(false)
            if (password) return null
            if (!clickable && !scrollable && !editable &&
                text.isNullOrEmpty() && description.isNullOrEmpty()
            ) return null
            val viewId = runCatching { node.viewIdResourceName?.takeIf { it.isNotEmpty() } }.getOrNull()
            val className = runCatching { node.className?.toString() }.getOrNull()
            val bounds = runCatching { Rect().also(node::getBoundsInScreen) }.getOrDefault(Rect())
            val ref = register(node) ?: return null
            return PhoneUiElement(
                ref = ref,
                viewId = viewId,
                className = className,
                text = text,
                description = description,
                bounds = listOf(bounds.left, bounds.top, bounds.right, bounds.bottom),
                clickable = clickable,
                editable = editable,
                scrollable = scrollable,
                password = password,
            )
        }

        private fun register(node: AccessibilityNodeInfo): String? {
            val service = instance.value ?: return null
            return service.refs.register(node)
        }

        fun build(displayId: Int): PhoneUiSnapshot = PhoneUiSnapshot(
            id = id,
            displayId = displayId,
            takenAtMs = System.currentTimeMillis(),
            truncated = truncated,
            elements = elements.toList(),
        )
    }
}
