package com.lunabot.companion.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.coroutines.test.runTest

/** 通话扬声器的启动门闩：被打断后，尚未开始的播放不能重新出声音。 */
class CallSpeakerTest {
    @Test
    fun aRefusedStartCreatesNoEngineAndReturnsFalse() = runTest {
        var engines = 0
        val speaker = CallSpeaker(
            engineFactory = {
                engines += 1
                object : PreviewAudioEngine {
                    override var onCompletion: (() -> Unit)? = null
                    override var onError: (() -> Unit)? = null
                    override fun start(data: ByteArray): Boolean = true
                    override fun stop() = Unit
                    override fun release() = Unit
                }
            },
            focus = object : PreviewAudioFocus {
                override fun request(onInterrupted: () -> Unit): Boolean = true
                override fun abandon() = Unit
            },
        )

        assertFalse(speaker.speak(listOf(byteArrayOf(1)), shouldStart = { false }))
        assertEquals(0, engines)
    }
}
