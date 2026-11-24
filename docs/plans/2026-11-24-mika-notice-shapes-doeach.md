# Mika 二轮补遗：NoticeShapes 消费端 + do_each 循环提醒

两项都来自上游 Mika 11-20/11-21 之后仍未移植的部分，外加 11-23 的 uistate 修复评估
（评估结论：不需要补，见下）。目标是把「通知按会话归一」和「逐条干活时提示
do_each」两块补齐，不引入新表面。

## 1. NoticeShapes 消费端

上游 `core/proactive/NoticeShapes.kt`：把每条通知理成统一形状——`title` 是会话名
（人或群）、`sender` 是群里发言的人、`text` 只剩那句话、`group` 标群/私聊。
在清洗之后、进收件箱之前做一次，后面的判定、提醒、归纳都用理好的。

现状：手机侧 `NoticeEvent.kt` 已把 MessagingStyle 的原始字段（`conversation`、
`group`、`conversationTitle`、`titleIsSpeaker`、`messages[]`、`sender`）放上
wire，`phone-notices.ts` 的 schema、sanitize、dedup、triage 输入、learn 输入都收了
这些字段——**唯独没有 shaping 这一步**。后果：

- MessagingStyle 群聊的 `EXTRA_TITLE` 常是「群名: 最新发言人」，不修形时每个
  不同末位发言人都像一个新会话，`conversationTitle` 白给了没人用；
- `sender` 只取 messages 最后一条的署名，群里自己发的消息（sender=null）会让
  sender 落空，而 shaping 能从标题尾缀「群名: 张三」补回发言人；
- QQ/微信非 MessagingStyle 写法（「群名(N条新消息)」「[3条]某人: …」）完全没拆。

移植：`shapeNotice(record)` 纯函数进新文件 `server/phone-shapes.ts`（与上游同属
core/proactive 一族；单独成文也让 phone-notices.ts 守在 1000 行棘轮下），在
`noticeFor` 里 `sanitizeNotice` 之后调用。忠实移植
`styled()`（conversationTitle→title、标题尾缀→sender、group 归一、
无会话名且 group 时 titleIsSpeaker）和 `chat()`（QQ 四包名 + 微信两条启发式，
`SAID`/`UNREAD_PREFIX`/`withoutUnreadCount` 原样），不 port `ContactIdentity`
（联系人学习整体不移植，文档已注明 contactsAllowed 关）。

已知取舍：上游把 QQ 私聊、微信群两条猜测标为「没在真机上核实」——照样移植
（上游自己也在发），拆错的后果只是该条的说话人/群私标错。

## 2. EachLoopDetector → do_each 提醒

上游 `core/agent/EachLoopDetector.kt`（11-21 引入，60 行纯状态机）：最近动词
序列里「开详情→动作→返回」的 motif 完整重复 3 次时提醒一次 do_each，每任务最多
一次；模型自己用了 do_each 就永久解除武装；失败、非屏动词打断序列。

现状：我们有 `cycleLadder` 兜圈提醒（屏级 A-B-A），但没有这个**动作级定向
建议**——模型逐条手点列表时不会被提示有 `PHONE_UI_DO_EACH`。

移植：检测器进 `server/phone-guards.ts`（同属「驱动手机的 bot 的守卫」），动词
映射 `guardVerb(tool, args)` 同文件导出。接线在 `PhoneConfirms`：guards 表项
加 `each` 检测器实例（与 GuardState 同生命周期、同 generation 键），新增
`noteEach(turn, tool, args, ok)` 在 host.ts 每个**已执行**的手机调用后喂一次
（上游也是每个 Ran 结果喂 verb+ok：非计数动词与失败都重置序列、DO_EACH 解除
武装）。触发时返回一次性 nudge，与 guard warn 的 nudge 走同一条 `withNudge`
`note` 通道。提醒文案按我们的工具名改写（`PHONE_UI_DO_EACH`、`item`/`body`/
`@item`）。

动词映射按上游 `COUNTED` 集合逐一核对过（`AgentTool.kt` 的 Verb 枚举 +
`PhoneAutomationTools.kt`/`ReadTools.kt` 的工具→Verb 表）：只有上游计数的
原语映射为动词——observe→observe、tap/tap_at→tap、type→type、
scroll→scroll、swipe→swipe、PHONE_UI_BACK 与 key=back→back、其余
key→press、wait→wait；PHONE_UI_DO_EACH→do_each（解除武装）。上游
**不计数**的 query/collect/find/run/screenshot 及一切非屏工具（含
PHONE_UI_OCR、LAUNCH、AFTER_TASK、短信/微信/文件工具）→ null，喂入即
重置序列。QUERY/COLLECT/FIND 是「帮你找」的高层工具，逐条 motif 只由
原语构成，交给它们反而会把真 motif 切碎——与上游一致。

## 3. 评估后不补的上游新提交

- #810/#816 空树重读：我们的 observe 遇瞬空树直接回空 elements。上游修的是
  「判 unusable 前重读一次」；我们的空树没有 unusable 判定、模型自行会再
  observe，收益小、改动在手机侧快照路径，暂不做。
- #815 do_each 计数：我们 `rounds` 只计实际条目，语义已正确。
- tablesAtBirth 元素压表、APP.md 应用知识、screenmap 回放接图：中等偏大，
  留待下一轮评估。

## 验证

- `shapeNotice`：styled/chat 各形状用例（群聊会话名归一、私聊不动、QQ/微信
  启发式、未读条数剥离、titleIsSpeaker 归一）进 `phone-notices.test.ts`。
- `EachLoopDetector`：motif 3 次触发、周期 2–5、失败/非计数动词打断、
  do_each 解除武装、每任务一次，进 `phone-guards.test.ts`；接线面
  （noteEach 返回 nudge、withNudge 合并、generation 重置）进 `confirm.test.ts`
  /`host.test.ts`。
- `pnpm typecheck` + `oxlint --deny-warnings` + 定向 vitest。
