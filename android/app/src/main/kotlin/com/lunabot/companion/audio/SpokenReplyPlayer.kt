package com.lunabot.companion.audio

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.lunabot.companion.core.BotReplyCue
import com.lunabot.companion.core.redactSecretsForSpeech
import com.lunabot.companion.core.Frame
import com.lunabot.companion.core.PreparedSpeech
import com.lunabot.companion.core.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/** 自动朗读实际使用的顺序播放器；测试换成内存实现。 */
interface SpokenReplySpeech {
    suspend fun speak(clips: List<ByteArray>, shouldStart: () -> Boolean): Boolean
    fun stop()
}

/**
 * 手机本地自动朗读队列。
 *
 * 只消费 [Session.botReplyCues] 里实时到达的完成回复：不在启动、hydrate 或
 * 翻历史时突然补读旧消息。回复按到达顺序排队，同一时刻只读一条；通话或应用
 * 进后台时清空待读队列并停止当前声音，回到前台后只读之后新到达的回复。
 */
class SpokenReplyController(
    private val scope: CoroutineScope,
    private val cues: Flow<BotReplyCue>,
    private val liveCalls: Flow<Frame.LiveCall>,
    private val probeLiveCallActive: suspend () -> Boolean,
    private val prepareSpeech: suspend (String, String?) -> PreparedSpeech,
    private val synthesizeSpeech: suspend (String, String?) -> ByteArray,
    private val speech: SpokenReplySpeech,
) {
    private val queue = Channel<BotReplyCue>(Channel.UNLIMITED)
    private val lock = Any()
    private var started = false
    private val muteGates = mutableSetOf<MuteGate>()

    fun start() {
        synchronized(lock) {
            if (started) return
            started = true
        }
        scope.launch {
            cues.collect(::enqueue)
        }
        scope.launch {
            liveCalls.collect { frame -> setLiveCallActive(frame.call?.let { it.status != "ended" } == true) }
        }
        scope.launch {
            for (cue in queue) playOne(cue)
        }
    }

    fun enqueue(cue: BotReplyCue) {
        if (!muted()) queue.trySend(cue)
    }

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

    private fun silence() {
        while (queue.tryReceive().getOrNull() != null) {
        }
        speech.stop()
    }

    private suspend fun liveCallActiveSafely(): Boolean = try {
        probeLiveCallActive()
    } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
    } catch (_: Throwable) {
        false
    }

    private suspend fun playOne(cue: BotReplyCue) {
        if (muted()) return
        try {
            if (liveCallActiveSafely()) return
            val prepared = prepareSpeech(redactSecretsForSpeech(cue.text), cue.voiceId)
            if (!prepared.ready) return
            val clips = ArrayList<ByteArray>(prepared.utterances.size)
            for (utterance in prepared.utterances) {
                if (muted()) return
                clips += synthesizeSpeech(utterance, cue.voiceId)
            }
            if (!muted() && clips.isNotEmpty()) {
                if (liveCallActiveSafely()) return
                speech.speak(clips) { !muted() }
            }
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (_: Throwable) {
            // 自动朗读是增强体验：一次合成失败不能卡住后续回复，也不应打断聊天。
        }
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
        cues = session.botReplyCues,
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
