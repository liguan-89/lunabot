package com.lunabot.companion.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 与 `shared/widget.test.ts` 同源的按键/表单语义，保证手机端和桌面端对同一棵
 * canonical 树算出同一套可点动作与提交载荷。
 */
class WidgetTreeTest {

    private fun tree(json: String) = WidgetNode(Json.parseToJsonElement(json).jsonObject)

    private fun refs(actions: List<WidgetActionEntry>) = actions.map { it.ref }

    @Test
    fun `actions collect buttons, list items and the root confirm and cancel`() {
        val root = tree("""
            {"type":"Card","id":"n1","children":[
              {"type":"Button","id":"n2","label":"Save","onClickAction":{"type":"save"}},
              {"type":"Button","id":"n3","label":"Skip","onClickAction":{"type":"skip"},"disabled":true},
              {"type":"ListView","id":"n4","children":[
                {"type":"ListViewItem","id":"n5","onClickAction":{"type":"pick","payload":{"i":1}},
                 "children":[{"type":"Text","id":"n6","value":"First row"}]}
              ]}
            ],"confirm":{"label":"OK","action":{"type":"ok"}},"cancel":{"label":"No","action":{"type":"no"}}}
        """)
        val actions = widgetActions(root)
        assertEquals(listOf("n2", "n5", "confirm", "cancel"), refs(actions))
        assertEquals("save", actions[0].action.type)
        assertEquals("First row", actions[1].label)
        assertEquals(listOf(null, null, "confirm", "cancel"), actions.map { it.tone })
        assertTrue(actions.none { it.client })
    }

    @Test
    fun `a submit button takes the nearest form's onSubmitAction`() {
        val root = tree("""
            {"type":"Card","id":"n1","children":[
              {"type":"Form","id":"n2","onSubmitAction":{"type":"ask","payload":{"q":1}},"children":[
                {"type":"Button","id":"n3","label":"Send","submit":true},
                {"type":"Button","id":"n4","label":"Solo","submit":true,"onClickAction":{"type":"own"}}
              ]},
              {"type":"Button","id":"n5","label":"Orphan","submit":true}
            ]}
        """)
        val actions = widgetActions(root)
        assertEquals(listOf("n3", "n4"), refs(actions))
        assertEquals("ask", actions[0].action.type)
        assertEquals("submit", actions[0].tone)
        assertEquals("own", actions[1].action.type)
    }

    @Test
    fun `same-label buttons in different rows are named with their row`() {
        val root = tree("""
            {"type":"ListView","id":"n1","children":[
              {"type":"ListViewItem","id":"n2","children":[
                {"type":"Text","id":"n3","value":"Ada"},
                {"type":"Button","id":"n4","label":"View","onClickAction":{"type":"view","payload":{"i":1}}}
              ]},
              {"type":"ListViewItem","id":"n5","children":[
                {"type":"Text","id":"n6","value":"Grace"},
                {"type":"Button","id":"n7","label":"View","onClickAction":{"type":"view","payload":{"i":2}}}
              ]}
            ]}
        """)
        val labels = widgetActions(root).map { it.label }
        assertEquals(listOf("View: Ada", "View: Grace"), labels)
    }

    @Test
    fun `client actions are marked and their targets read`() {
        val root = tree("""
            {"type":"Card","id":"n1","children":[
              {"type":"Button","id":"n2","label":"Open","onClickAction":{"type":"open_url","payload":{"url":"https://example.com"}}},
              {"type":"Button","id":"n3","label":"Thread","onClickAction":{"type":"open_thread","payload":{"botId":"bot-1","threadId":"t-2"}}},
              {"type":"Button","id":"n4","label":"Room","onClickAction":{"type":"open_thread","payload":{"groupId":"g-1","threadId":"t-3"}}}
            ]}
        """)
        val actions = widgetActions(root)
        assertTrue(actions.all { it.client })
        assertEquals("https://example.com", widgetActionUrl(actions[0].action))
        assertEquals(WidgetThreadTarget.Bot("bot-1", "t-2"), widgetThreadTarget(actions[1].action))
        assertEquals(WidgetThreadTarget.Group("g-1", "t-3"), widgetThreadTarget(actions[2].action))
    }

    @Test
    fun `fields take Label text by fieldName and a named ListView is a field`() {
        val root = tree("""
            {"type":"Card","id":"n1","children":[
              {"type":"Label","id":"n2","fieldName":"city","value":"City"},
              {"type":"Input","id":"n3","name":"city","defaultValue":"Paris"},
              {"type":"Checkbox","id":"n4","name":"again","label":"Do it again","defaultChecked":true},
              {"type":"ListView","id":"n5","name":"who","title":"Who cooks","children":[
                {"type":"ListViewItem","id":"n6","value":"me","children":[{"type":"Text","id":"n7","value":"Me"}]},
                {"type":"ListViewItem","id":"n8","value":"you","children":[{"type":"Text","id":"n9","value":"You"}]}
              ]}
            ]}
        """)
        val fields = widgetFields(root)
        assertEquals(listOf("city", "again", "who"), fields.map { it.name })
        assertEquals("City", fields[0].label)
        assertEquals("Do it again", fields[1].label)
        assertEquals("Who cooks", fields[2].label)
        val options = widgetFieldOptions(fields[2].node)
        assertEquals(listOf("me", "you"), options.map { it.value })
        assertEquals(listOf("Me", "You"), options.map { it.label })
        val initial = widgetInitialValues(root)
        assertEquals("Paris", initial["city"])
        assertEquals(true, initial["again"])
        assertEquals("", initial["who"])
    }

    @Test
    fun `scope is the nearest form around the pressed ref`() {
        val root = tree("""
            {"type":"Card","id":"n1","children":[
              {"type":"Input","id":"n0","name":"outside"},
              {"type":"Form","id":"n2","onSubmitAction":{"type":"ask"},"children":[
                {"type":"Input","id":"n6","name":"inside"},
                {"type":"Button","id":"n3","label":"Send","submit":true}
              ]}
            ],"confirm":{"label":"OK","action":{"type":"ok"}}}
        """)
        assertEquals("n2", widgetScope(root, "n3").id)
        assertEquals("n1", widgetScope(root, "confirm").id)
        val inForm = widgetFields(widgetScope(root, "n3"), root).map { it.name }
        assertEquals(listOf("inside"), inForm)
    }

    @Test
    fun `press refuses a confirm with a required field empty`() {
        val root = tree("""
            {"type":"Card","id":"n1","children":[
              {"type":"Select","id":"n2","name":"pick","required":true,"options":[
                {"label":"A","value":"a"},{"label":"B","value":"b"}]}
            ],"confirm":{"label":"Go","action":{"type":"go"}}}
        """)
        val confirm = widgetActions(root).single()
        val values = widgetInitialValues(root)
        val press = widgetPress(root, confirm, values, emptyMap())
        assertEquals("pick", press.missing?.name)
        val filled = widgetPress(root, confirm, values + ("pick" to "b"), emptyMap())
        assertNull(filled.missing)
        assertEquals("b", filled.values!!["pick"]!!.jsonPrimitive.contentOrNull)
        assertNull(filled.other)
    }

    @Test
    fun `press puts own words in other and empties the value`() {
        val root = tree("""
            {"type":"Card","id":"n1","children":[
              {"type":"RadioGroup","id":"n2","name":"meal","allowOther":true,"options":[
                {"label":"Rice","value":"rice"},{"label":"Noodles","value":"noodles"}]}
            ],"confirm":{"label":"Go","action":{"type":"go"}}}
        """)
        val radio = WidgetNode((root.json["children"] as JsonArray)[0] as JsonObject)
        assertTrue(widgetTakesOther(radio))
        val confirm = widgetActions(root).single()
        val press = widgetPress(root, confirm, widgetInitialValues(root), mapOf("meal" to "dumplings"))
        assertNull(press.missing)
        assertEquals("", press.values!!["meal"]!!.jsonPrimitive.contentOrNull)
        assertEquals("dumplings", press.other!!["meal"]!!.jsonPrimitive.contentOrNull)
    }

    @Test
    fun `cancel presses carry no values`() {
        val root = tree("""{"type":"Card","id":"n1","children":[
            {"type":"Input","id":"n2","name":"q"}],"cancel":{"label":"No","action":{"type":"no"}}}""")
        val cancel = widgetActions(root).single()
        val press = widgetPress(root, cancel, mapOf("q" to "something"), emptyMap())
        assertNull(press.values)
        assertNull(press.other)
        assertNull(press.missing)
    }

    @Test
    fun `time slots step from min to max and hold an off-grid value`() {
        val node = tree("""{"type":"TimePicker","id":"n1","name":"at","min":"09:00","max":"10:30","step":15}""")
        assertEquals(listOf("09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30"), widgetTimeSlots(node))
        assertTrue(widgetTimeSlots(node, "09:07").contains("09:07"))
        assertEquals("09:30", widgetTime("9:30"))
        assertEquals("", widgetTime("soon"))
    }

    @Test
    fun `days caption names the sets in chinese`() {
        assertEquals("每天", widgetDaysCaption("mon,tue,wed,thu,fri,sat,sun"))
        assertEquals("工作日", widgetDaysCaption("mon,tue,wed,thu,fri"))
        assertEquals("周末", widgetDaysCaption("sat,sun"))
        assertEquals("未选择日期", widgetDaysCaption(""))
        assertEquals("周一、周三", widgetDaysCaption("mon,wed"))
    }

    @Test
    fun `labelled fields come from Label fieldName`() {
        val root = tree("""{"type":"Card","id":"n1","children":[
            {"type":"Label","id":"n2","fieldName":"city","value":"City"},
            {"type":"Input","id":"n3","name":"city"},
            {"type":"Input","id":"n4","name":"other"}]}""")
        assertEquals(setOf("city"), labelledFields(root))
    }

    @Test
    fun `localized card swaps i18n fields for zh words and keeps the rest`() {
        val root = Json.parseToJsonElement("""
            {"type":"Card","id":"n1","children":[
              {"type":"Title","id":"n2","value":"Your brief","i18n":{"value":{"key":"brief.card.title"}}},
              {"type":"Text","id":"n3","value":"Plain words","i18n":{"value":{"key":"brief.nothing.here"}}},
              {"type":"Text","id":"n4","value":"Notice","i18n":{"value":{"key":"chat.notice.phone.denied.calendar"}}}
            ]}
        """).jsonObject
        val zh = localizeWidgetRoot(root, serverCard = true)
        val kids = zh["children"] as JsonArray
        assertEquals("你的简报", (kids[0] as JsonObject)["value"]!!.jsonPrimitive.contentOrNull)
        assertEquals("Plain words", (kids[1] as JsonObject)["value"]!!.jsonPrimitive.contentOrNull)
        assertEquals("手机上不允许使用日历", (kids[2] as JsonObject)["value"]!!.jsonPrimitive.contentOrNull)
        val same = localizeWidgetRoot(root, serverCard = false)
        assertEquals("Your brief", (same["children"] as JsonArray).let { (it[0] as JsonObject)["value"]!!.jsonPrimitive.contentOrNull })
    }
}
