package com.lunabot.companion.audio

import com.lunabot.companion.core.BotReplyCue
import com.lunabot.companion.core.Frame
import com.lunabot.companion.core.LiveCallState
import com.lunabot.companion.core.PreparedSpeech
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runTest

/** 自动朗读控制器：完成回复按序合成播放，通话和后台都让它安静。 */
class SpokenReplyControllerTest {
    private fun cue(id: String, text: String = "回复$id") = BotReplyCue(
        threadId = "thread-1",
        messageId = id,
        botId = "bot-1",
        voiceId = "voice-7",
        text = text,
    )

    @Test
    fun aCompletedReplyIsPreparedSynthesizedAndPlayedInOrder() = runTest {
        val cues = MutableSharedFlow<BotReplyCue>()
        val liveCalls = MutableSharedFlow<Frame.LiveCall>()
        val speech = FakeSpeech()
        val prepared = mutableListOf<Pair<String, String?>>()
        val synthesized = mutableListOf<Pair<String, String?>>()
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = cues,
            liveCalls = liveCalls,
            probeLiveCallActive = { false },
            prepareSpeech = { text, voice ->
                prepared += text to voice
                PreparedSpeech(ready = true, utterances = listOf("one", "two"))
            },
            synthesizeSpeech = { text, voice ->
                synthesized += text to voice
                text.encodeToByteArray()
            },
            speech = speech,
        )
        controller.start()

        controller.enqueue(cue("m1", "完整回复"))
        testScheduler.runCurrent()

        assertEquals(listOf<Pair<String, String?>>("完整回复" to "voice-7"), prepared)
        assertEquals(listOf<Pair<String, String?>>("one" to "voice-7", "two" to "voice-7"), synthesized)
        assertEquals(listOf("one", "two"), speech.playedUtf8())
    }

    @Test
    fun credentialShapesAreRedactedBeforeTheyReachSpeechSynthesis() = runTest {
        val speech = FakeSpeech()
        val prepared = mutableListOf<String>()
        val synthesized = mutableListOf<String>()
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = MutableSharedFlow(),
            liveCalls = MutableSharedFlow(),
            probeLiveCallActive = { false },
            prepareSpeech = { text, _ ->
                prepared += text
                PreparedSpeech(ready = true, utterances = listOf(text))
            },
            synthesizeSpeech = { text, _ ->
                synthesized += text
                byteArrayOf(1)
            },
            speech = speech,
        )
        controller.start()

        controller.enqueue(cue("m1", "api_key=abcd1234efgh"))
        testScheduler.runCurrent()

        assertEquals(listOf("api_key=«redacted 12 chars»"), prepared)
        assertEquals(listOf("api_key=«redacted 12 chars»"), synthesized)
    }

    @Test
    fun repliesWaitInOrderRatherThanTalkingOverEachOther() = runTest {
        val cues = MutableSharedFlow<BotReplyCue>()
        val speech = FakeSpeech()
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = cues,
            liveCalls = MutableSharedFlow(),
            probeLiveCallActive = { false },
            prepareSpeech = { _, _ -> PreparedSpeech(ready = true, utterances = listOf("u")) },
            synthesizeSpeech = { text, _ -> text.encodeToByteArray() },
            speech = speech,
        )
        controller.start()

        controller.enqueue(cue("m1"))
        controller.enqueue(cue("m2"))
        testScheduler.runCurrent()

        assertEquals(listOf("u", "u"), speech.playedUtf8())
        assertEquals(2, speech.speakCalls)
    }

    @Test
    fun anActiveCallSuppressesNewRepliesAndStopsTheCurrentVoice() = runTest {
        val cues = MutableSharedFlow<BotReplyCue>()
        val speech = FakeSpeech()
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = cues,
            liveCalls = MutableSharedFlow(),
            probeLiveCallActive = { false },
            prepareSpeech = { _, _ -> PreparedSpeech(ready = true, utterances = listOf("u")) },
            synthesizeSpeech = { text, _ -> text.encodeToByteArray() },
            speech = speech,
        )
        controller.start()

        controller.setCallActive(true)
        controller.enqueue(cue("m1"))
        testScheduler.runCurrent()
        assertEquals(0, speech.speakCalls)

        controller.setCallActive(false)
        controller.enqueue(cue("m2"))
        testScheduler.runCurrent()
        assertEquals(1, speech.speakCalls)
    }

    @Test
    fun backgroundSuppressesRepliesUntilTheAppReturns() = runTest {
        val cues = MutableSharedFlow<BotReplyCue>()
        val speech = FakeSpeech()
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = cues,
            liveCalls = MutableSharedFlow(),
            probeLiveCallActive = { false },
            prepareSpeech = { _, _ -> PreparedSpeech(ready = true, utterances = listOf("u")) },
            synthesizeSpeech = { text, _ -> text.encodeToByteArray() },
            speech = speech,
        )
        controller.start()

        controller.onAppBackgrounded()
        controller.enqueue(cue("m1"))
        testScheduler.runCurrent()
        assertEquals(0, speech.speakCalls)

        controller.onAppForegrounded()
        controller.enqueue(cue("m2"))
        testScheduler.runCurrent()
        assertEquals(1, speech.speakCalls)
    }

    @Test
    fun recordingAndVoiceNotePlaybackAreIndependentMuteGates() = runTest {
        val speech = FakeSpeech()
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = MutableSharedFlow(),
            liveCalls = MutableSharedFlow(),
            probeLiveCallActive = { false },
            prepareSpeech = { _, _ -> PreparedSpeech(ready = true, utterances = listOf("u")) },
            synthesizeSpeech = { text, _ -> text.encodeToByteArray() },
            speech = speech,
        )
        controller.start()

        controller.setRecordingActive(true)
        controller.enqueue(cue("m1"))
        testScheduler.runCurrent()
        assertEquals(0, speech.speakCalls)

        controller.setRecordingActive(false)
        controller.setVoiceNoteActive(true)
        controller.enqueue(cue("m2"))
        testScheduler.runCurrent()
        assertEquals(0, speech.speakCalls)

        controller.setVoiceNoteActive(false)
        controller.setVoicePreviewActive(true)
        controller.enqueue(cue("m3"))
        testScheduler.runCurrent()
        assertEquals(0, speech.speakCalls)

        controller.setVoicePreviewActive(false)
        controller.enqueue(cue("m4"))
        testScheduler.runCurrent()
        assertEquals(1, speech.speakCalls)
    }

    @Test
    fun aLiveCallMutesOnlyUntilItsEndedFrame() = runTest {
        val liveCalls = MutableSharedFlow<Frame.LiveCall>(extraBufferCapacity = 2)
        val speech = FakeSpeech()
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = MutableSharedFlow(),
            liveCalls = liveCalls,
            probeLiveCallActive = { false },
            prepareSpeech = { _, _ -> PreparedSpeech(ready = true, utterances = listOf("u")) },
            synthesizeSpeech = { text, _ -> text.encodeToByteArray() },
            speech = speech,
        )
        controller.start()
        testScheduler.runCurrent()
        assertEquals(1, liveCalls.subscriptionCount.value)

        fun frame(status: String) = Frame.LiveCall(
            botId = "bot-1",
            threadId = "thread-1",
            call = LiveCallState(callId = "call-1", botId = "bot-1", threadId = "thread-1", status = status),
        )
        liveCalls.tryEmit(frame("live"))
        testScheduler.runCurrent()
        controller.enqueue(cue("m1"))
        testScheduler.runCurrent()
        assertEquals(0, speech.speakCalls)

        liveCalls.tryEmit(frame("ended"))
        testScheduler.runCurrent()
        controller.enqueue(cue("m2"))
        testScheduler.runCurrent()
        assertEquals(1, speech.speakCalls)
    }

    @Test
    fun aFailedReplyDoesNotBlockTheNextOne() = runTest {
        val speech = FakeSpeech()
        var prepareCalls = 0
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = MutableSharedFlow(),
            liveCalls = MutableSharedFlow(),
            probeLiveCallActive = { false },
            prepareSpeech = { _, _ ->
                prepareCalls += 1
                if (prepareCalls == 1) error("tts unavailable")
                PreparedSpeech(ready = true, utterances = listOf("u"))
            },
            synthesizeSpeech = { text, _ -> text.encodeToByteArray() },
            speech = speech,
        )
        controller.start()

        controller.enqueue(cue("m1"))
        controller.enqueue(cue("m2"))
        testScheduler.runCurrent()

        assertEquals(2, prepareCalls)
        assertEquals(1, speech.speakCalls)
    }

    @Test
    fun theComputersCurrentLiveCallSuppressesPlaybackEvenWithoutAStreamFrame() = runTest {
        val speech = FakeSpeech()
        var prepareCalls = 0
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = MutableSharedFlow(),
            liveCalls = MutableSharedFlow(),
            probeLiveCallActive = { true },
            prepareSpeech = { _, _ ->
                prepareCalls += 1
                PreparedSpeech(ready = true, utterances = listOf("u"))
            },
            synthesizeSpeech = { text, _ -> text.encodeToByteArray() },
            speech = speech,
        )
        controller.start()

        controller.enqueue(cue("m1"))
        testScheduler.runCurrent()

        assertEquals(0, prepareCalls)
        assertEquals(0, speech.speakCalls)
    }

    @Test
    fun aLiveCallStartingDuringSynthesisStillSuppressesPlayback() = runTest {
        val speech = FakeSpeech()
        val probes = ArrayDeque(listOf(false, true))
        val controller = SpokenReplyController(
            scope = backgroundScope,
            cues = MutableSharedFlow(),
            liveCalls = MutableSharedFlow(),
            probeLiveCallActive = { probes.removeFirst() },
            prepareSpeech = { _, _ -> PreparedSpeech(ready = true, utterances = listOf("u")) },
            synthesizeSpeech = { text, _ -> text.encodeToByteArray() },
            speech = speech,
        )
        controller.start()

        controller.enqueue(cue("m1"))
        testScheduler.runCurrent()

        assertEquals(0, speech.speakCalls)
    }

    private class FakeSpeech : SpokenReplySpeech {
        val played = mutableListOf<ByteArray>()
        var speakCalls = 0
        var stopCalls = 0
        override suspend fun speak(clips: List<ByteArray>, shouldStart: () -> Boolean): Boolean {
            if (!shouldStart()) return false
            speakCalls += 1
            played += clips
            return true
        }
        override fun stop() {
            stopCalls += 1
        }
        fun playedUtf8(): List<String> = played.map { it.decodeToString() }
    }
}
