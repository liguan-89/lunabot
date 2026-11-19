# 对话气泡与审批卡片 —— 一页纸设计

日期：2026-11-19
状态：实施中
设计稿：`原型/对话气泡与审批卡片.html`（工作区根目录）

## 目标

把设计稿里能落到现有数据上的部分，改进 Android 聊天页（`com.lunabot.companion`）：
审批卡的信息层级，以及连发气泡的收口。不改协议、不加服务端字段。

## 现状

`CardView`（`MessageRow.kt:1480`）目前是：标题 16sp、副标题 15sp、动作竖排、
「始终允许此工具」文字按钮、结束后一行灰字。缺的是**状态**这一层——待确认、已允许、
已拒绝、已过期四种落点在视觉上几乎一样，全靠 1.5dp 蓝环和一行灰字区分。

气泡：`TextBubble` 收了 `endsRun` 参数（`MessageRow.kt:650`），但**函数体里没有用**；
`SpeechBubbleShape` / `BubbleTail`（`SpeechBubble.kt:38`）存在且有测试，`main/` 里没人调用。
所以连发时每只气泡都是独立 18dp 圆角，相接处没有收口。

## 数据可得性（决定能做什么）

| 设计稿元素 | 现有数据 | 结论 |
| --- | --- | --- |
| 状态行（需要你确认 / 已允许 / 已拒绝 / 已过期） | `isPending`、`expired`、`answered`、`responseBehavior` | 做 |
| 高风险红环 + 红色主按钮 | wire 有 `danger?: boolean`（`shared/wire.ts:729`），**Android `OptionCard` 没解这个字段** | 补字段后做 |
| 凭条里的工具名 | `card.tool` | 做（等宽字体） |
| 凭条里的「只读 / 外写」标签 | 客户端无只读分类 | **不做**（不猜） |
| 凭条里的日期范围 / 次数 | 无此字段 | **不做**（不猜） |
| 倒计时 | 只有 `expired` 布尔，无 `expiresAt` | **不做**（不伪造时间） |
| 落章里的时间戳 | 无 `answeredAt` | **不做**；只写结论与卡片自己的答案 |
| 连发收口 | `endsRun` 已有，`startsRun` 缺 | 补 |

设计稿里被砍掉的四项，都是因为要在客户端编造数据。宁可少画，不画假的。

## 改动

### 1. `OptionCard` 补 `danger`

`android/core/.../Models.kt:70` 起，加 `val danger: Boolean? = null`。
`ignoreUnknownKeys = true`（`Models.kt:35`）保证老客户端不受影响；这个字段 wire 早就发，
是客户端一直在丢。

### 2. 新增 `ApprovalCardStyle`（纯逻辑，可单测）

`android/app/src/main/kotlin/com/lunabot/companion/ui/ApprovalCardStyle.kt`

```kotlin
enum class ApprovalState { PENDING, ALLOWED, DENIED, EXPIRED, SETTLED }

data class ApprovalCardStyle(
    val state: ApprovalState,
    val label: String,        // 需要你确认 / 已允许 / 已拒绝 / 已过期
    val danger: Boolean,
    val stamp: String?,       // 落地后的一行记录；pending 时为 null
    val showsActions: Boolean,
    val showsAlwaysAllow: Boolean,
)
```

判定顺序（每一条都来自现有字段，不引入新语义）：

1. `isPending` → PENDING，`label = "需要你确认"`，无 stamp。
2. `expired == true && answered == null` → EXPIRED，`label = "已过期"`，无 stamp，不给动作。
3. `answered != null` → 按 `responseBehavior(answered)` 得 ALLOWED / DENIED；
   `label` 用「已允许」「已拒绝」；`stamp` 取 `answeredText ?: label`。
4. 其余（`dismissed`、无 `requestId` 的展示卡）→ SETTLED，不给动作。

`danger` 只透传，不改任何判定；`showsAlwaysAllow` 复用
`ApprovalChoices.showsAlwaysAllow(card, chat)`，不再在 UI 里重写一遍条件
（现在 `CardView:1626` 是 `alwaysAllow != null && chat is Chat.BotChat`，
两处规则容易走散）。

### 3. `CardView` 重排

结构（自上而下，`spacedBy` 按设计稿的 12 / 6 / 12）：

1. **状态行**：14dp 图标 + 11.5sp 加粗小字 + 右侧（无倒计时，留空）。
   图标随状态换：盾牌（待确认，`ic_shield_line`）、勾（已允许，`Icons.Filled.Check`）、
   时钟（已过期，`R.drawable.ic_schedule`）。拒绝态用中性灰，不画叉——拒绝不是错误。
2. **标题** 17sp / 600 / -0.01em。
3. **副标题** 14sp / secondary，保留 `SelectionContainer`（这段是要复制的）。
4. **凭条**：`minisGrouped` 底 + 10dp 圆角 + 10×12 内边距，工具名等宽 11.5sp / 78% 墨色。
   无 `tool` 时不画凭条（问题卡、展示卡没有工具名）。
5. **动作**：竖排，主按钮 `minisInk` 实心；`danger` 时主按钮 `minisDanger` 实心 + 白字；
   拒绝 `minisPage` tonal。全部 12dp 圆角、44dp 高。
6. **始终允许**：文字按钮，落在动作下方，不并排。
7. **落章**（仅落地后）：0.5dp 上发丝线 + 12sp；已允许用 `minisSuccess`，拒绝/过期用
   `secondaryTint`；过期不给图标。

边框：待确认 1.5dp `minisAccent`（danger 时 `minisDanger`）；落地后退到 0.5dp `minisSeparator`。

### 4. 气泡连发收口

- `TranscriptLayout` 加 `startsRowRun(rows, index)`：`index == 0 || endsRowRun(rows, index - 1)`。
- `ChatScreen.kt:1187` 与 `TranscriptPresentation.kt:100` 两处 `MessageRow` 调用都传 `startsRun`。
- `TextBubble` 用新形状 `joinedBubbleShape(mine, startsRun, endsRun)`：
  你自己的气泡右上角在 `!startsRun` 时收到 6dp、右下角在 `!endsRun` 时收到 6dp；
  其余 18dp。机器人不套气泡，这个形状对它无效果，但函数不假设方向。

不复用 `SpeechBubbleShape`：它有尾巴，设计稿定的是无尾 + 收口。那个形状保留给未来，
不在这次改动里删除（`SpeechBubbleTest` 还在测它）。

## 测试

- `ApprovalCardStyleTest`：五种状态的 label / stamp / 动作可见性；`danger` 透传；
  `answeredText` 优先于 label；过期不给动作。
- `TranscriptRunTest` 追加：`startsRowRun` 在首行、角色切换、卡片打断三种边界。
- Robolectric（`RemoteCardWiringTest` 同款脚手架）追加一条：待确认卡渲染出
  「需要你确认」与工具名；点击允许后渲染出「已允许」。

## 不做

- 选项弹层重做（`ChatOverflowMenu` / 加号 sheet / 长按菜单）：设计稿已给出规格，
  但那是独立的一次改动，不混进来。
- 倒计时、日期范围、只读标签、落章时间戳：无数据，不伪造。
- 服务端任何改动。

## 验证

T0：`./gradlew :app:compileDistKotlin` + 新增/受影响的单测。
留一张真机截图（`adb` 已连接）作为 T1 的视觉证据。
