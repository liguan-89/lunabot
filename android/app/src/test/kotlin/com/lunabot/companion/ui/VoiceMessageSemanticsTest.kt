package com.lunabot.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** 语音消息的产品语义：音频永远保留，识别出的文字只是随附转写。 */
class VoiceMessageSemanticsTest {
    private val clip = VoiceClip(data = byteArrayOf(1, 2, 3), name = "语音 10-00.wav", durationMs = 1200)

    @Test
    fun recognizedSpeechKeepsTheAudioAndCarriesTheTranscript() {
        val result = VoiceCaptureResult(clip = clip, transcript = "你好", transcriptionUnavailable = false)
        val (text, attachments) = voiceMessagePayload(result)
        assertEquals("你好", text)
        assertEquals(1, attachments.size)
        assertEquals("audio/wav", attachments.single().mime)
        assertEquals(clip.name, attachments.single().name)
        assertEquals(clip.data.toList(), attachments.single().data.toList())
        assertNull(voiceTranscriptWarning(result))
    }

    @Test
    fun unrecognizedSpeechStillSendsTheVoiceMessage() {
        val result = VoiceCaptureResult(clip = clip, transcript = "", transcriptionUnavailable = false)
        val (text, attachments) = voiceMessagePayload(result)
        assertEquals("", text)
        assertEquals(1, attachments.size)
        assertNull(voiceTranscriptWarning(result))
    }

    @Test
    fun aFailedTranscriptionIsExplainedAfterTheAudioSends() {
        val result = VoiceCaptureResult(clip = clip, transcript = "", transcriptionUnavailable = true)
        assertEquals("语音转文字暂不可用，已按语音消息发送。", voiceTranscriptWarning(result))
    }
}
