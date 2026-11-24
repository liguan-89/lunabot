package com.lunabot.companion.ui.widget

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import com.lunabot.companion.core.APIError
import com.lunabot.companion.core.Chat
import com.lunabot.companion.core.Message
import com.lunabot.companion.core.PHONE_PAIRING_ACTION
import com.lunabot.companion.core.ThreadRef
import com.lunabot.companion.core.WidgetActionEntry
import com.lunabot.companion.core.WidgetField
import com.lunabot.companion.core.WidgetNode
import com.lunabot.companion.core.WidgetThreadTarget
import com.lunabot.companion.core.labelledFields
import com.lunabot.companion.core.localizeWidgetRoot
import com.lunabot.companion.core.widgetActionUrl
import com.lunabot.companion.core.widgetActions
import com.lunabot.companion.core.widgetFields
import com.lunabot.companion.core.widgetInitialValues
import com.lunabot.companion.core.widgetPress
import com.lunabot.companion.core.widgetThreadTarget
import com.lunabot.companion.ui.LocalCompanion
import com.lunabot.companion.ui.minisDanger
import com.lunabot.companion.ui.minisInk
import com.lunabot.companion.ui.minisSecondary
import com.lunabot.companion.ui.minisSuccess
import com.lunabot.companion.ui.minisTertiary
import com.lunabot.companion.ui.musePaperCard
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

private const val SENT_MS = 1_600L

/** 桌面 WidgetForm context 的手机对应物：卡片范围内共享的表单状态。 */
class WidgetFormState(
    val root: WidgetNode,
    val actions: Map<String, WidgetActionEntry>,
    val fields: Map<String, WidgetField>,
    val labelled: Set<String>,
    initial: Map<String, Any>,
    settledValues: Map<String, Any>,
    private val settledOther: Map<String, String>,
    val isSettled: Boolean,
    val onAllowImages: () -> Unit,
) {
    private val edits = mutableStateMapOf<String, Any>()
    private val otherEdits = mutableStateMapOf<String, String>()
    var locked by mutableStateOf(false)
    var imagesAllowed by mutableStateOf(false)
    var pendingRef by mutableStateOf<String?>(null)
    var sentRef by mutableStateOf<String?>(null)
    var problemField by mutableStateOf<String?>(null)
    var problemText by mutableStateOf<String?>(null)

    private val base = initial + settledValues
    val values: Map<String, Any> get() = base + edits
    val other: Map<String, String> get() = if (isSettled) settledOther else otherEdits

    fun value(name: String): String = (values[name] as? String) ?: ""
    fun checked(name: String): Boolean = values[name] == true

    fun setValue(name: String, value: Any) {
        edits[name] = value
        otherEdits.remove(name)
        if (problemField == name) problemField = null
    }

    fun chooseOther(name: String) {
        edits[name] = ""
        otherEdits.putIfAbsent(name, "")
        if (problemField == name) problemField = null
    }

    fun setOther(name: String, text: String) {
        otherEdits[name] = text
        if (problemField == name) problemField = null
    }
}

/**
 * 一条 `kind == "widget"` 消息的完整渲染：与桌面 WidgetMessage 同一协议——
 * 树来自 wire `widget.root`，按下经 `POST /api/bots/{id}/messages {widgetAction}`。
 * `openLink`/`openThread`/`openChat`/`openPhonePairing` 处理 client action。
 */
@Composable
fun WidgetCardMessage(
    chat: Chat,
    message: Message,
    openLink: ((String, Message) -> Unit)?,
    openThread: ((ThreadRef) -> Unit)?,
    openChat: ((Chat) -> Unit)?,
    fallback: @Composable () -> Unit,
) {
    val payload = message.widget ?: run { fallback(); return }
    val rawRoot = payload.root ?: run { fallback(); return }
    val root = remember(rawRoot, message.serverCard) {
        WidgetNode(localizeWidgetRoot(rawRoot, message.serverCard == true))
    }
    if (root.type.isEmpty()) {
        fallback()
        return
    }
    // 房间里的小组件照常渲染但按下无效（服务端也拒 ROOM_VIEW_ONLY），botId 只供发送。
    val botId = (chat as? Chat.BotChat)?.bot?.id ?: ""
    val threadId = chat.threadId
    // rev 变化 = 整棵树被换、节点 id 重新编号：重挂卡片。
    androidx.compose.runtime.key(payload.rev) {
        WidgetCard(botId, threadId, message, root, payload, viewOnly = chat is Chat.RoomChat, openLink, openThread, openChat)
    }
}

@Composable
private fun WidgetCard(
    botId: String,
    threadId: String,
    message: Message,
    root: WidgetNode,
    payload: com.lunabot.companion.core.WidgetCardData,
    viewOnly: Boolean,
    openLink: ((String, Message) -> Unit)?,
    openThread: ((ThreadRef) -> Unit)?,
    openChat: ((Chat) -> Unit)?,
) {
    val session = LocalCompanion.current.session
    val state by session.state.collectAsState()
    val scope = rememberCoroutineScope()

    var settledHere by remember { mutableStateOf<JsonObject?>(null) }
    var rowSpoke by remember { mutableStateOf(payload.settled != null) }
    if (payload.settled != null && !rowSpoke) rowSpoke = true
    val settled = payload.settled ?: (if (rowSpoke) null else settledHere?.let { local ->
        com.lunabot.companion.core.WidgetSettledRef(
            label = local["label"]?.jsonPrimitive?.contentOrNull ?: "",
            tone = local["tone"]?.jsonPrimitive?.contentOrNull ?: "",
            values = local["values"] as? JsonObject,
            other = local["other"] as? JsonObject,
        )
    })
    val isSettled = settled != null
    val withdrawn = payload.withdrawn != null && !isSettled

    var details by remember { mutableStateOf(false) }
    var imagesAllowed by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<String?>(null) }
    var problemText by remember { mutableStateOf<String?>(null) }
    var problemField by remember { mutableStateOf<String?>(null) }
    val sendingNow = remember { androidx.compose.runtime.mutableStateOf(false) }
    val retry = remember { androidx.compose.runtime.mutableStateOf<Pair<String, String>?>(null) }

    val form = remember(root, settled) {
        WidgetFormState(
            root = root,
            actions = widgetActions(root).associateBy { it.ref },
            fields = widgetFields(root).associateBy { it.name },
            labelled = labelledFields(root),
            initial = widgetInitialValues(root),
            settledValues = settled?.values?.mapValues { (_, v) -> v.jsonPrimitive.booleanOrNull ?: v.jsonPrimitive.contentOrNull ?: "" } ?: emptyMap(),
            settledOther = settled?.other?.mapValues { (_, v) -> v.jsonPrimitive.contentOrNull ?: "" } ?: emptyMap(),
            isSettled = settled != null,
            onAllowImages = { imagesAllowed = true },
        )
    }
    // `sent` 闪烁在 form 外维护，按下成功后短暂显示。
    var sentRef by remember { mutableStateOf<String?>(null) }
    form.problemField = problemField
    form.problemText = problemText
    form.pendingRef = pending
    form.sentRef = sentRef
    form.locked = isSettled || pending != null || viewOnly
    form.imagesAllowed = imagesAllowed

    fun press(ref: String) {
        val entry = form.actions[ref] ?: return
        if (sendingNow.value || pending != null) return
        if (entry.client) {
            val url = widgetActionUrl(entry.action)
            if (url != null) openLink?.invoke(url, message)
            when (val target = widgetThreadTarget(entry.action)) {
                is WidgetThreadTarget.Bot -> openThread?.invoke(ThreadRef(target.botId, target.threadId, ""))
                is WidgetThreadTarget.Group -> state.rooms.firstOrNull { it.id == target.groupId }
                    ?.let { openChat?.invoke(Chat.RoomChat(it)) }
                null -> if (entry.action.type == PHONE_PAIRING_ACTION) {
                    // 手机端没有「配对一台手机」的页——配对在本机设置里。
                    problemText = "配对请在电脑端操作"
                }
            }
            return
        }
        if (isSettled || withdrawn || viewOnly) return
        val assembled = widgetPress(root, entry, form.values, form.other)
        val missing = assembled.missing
        if (missing != null) {
            problemText = "请填写${missing.label}。"
            problemField = missing.name
            return
        }
        val key = listOf(ref, assembled.values.toString(), assembled.other.toString()).joinToString("\n")
        val sendId = if (retry.value?.first == key) retry.value!!.second else UUID.randomUUID().toString()
        retry.value = key to sendId
        sendingNow.value = true
        rowSpoke = false
        settledHere = null
        problemText = null
        problemField = null
        sentRef = null
        pending = ref
        val action = buildJsonObject {
            put("messageId", message.id)
            put("ref", ref)
            put("rev", payload.rev)
            assembled.values?.let { put("values", it) }
            assembled.other?.let { put("other", it) }
        }
        scope.launch {
            try {
                session.sendWidgetAction(botId, action, threadId, sendId)
                sendingNow.value = false
                retry.value = null
                if (entry.tone != null) {
                    settledHere = buildJsonObject {
                        put("label", entry.label)
                        put("tone", entry.tone)
                        assembled.values?.let { put("values", it) }
                        assembled.other?.let { put("other", it) }
                    }
                    pending = null
                    return@launch
                }
                pending = null
                sentRef = ref
                delay(SENT_MS)
                sentRef = null
            } catch (error: APIError.Status) {
                sendingNow.value = false
                retry.value = null
                pending = null
                problemText = error.serverMessage ?: error.message ?: "未能发送。请重试。"
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                sendingNow.value = false
                pending = null
                problemText = "未能发送。请重试。"
            }
        }
    }
    form.locked = isSettled || pending != null || viewOnly

    val cardBody: @Composable () -> Unit = {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .musePaperCard()
                .padding(bottom = 4.dp),
        ) {
            WidgetHead(root)
            WidgetBody(root, form, ::press, headed = true)
            problemText?.let { text ->
                Text(
                    text = text,
                    fontSize = 13.sp,
                    color = minisDanger,
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 6.dp),
                )
            }
            if (withdrawn) {
                Text(
                    text = "已撤回",
                    fontSize = 12.5.sp,
                    fontStyle = FontStyle.Italic,
                    color = minisTertiary,
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 8.dp),
                )
            }
            if (!isSettled && !withdrawn) {
                WidgetFooter(form, ::press)
            }
        }
    }

    if (!isSettled) {
        cardBody()
        return
    }
    // 已答：收成一行收据，详情可展开。
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                imageVector = if (settled!!.tone == "cancel") Icons.Filled.Close
                else Icons.Filled.Check,
                contentDescription = null,
                tint = if (settled.tone == "cancel") minisTertiary else minisSuccess,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = settled.label,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = minisInk,
                modifier = Modifier.weight(1f),
            )
            ClickableText(
                text = AnnotatedString(if (details) "隐藏详情" else "详情"),
                onClick = { details = !details },
                style = androidx.compose.ui.text.TextStyle(fontSize = 12.sp, color = minisSecondary),
            )
        }
        if (details) cardBody()
    }
}
