# 巨型审批卡治理 —— 一页纸

日期：2026-11-19
状态：实施中
相关：`docs/plans/2026-11-19-chat-bubbles-and-approval-card.md`（同一张卡的前一次改动）

## 现象

一张问题卡占满整屏，而且**同一个问题出现两次**：上半屏是 `current.question` 的正文，
下半屏是落地后的 `answeredText` 回显，而 `answeredText` 的内容就是
`Q: <同一个问题>\nA: 取消`（`AskQuestionAnswer.format` 的格式，写给模型看的）。

根因两条，都在客户端：

1. **正文无上限。** 问题正文是模型自己写的，`MAX_QUESTION_TEXT = 8000`
   （`shared/ask-question.ts:14`），手机把它整段铺开。桌面用
   `ExpandableText`（280 字 / 超 6 行 → 收成 4 行 + 「显示完整问题」）挡着，
   手机没挡。
2. **落地后仍画正文 + 全量答案。** 桌面 `SettledQuestion` 落地后只剩一行
   `AskSettledLine`（「你选择了：取消」），详情按需展开；手机保留整张卡再补一段
   原文回显，于是问题被印两遍。

`CardView`（普通审批卡）的 `subtitle` 同理无上限：一条命令、一段 diff 都能铺满。
桌面在 `OptionCard.tsx:92` 用 `ExpandableText` 包着。

## 改动

### 1. core：把答案按题读回来

`AskQuestionAnswer.answersByQuestion(questions, answer): Map<String, String>` ——
`shared/ask-question.ts` `questionAnswersByQuestion` 的移植，用于落地后只取
「这个人选了什么」，而不是把 `Q:/A:` 原文打给用户看。

- 支持两种编码：默认的 `Q: …\nA: …` 块，以及答案含换行时桌面改发的
  `Answers (JSON):` 形式（`shared/ask-question.ts:230`）。少了后者，
  从桌面答过的卡会在手机上显示一段原始 JSON。
- 没问过的问题、重复问题文本（无法区分）一律不认。
- 单题且格式不是块状时，整段回退为该题答案（桌面的 flat 分支）。

### 2. ui：`ExpandableText`（长文本限高）

`app/.../ui/ExpandableText.kt`。**不照抄桌面的 280 字 / 6 行门槛**：那个数字
在桌面成立（200 字是三行），在 411dp 手机上是七行——实测卡住的那条问题正文
150 字、5 个换行，两条标准都没超，屏幕上却铺了七行。

改为按**布局量出来的溢出**判定：先按 4 行渲染（`TextOverflow.Ellipsis`），
`onTextLayout` 里读 `hasVisualOverflow`；放得下就什么都不变，放不下才出现
「显示完整问题」。纯逻辑 `ExpandableTextRules` 只管两件可测的事——
折叠几行（4）、什么时候给开关（`expanded || overflowed`）。

### 3. `QuestionCardView`

- **待答**：正文换成 `ExpandableText`。长问题不再铺满，但一句话也不少。
- **落地**：不再画正文和 `Q:/A:` 原文，只留一行
  「✓ 你选择了：取消」（单题；答案不在选项里时是「你回答了：…」）。
  多题按桌面的 `tab: 答案 · tab: 答案`。
- **详情**：当完整答案文本比这一行说得多时给一个「详情」按钮，
  展开后小字块显示全文。桌面只对多题给详情；这里对「一行装不下」的也给，
  否则一张巨长问题落地后正文就彻底看不到了。

### 4. `CardView` 副标题

`card.subtitle` 换 `ExpandableText`。`SelectionContainer` 保留在展开后的正文上
（那段是要复制的）。

## 不做

- 不动协议、不加服务端字段。`MAX_QUESTION_TEXT` 是模型侧的限制，客户端不该改。
- 不做「点击整卡展开」：卡片里已有按钮，整卡可点会和按钮抢手势。
- 不改 `answeredText` 的编码格式——它是模型的工具结果，改了会破坏桌面/iOS 的解析。

## 测试

- `AskQuestionAnswerTest`（core）：块状往返、JSON 往返、伪造/未问过的问题、
  多行答案里夹 `Q:/A:`、单题 flat 回退。
- `ExpandableTextRulesTest`：280 字符、6 行、恰好边界各一条。
- `SettledQuestionLineTest`：单题选了选项、单题自由文本、多题拼装、无答案。

## 验证

T0：`compileDistKotlin` + 上述单测。T1：真机截图（同一张卡，落地前后各一张）。
