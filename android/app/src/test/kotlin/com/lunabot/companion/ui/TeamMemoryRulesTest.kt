package com.lunabot.companion.ui

import com.lunabot.companion.core.TeamMemoryEntry
import com.lunabot.companion.core.TeamMemorySource
import kotlin.test.Test
import kotlin.test.assertEquals

class TeamMemoryRulesTest {
    @Test
    fun `known kinds have Chinese labels and future kinds stay visible`() {
        assertEquals("人物", TeamMemoryRules.kindLabel("person"))
        assertEquals("地点", TeamMemoryRules.kindLabel("place"))
        assertEquals("决定", TeamMemoryRules.kindLabel("decision"))
        assertEquals("术语", TeamMemoryRules.kindLabel("term"))
        assertEquals("project", TeamMemoryRules.kindLabel("project"))
    }

    @Test
    fun `future kinds stay in the rendered order after the known four`() {
        val entries = listOf(
            TeamMemoryEntry(id = "m1", kind = "project", name = "Luna", detail = "", status = "accepted"),
            TeamMemoryEntry(id = "m2", kind = "person", name = "Ada", detail = "", status = "accepted"),
        )
        assertEquals(listOf("person", "place", "decision", "term", "project"), TeamMemoryRules.kindsInUse(entries))
    }

    @Test
    fun `meta names the source and whether the fact is in prompts`() {
        val entry = TeamMemoryEntry(
            id = "m1",
            kind = "term",
            name = "Luna",
            detail = "机器人的名字",
            status = "accepted",
            source = TeamMemorySource(botName = "Clive"),
        )
        assertEquals("Clive · 已加载", TeamMemoryRules.meta(entry, loaded = true))
        assertEquals("Clive · 可搜索", TeamMemoryRules.meta(entry, loaded = false))
    }

    @Test
    fun `a blank or sentinel source is the person`() {
        val blank = TeamMemoryEntry(id = "m1", kind = "term", name = "Luna", detail = "机器人的名字", status = "accepted")
        val manual = blank.copy(source = TeamMemorySource(botName = "you"))
        assertEquals("你 · 已加载", TeamMemoryRules.meta(blank, loaded = true))
        assertEquals("你", TeamMemoryRules.sourceName(manual))
    }
}
