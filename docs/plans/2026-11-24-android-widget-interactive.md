# Android 原生小组件交互：桌面 widget 渲染器的 Compose 全量移植

## 为什么

`kind: "widget"` 消息在手机上只有 `WidgetSummaryCard` 收据（「此小组件的交互按钮
请在电脑端操作」）。widget 树本来就是平台无关的 JSON（`shared/widget.ts`），
按键通道 `POST /api/bots/{id}/messages {widgetAction}` 服务端也已对手机会话开放
（`server/routes/bot-messages.ts` 无客户端限制，`fromPhone` 还有专门记账）。
缺的只是 Android 的解析、渲染与按下回传。用户拍板：全量对齐桌面，移动端优先。

## 协议现状（不改）

- 树在 wire `Message.widget.root` 上，手机此前不解析它（`WidgetCardData` 只留
  `v`+`settled`，注释明写 deliberate）。
- 按下 = 发消息：`{widgetAction:{messageId,ref,rev,values?,other?}, threadId, sendId}`
  → `prepareWidgetPress` → 记成人的一条消息；settling 键（confirm/cancel/submit）
  写 `widget.settled`，排队取消经 `reopenCancelledPress` 自动重开。
- client action（`open_url`/`open_thread`/`open_phone_pairing`）永不上行，由渲染端处理。

## 改动

**core**（`android/core`，纯逻辑+网络）：

- `Models.kt`：`WidgetCardData` 加 `root: JsonObject?`、`rev: Int`、
  `withdrawn: JsonObject?`；`WidgetSettledRef` 加 `values`/`other`。`Message`
  加 `serverCard: Boolean?`。
- 新 `WidgetTree.kt`：JsonObject 版 `WidgetNode` + 移植纯函数——`kids`、
  `widgetString/Number`、`collectActions`（confirm/cancel/行内按钮/行项/
  submit 经最近 Form 的 onSubmitAction/同名标签并排行名后缀/client 标记）、
  `widgetFields`（Label.fieldName 关联）、`widgetFieldOptions`、
  `widgetInitialValues`、`widgetScope`（最近 Form 否则 root）、`widgetTakesOther`、
  `firstText`、`labelledFields`、必填空值判定、按下 values/other 组装、
  `threadActionTarget`、`widgetActionUrl`、weekdays/timeOfDay/isoDate 归一化、
  `widgetTimeSlots`、DayPicker caption（zh）。
- 新 `WidgetText.kt`：服务器卡片本地化——`i18n` 字段（`readWidgetText` 同型）
  `{key,params}` → zh 表查词 → `{param}` 模板填充；params 支持 string/number/
  `{at,style,zone}` 时刻格式化（zh）/嵌套 key 递归；`chat.notice.*` 仅扁平参数；
  `brief.inbox.*` 的 amount/deadline 特判；查不到保留英文。zh 表 =
  `src/locales/zh.json` 中 `brief.*`/`chat.notice.*`/`server.meetings.*` 三个前缀
  全部词条（生成文件 `WidgetTextZh.kt`，头注明再生成方式）。
- `Client.kt`：`sendWidgetAction(botId, widgetAction: JsonObject, threadId, sendId)`
  → `SendReceipt`，复用 `isSafeRouteId/isSafeSendId`。
- `Session.kt`：薄封装直接透传（让 `APIError.Status.serverMessage` 冒到卡片
  显示，不走全局 actionError）。

**app**（`android/app/.../ui/widget/`，Compose 渲染器，对照
`src/components/widget/` 全套）：

- `WidgetCard.kt`：卡骨架（musePaperCard 圆 24、头部 status/title/caption/meta
  丸）、press 状态机（pending/sent 闪烁/problem/retry.sendId/settledHere/
  rowSpoke/locked）、settled 折叠行+「详情」展开、withdrawn 行、必填校验
  （required 空 → problem + 聚焦）、RoomChat 只读。
- `WidgetNodes.kt`：节点 dispatch——布局（Row/Col/Box/Form：gap/align/justify/
  wrap/background/border/radius/padding/flex share）、ListViewItem 行
  （min-height 60、含控件不嵌套按钮）、Spacer/Divider（flush 顶边）、
  Text/Title/Caption/Label（尺寸/字重/颜色/对齐/truncate/maxLines/minLines/
  italic/lineThrough）、Markdown→`MarkdownText`、Icon（条目首列圆底）、
  Badge（soft/solid/outline/dot × 6 色 × 3 号 × pill）、Progress、
  Button（primary/secondary/outline/quiet/danger、block、icons、disabled、
  pending spinner）、Table（header/对齐/colSpan 简化 weight）、Image
  （https 门+`imagesAllowed` 点击加载）、Chart→WidgetChart、Transition/未知
  →children。
- `WidgetFields.kt`：8 字段——Select（下拉+Other）、DatePicker（M3
  DatePickerDialog，min/max）、TimePicker（槽列表对话框，min/max/step）、
  DayPicker（7 圆钮+caption）、Checkbox、RadioGroup（+Other+输入）、
  Input（inputType→键盘类型）、Textarea；clearable ×钮、invalid 描边、
  labelled/inline 布局。
- `WidgetChart.kt`：Canvas 自绘 bar（分组/按 stack 堆叠、正负分堆）/line/area
  （null 断线、>16/>40 点缩点）、4 格网格、可选 y 轴（~s 紧凑数）、
  底部图例（>48 字符换行）、x 标签疏排——语义对齐 `shared/widget-chart.ts`。
- `WidgetImages.kt`：https→OkHttp 拉取→`decodeAttachmentImage` 解码→LruCache。
- `WidgetIcons.kt`：64 个 `WIDGET_ICON_NAMES` → Material `Icons`/`R.drawable`
  映射，未知→dot。
- `MessageRow.kt`：WIDGET 分支换 `WidgetCardMessage`（`root` 缺失仍回退
  `WidgetSummaryCard`）；接入现有 `openLink`/`openThread` 回调，
  `open_thread` 的 `groupId` 目标经 `state.rooms` → `onOpenChat(RoomChat)`
  （回调沿 `openThread` 同一管道加 `openChat`）；`open_phone_pairing` 在手机上
  无可达目标（配对是配对前流程，能看到卡的手机已配对过），卡面给出
  「配对请在电脑端操作」提示。

## 不做

- 服务端零改动；`kind: "app"` 沙箱页仍是收据（bridge 是电脑端的）。
- 不移植 `parseWidgetInput`/`resolveWidgetAction`/`widgetToText`：树已是规范形，
  按下由服务端复核；`widgetAdvice`/`widgetActionByLabel` 是模型侧。
- `open_phone_pairing` 在手机上是卡面提示而非跳转——导航栈（Navigation.kt
  Destination）没有配对目的地，配对页只在未配对阶段存在，语义上
  「配对一台手机」本来就是电脑侧动作。

## 验证

- `core` 新 `WidgetTreeTest`：对照 `shared/widget.test.ts` 关键用例——actions
  收集（种类/tone/client/行名后缀）、fields/scope/initialValues、takesOther、
  按下组装（disabled 保初值、other 与值互斥、required）、thread/url 目标、
  weekdays/timeOfDay/槽位。
- `:app:compileDebugKotlin` + `:app:testDebugUnitTest`（core/app 定向）。
- 视觉对照：同一张 widget 在桌面与手机的截图。
