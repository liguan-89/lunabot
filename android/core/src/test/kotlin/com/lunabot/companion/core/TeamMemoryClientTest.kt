package com.lunabot.companion.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** 团队记忆路由：CRUD 都按 section query 作用在一个团队分区上。 */
class TeamMemoryClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: CompanionClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        client = CompanionClient(connection, "paired-token")
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun getCarriesTheSectionAndDecodesEntries() = runBlocking {
        server.enqueue(json("""{"section":"Editing","label":"Editing","loadedIds":["m1"],"entries":[
            {"id":"m1","kind":"decision","name":"Colour","detail":"Blue","aliases":["color"],"status":"accepted",
             "source":{"botId":"b1","botName":"Clive","threadId":"t1","at":1764000000000,"quote":"use blue"},
             "updatedAt":1764000000001,"revision":"rev1","pinned":true,"key":"project/colour"}
        ]}""".trimIndent().replace("\n", "")))

        val view = client.teamMemory("Editing")

        assertEquals("/api/team-memory?section=Editing", server.takeRequest().path)
        assertEquals("Editing", view.section)
        assertEquals(listOf("m1"), view.loadedIds)
        val entry = view.entries.single()
        assertEquals("decision", entry.kind)
        assertEquals("Colour", entry.name)
        assertEquals("Blue", entry.detail)
        assertEquals(listOf("color"), entry.aliases)
        assertEquals("rev1", entry.revision)
        assertEquals(true, entry.pinned)
        assertEquals("use blue", entry.source.quote)
    }

    @Test
    fun postPatchAndDeleteSendTheRevisionContract() = runBlocking {
        server.enqueue(json("""{"entries":[],"loadedIds":[]}""", code = 201))
        client.addTeamMemory("", "term", "Luna", "机器人的名字")
        val post = server.takeRequest()
        assertEquals("POST", post.method)
        assertEquals("/api/team-memory?section=", post.path)
        val postBody = post.body.readUtf8()
        assertTrue(postBody.contains("\"kind\":\"term\""))
        assertTrue(postBody.contains("\"name\":\"Luna\""))

        server.enqueue(json("""{"entries":[],"loadedIds":[]}"""))
        client.patchTeamMemory("", "m 1", "rev1", name = "Luna Bot", detail = "名字", pinned = true)
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertEquals("/api/team-memory/m%201?section=", patch.path)
        val patchBody = patch.body.readUtf8()
        assertTrue(patchBody.contains("\"expectedRevision\":\"rev1\""))
        assertTrue(patchBody.contains("\"pinned\":true"))

        server.enqueue(json("""{"entries":[],"loadedIds":[]}"""))
        client.deleteTeamMemory("", "m 1", "rev2")
        val delete = server.takeRequest()
        assertEquals("DELETE", delete.method)
        assertEquals("/api/team-memory/m%201?section=&revision=rev2", delete.path)
    }

    private fun json(body: String, code: Int = 200) = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
