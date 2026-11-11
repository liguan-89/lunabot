package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The decode half of the voice-note bubble contract: a bot text message's
 * attachments come out as players ([Message.voiceNotes]) and document cards
 * ([Message.fileAttachments]), whichever wire shape carried them.
 */
class VoiceNotesTest {

    private fun reply(attachmentsJson: String): Message = CompanionJson.decodeFromString(
        """{"id":"reply","role":"bot","kind":"text","at":1,"text":"Held note","attachments":[$attachmentsJson]}""",
    )

    @Test
    fun parkedAudioAttachmentCarriesItsDurationEstimate() {
        val note = reply(
            """{"kind":"audio","path":"/attachments/123e4567-e89b-12d3-a456-426614174000.mp3","mime":"audio/mpeg","durationMs":4200}""",
        ).voiceNotes.single()

        assertEquals(DisplayedMessageAttachment.Kind.AUDIO, note.kind)
        assertEquals("/attachments/123e4567-e89b-12d3-a456-426614174000.mp3", note.path)
        assertEquals("Voice note", note.name)
        assertEquals(4200.0, note.durationMs)
    }

    @Test
    fun attachFileHandoverRendersAsAVoiceNoteKeepingItsName() {
        val message = reply(
            """{"kind":"file","path":"/attachments/keep.m4a","mime":"audio/mp4","name":"语音 09-41.m4a"}""",
        )

        val note = message.voiceNotes.single()
        assertEquals(DisplayedMessageAttachment.Kind.AUDIO, note.kind)
        assertEquals("/attachments/keep.m4a", note.path)
        assertEquals("语音 09-41.m4a", note.name)
        // The handover wire carries no duration estimate.
        assertNull(note.durationMs)
        assertTrue(message.fileAttachments.isEmpty())
    }

    @Test
    fun audioRendersByMimeOrExtensionWhileEverythingElseStaysOut() {
        val message = reply(
            """
            {"kind":"audio","path":"/attachments/note.wav"},
            {"kind":"audio","path":"/attachments/stream","mime":"audio/webm"},
            {"kind":"audio","path":"/attachments/clip.mp4"},
            {"kind":"audio","path":"/attachments/123e4567-e89b-12d3-a456-426614174000.mp3","mime":"audio/mpeg"},
            {"kind":"audio","path":"/attachments/123e4567-e89b-12d3-a456-426614174000.mp3"},
            {"kind":"audio","path":" "},
            {"kind":"video","path":"/attachments/clip.mp4"},
            {"kind":"image","path":"/tmp/screen.png","mime":"image/png"}
            """.trimIndent(),
        )

        assertEquals(
            listOf(
                "/attachments/note.wav",
                "/attachments/stream",
                "/attachments/123e4567-e89b-12d3-a456-426614174000.mp3",
            ),
            message.voiceNotes.map(DisplayedMessageAttachment::path),
        )
        assertNull(message.voiceNotes.last().durationMs)
        assertTrue(message.fileAttachments.isEmpty())
    }

    @Test
    fun nonAudioFileHandoverBecomesADocumentCardNotAPlayer() {
        val message = reply(
            """{"kind":"file","path":"/tmp/notes.pdf","mime":"application/pdf","name":"Meeting notes.pdf"}""",
        )

        assertTrue(message.voiceNotes.isEmpty())
        val card = message.fileAttachments.single()
        assertEquals(DisplayedMessageAttachment.Kind.FILE, card.kind)
        assertEquals("Meeting notes.pdf", card.name)
        assertEquals("/tmp/notes.pdf", card.path)
        assertNull(card.durationMs)
    }

    @Test
    fun unnamedFileHandoverFallsBackToItsBasename() {
        val card = reply(
            """{"kind":"file","path":"/tmp/report.pdf","mime":"application/pdf"}""",
        ).fileAttachments.single()

        assertEquals("report.pdf", card.name)
    }

    @Test
    fun aPathRendersOnceEvenWhenBothWireShapesCarryIt() {
        val message = reply(
            """
            {"kind":"audio","path":"/attachments/ditto","mime":"audio/webm"},
            {"kind":"file","path":"/attachments/ditto","mime":"text/plain","name":"ditto.txt"}
            """.trimIndent(),
        )

        assertEquals(listOf("/attachments/ditto"), message.voiceNotes.map(DisplayedMessageAttachment::path))
        assertTrue(message.fileAttachments.isEmpty())
    }

    @Test
    fun unknownAttachmentKindsStayOutOfBothLists() {
        val message = reply("""{"kind":"sticker","path":"/tmp/pack.png","name":"pack.png"}""")

        assertTrue(message.voiceNotes.isEmpty())
        assertTrue(message.fileAttachments.isEmpty())
    }

    @Test
    fun legacyRepliesDecodeWithoutAudioFields() {
        val message = CompanionJson.decodeFromString<Message>(
            """{"id":"old","role":"bot","kind":"text","at":1,"text":"Still visible","attachments":[{"kind":"image","path":"/tmp/s.png"}]}""",
        )

        assertTrue(message.voiceNotes.isEmpty())
        assertTrue(message.fileAttachments.isEmpty())
        assertNull(message.attachments?.single()?.durationMs)
        assertEquals(1, message.generatedImages.size)
    }
}
