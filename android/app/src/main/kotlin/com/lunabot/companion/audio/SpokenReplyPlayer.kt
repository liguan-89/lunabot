package com.lunabot.companion.audio

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.lunabot.companion.core.BotReplyCue
import com.lunabot.companion.core.BotReplySpeechEvent
import com.lunabot.companion.core.Frame
import com.lunabot.companion.core.PreparedSpeech
import com.lunabot.companion.core.Session
import com.lunabot.companion.core.holdsPotentialCredential
import com.lunabot.companion.core.redactSecretsForSpeech
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/** 自动朗读实际使用的顺序播放器；测试换成内存实现。 */
interface SpokenReplySpeech {
    suspend fun speak(clips: List<ByteArray>, shouldStart: () -> Boolean): Boolean
    fun stop()
}

private class StreamingTurn(
    val threadId: String,
    val botId: String,
    var voiceId: String?,
    var turnId: String?,
) {
    var buffer = ""
    var authoritative: String? = null
    var authoritativeCut = 0
    var ended = false
    var pumping = false
    var dirty = false
    var cancelled = false
    var holdForAuthority = false
    var probedBeforePrepare = false
    var probedBeforePlayback = false
    val spoken = mutableListOf<String>()
    val outstanding = mutableMapOf<Int, PendingUtterance>()
}

private class PendingUtterance(
    val turn: StreamingTurn,
    val index: Int,
    val text: String,
) {
    var cancelled = false
}

private sealed interface PumpWork {
    data class Streaming(val text: String, val voiceId: String?) : PumpWork
    data class Authoritative(val text: String, val previous: List<String>, val voiceId: String?) : PumpWork
}

/**
 * 手机本地自动朗读队列。
 *
 * 流式增量只用于尽早闭合分句；含半个凭证形状的 buffer 不送 TTS，等权威完成帧
 * 打码后再合成。回复按 utterance 入队顺序播放，同一时刻只读一条；通话或应用
 * 进后台时清空待读队列并停止当前声音，回到前台后只读之后新到达的回复。
 */
class SpokenReplyController(
    private val scope: CoroutineScope,
    private val events: Flow<BotReplySpeechEvent>,
    private val liveCalls: Flow<Frame.LiveCall>,
    private val probeLiveCallActive: suspend () -> Boolean,
    private val prepareSpeech: suspend (String, String?) -> PreparedSpeech,
    private val synthesizeSpeech: suspend (String, String?) -> ByteArray,
    private val speech: SpokenReplySpeech,
) {
    private val utterances = Channel<PendingUtterance>(Channel.UNLIMITED)
    private val lock = Any()
    private val turns = mutableMapOf<String, StreamingTurn>()
    private var started = false
    private var current: PendingUtterance? = null
    private val muteGates = mutableSetOf<MuteGate>()

    fun start() {
        synchronized(lock) {
            if (started) return
            started = true
        }
        scope.launch {
            events.collect(::onEvent)
        }
        scope.launch {
            liveCalls.collect { frame -> setLiveCallActive(frame.call?.let { it.status != "ended" } == true) }
        }
        scope.launch {
            for (utterance in utterances) playUtterance(utterance)
        }
    }

    /** 测试与兼容入口；生产事件由 [events] 提供。 */
    fun enqueue(cue: BotReplyCue) = onEvent(BotReplySpeechEvent.Complete(cue))

    /** 手机内打开的轮流说话 / Live 通话；与桌面传来的 Live 状态分开计数。 */
    fun setCallActive(active: Boolean) = setGate(MuteGate.UI_CALL, active)

    /** 输入框听写或语音消息录音占用麦克风时，自动朗读不能抢声音。 */
    fun setRecordingActive(active: Boolean) = setGate(MuteGate.RECORDING, active)

    /** 用户手动播放语音条时，语音条优先；它结束后只读之后新到的回复。 */
    fun setVoiceNoteActive(active: Boolean) = setGate(MuteGate.VOICE_NOTE, active)

    /** 音色预览也是一次手动试听；自动回复不能把它顶掉。 */
    fun setVoicePreviewActive(active: Boolean) = setGate(MuteGate.VOICE_PREVIEW, active)

    fun onAppBackgrounded() = setGate(MuteGate.BACKGROUND, true)

    fun onAppForegrounded() = setGate(MuteGate.BACKGROUND, false)

    private fun setLiveCallActive(active: Boolean) = setGate(MuteGate.LIVE_CALL, active)

    private fun setGate(gate: MuteGate, active: Boolean) {
        val silence = synchronized(lock) {
            val wasMuted = muteGates.isNotEmpty()
            if (active) muteGates += gate else muteGates -= gate
            !wasMuted && muteGates.isNotEmpty()
        }
        if (silence) silence()
    }

    private fun muted(): Boolean = synchronized(lock) { muteGates.isNotEmpty() }

    private enum class MuteGate { UI_CALL, LIVE_CALL, RECORDING, VOICE_NOTE, VOICE_PREVIEW, BACKGROUND }

    private fun onEvent(event: BotReplySpeechEvent) {
        when (event) {
            is BotReplySpeechEvent.TurnStarted -> {
                val existing = synchronized(lock) { turns[event.threadId] }
                if (existing != null) cancelTurn(existing)
            }
            is BotReplySpeechEvent.Delta -> {
                if (muted()) return
                val turn = synchronized(lock) {
                    val existing = turns[event.threadId]
                    val reusable = existing?.takeIf { sameTurn(it.turnId, event.turnId) && !it.cancelled }
                    if (existing != null && reusable == null) cancelTurnLocked(existing)
                    val next = reusable ?: StreamingTurn(event.threadId, event.botId, event.voiceId, event.turnId).also {
                        turns[event.threadId] = it
                    }
                    next.voiceId = event.voiceId
                    if (next.turnId == null) next.turnId = event.turnId
                    next.buffer += event.delta
                    next.dirty = true
                    if (holdsPotentialCredential(next.buffer)) next.holdForAuthority = true
                    next
                }
                pump(turn)
            }
            is BotReplySpeechEvent.Complete -> {
                if (muted()) return
                val cue = event.cue
                val turn = synchronized(lock) {
                    val existing = turns[cue.threadId]
                    val reusable = existing?.takeIf { sameTurn(it.turnId, cue.turnId) && !it.cancelled && !it.ended }
                    if (existing != null && reusable == null) {
                        if (existing.ended) {
                            if (turns[cue.threadId] === existing) turns.remove(cue.threadId)
                        } else {
                            cancelTurnLocked(existing)
                        }
                    }
                    val next = reusable ?: StreamingTurn(cue.threadId, cue.botId, cue.voiceId, cue.turnId).also {
                        turns[cue.threadId] = it
                    }
                    next.voiceId = cue.voiceId
                    if (cue.turnId != null) next.turnId = cue.turnId
                    next.authoritative = cue.text
                    next.authoritativeCut = next.buffer.length
                    next.ended = true
                    next.pumpingOrDirty()
                    next
                }
                pump(turn)
            }
            is BotReplySpeechEvent.TurnFinished -> {
                val turn = synchronized(lock) {
                    turns[event.threadId]?.takeIf { sameTurn(it.turnId, event.turnId) }
                } ?: return
                if (!event.ok) {
                    cancelTurn(turn)
                } else {
                    synchronized(lock) {
                        turn.ended = true
                        turn.pumpingOrDirty()
                    }
                    pump(turn)
                }
            }
        }
    }

    private fun StreamingTurn.pumpingOrDirty() {
        if (pumping) dirty = true
    }

    private fun sameTurn(a: String?, b: String?): Boolean = a == null || b == null || a == b

    private fun pump(turn: StreamingTurn) {
        synchronized(lock) {
            if (turn.cancelled) return
            if (turn.pumping) {
                turn.dirty = true
                return
            }
            turn.pumping = true
        }
        scope.launch {
            try {
                while (true) {
                    val work = synchronized(lock) {
                        when {
                            turn.cancelled -> {
                                turn.pumping = false
                                null
                            }
                            turn.authoritative != null -> {
                                val text = turn.authoritative!!
                                turn.authoritative = null
                                val previous = turn.spoken.toList()
                                turn.spoken.clear()
                                val cut = turn.authoritativeCut.coerceIn(0, turn.buffer.length)
                                turn.buffer = turn.buffer.substring(cut)
                                turn.authoritativeCut = 0
                                turn.holdForAuthority = false
                                if (turn.buffer.isNotEmpty()) turn.dirty = true
                                PumpWork.Authoritative(text, previous, turn.voiceId)
                            }
                            turn.dirty && !turn.ended -> {
                                turn.dirty = false
                                if (turn.holdForAuthority || holdsPotentialCredential(turn.buffer)) {
                                    turn.holdForAuthority = true
                                    turn.pumping = false
                                    null
                                } else {
                                    PumpWork.Streaming(turn.buffer, turn.voiceId)
                                }
                            }
                            else -> {
                                turn.pumping = false
                                null
                            }
                        }
                    } ?: break

                    val shouldProbePrepare = synchronized(lock) {
                        if (turn.probedBeforePrepare) false else {
                            turn.probedBeforePrepare = true
                            true
                        }
                    }
                    if (shouldProbePrepare && liveCallActiveSafely()) {
                        cancelTurn(turn)
                        break
                    }

                    when (work) {
                        is PumpWork.Streaming -> {
                            val prepared = prepareSpeech(redactSecretsForSpeech(work.text), work.voiceId)
                            if (!prepared.ready) {
                                cancelTurn(turn)
                                break
                            }
                            acceptBlocks(turn, prepared.utterances.dropLast(1), previous = null, trackSpoken = true)
                        }
                        is PumpWork.Authoritative -> {
                            val prepared = prepareSpeech(redactSecretsForSpeech(work.text), work.voiceId)
                            if (!prepared.ready) {
                                cancelTurn(turn)
                                break
                            }
                            acceptBlocks(turn, prepared.utterances, work.previous, trackSpoken = false)
                        }
                    }
                }
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (_: Throwable) {
                // 自动朗读是增强体验：一次失败不能卡住后续回复，也不应打断聊天。
                cancelTurn(turn)
            }
        }
    }

    private fun acceptBlocks(turn: StreamingTurn, blocks: List<String>, previous: List<String>?, trackSpoken: Boolean) {
        synchronized(lock) {
            if (turn.cancelled || muted()) return
            val before = previous ?: turn.spoken
            val common = commonPrefixSize(before, blocks)
            invalidateFromLocked(turn, common)
            for (index in common until blocks.size) {
                val text = blocks[index]
                if (text.isNotBlank()) {
                    val utterance = PendingUtterance(turn, index, text)
                    turn.outstanding[index] = utterance
                    utterances.trySend(utterance)
                }
            }
            if (trackSpoken) {
                turn.spoken.clear()
                turn.spoken.addAll(blocks)
            }
        }
    }

    private fun commonPrefixSize(a: List<String>, b: List<String>): Int {
        var at = 0
        while (at < a.size && at < b.size && a[at] == b[at]) at++
        return at
    }

    private fun invalidateFromLocked(turn: StreamingTurn, index: Int) {
        val iterator = turn.outstanding.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.key >= index) {
                entry.value.cancelled = true
                iterator.remove()
            }
        }
        current?.let {
            if (it.turn === turn && it.index >= index) {
                it.cancelled = true
                speech.stop()
            }
        }
    }

    private fun cancelTurnLocked(turn: StreamingTurn) {
        if (turn.cancelled) return
        turn.cancelled = true
        for ((_, utterance) in turn.outstanding) utterance.cancelled = true
        turn.outstanding.clear()
        if (current?.turn === turn) current?.cancelled = true
        if (turns[turn.threadId] === turn) turns.remove(turn.threadId)
    }

    private fun cancelTurn(turn: StreamingTurn) {
        val stop = synchronized(lock) {
            if (turn.cancelled) false else {
                cancelTurnLocked(turn)
                current?.turn === turn
            }
        }
        if (stop) speech.stop()
    }

    private fun valid(utterance: PendingUtterance): Boolean = synchronized(lock) {
        !utterance.cancelled &&
            !utterance.turn.cancelled &&
            utterance.turn.outstanding[utterance.index] === utterance
    }

    private suspend fun liveCallActiveSafely(): Boolean = try {
        probeLiveCallActive()
    } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
    } catch (_: Throwable) {
        false
    }

    private suspend fun playUtterance(utterance: PendingUtterance) {
        try {
            if (!valid(utterance) || muted()) return
            val shouldProbe = synchronized(lock) {
                if (utterance.turn.probedBeforePlayback) false else {
                    utterance.turn.probedBeforePlayback = true
                    true
                }
            }
            if (shouldProbe && liveCallActiveSafely()) {
                cancelTurn(utterance.turn)
                return
            }
            synchronized(lock) {
                if (!valid(utterance)) return
                current = utterance
            }
            val audio = try {
                synthesizeSpeech(utterance.text, utterance.turn.voiceId)
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (_: Throwable) {
                return
            }
            if (!valid(utterance) || muted()) return
            speech.speak(listOf(audio)) { valid(utterance) && !muted() }
        } finally {
            synchronized(lock) {
                if (current === utterance) current = null
                if (utterance.turn.outstanding[utterance.index] === utterance) {
                    utterance.turn.outstanding.remove(utterance.index)
                }
            }
        }
    }

    private fun silence() {
        synchronized(lock) {
            for ((_, turn) in turns) cancelTurnLocked(turn)
            turns.clear()
            while (utterances.tryReceive().getOrNull() != null) {
            }
        }
        speech.stop()
    }
}

/** 应用级自动朗读播放器：进程前台才出声，通话和语音条共用系统音频焦点。 */
class SpokenReplyPlayer(
    context: Context,
    session: Session,
    scope: CoroutineScope,
    processLifecycle: Lifecycle = ProcessLifecycleOwner.get().lifecycle,
) : DefaultLifecycleObserver {
    private val speaker = CallSpeaker(context)
    private val controller = SpokenReplyController(
        scope = scope,
        events = session.botReplySpeechEvents,
        liveCalls = session.liveCall,
        probeLiveCallActive = session::liveCallActive,
        prepareSpeech = session::prepareSpeech,
        synthesizeSpeech = session::speak,
        speech = object : SpokenReplySpeech {
            override suspend fun speak(clips: List<ByteArray>, shouldStart: () -> Boolean): Boolean =
                speaker.speak(clips, shouldStart)
            override fun stop() = speaker.stop()
        },
    )

    init {
        processLifecycle.addObserver(this)
        if (!processLifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            controller.onAppBackgrounded()
        }
    }

    fun start() = controller.start()

    fun setCallActive(active: Boolean) = controller.setCallActive(active)

    fun setRecordingActive(active: Boolean) = controller.setRecordingActive(active)

    fun setVoiceNoteActive(active: Boolean) = controller.setVoiceNoteActive(active)

    fun setVoicePreviewActive(active: Boolean) = controller.setVoicePreviewActive(active)

    override fun onStart(owner: LifecycleOwner) = controller.onAppForegrounded()

    override fun onStop(owner: LifecycleOwner) = controller.onAppBackgrounded()
}
