# PHONE_UI_DO_EACH：列表条目逐条跑同一段步骤

上游参考：Mika `DoEach.kt` + `EachRunner.kt` + `EachCursor.kt`/`ScrollCursor.kt`
（2026-11-20 `8b3683f3`、`f82f3fd8`；Apache-2.0）。设计页照惯例先落一页纸。

## 问题

模型清一个列表（逐条已读标记、逐条转发、逐条删草稿）现在只能：`PHONE_UI_FIND`
拿一屏条目 → 对每条发 `PHONE_UI_TAP`/`PHONE_UI_RUN` → 自己滚屏再 find——每个条目
都要过一次模型脑子，一个 20 条的列表烧 40+ 个回合，且滚动时机全靠模型自觉。

## 提议

一个新工具 `PHONE_UI_DO_EACH`，把循环收进一次调用：

```
PHONE_UI_DO_EACH {
  item:   { text?: string, resourceId?: string, role?: string }  // 至少一项；怎么认出"一条"
  body:   Step[]                                                  // 1-30 步，同 PHONE_UI_RUN 的步骤
  on_error: "stop" | "skip"                                       // 默认 stop
  reveal:  "scroll" | "none"                                      // 默认 scroll：可见条目做完后滚屏找更多
  max_items: 1-50                                                 // 默认 20，安全上限
}
```

- `@item` 约定：body 步骤的 `targetText` 写 `"@item"` 表示"作用于当前条目"
  （ref 直点，不重找）；其余步骤照 PHONE_UI_RUN 语义逐步重找。
- 答案是紧凑摘要：`{ done, failed, stoppedAt?, perItem: [{ key, ok }], screen… }`
  ——N 轮压成 1 轮，不逐条截图。

## 循环引擎（照 Mika 算法，Kotlin 落 `PhoneUiDoEach.kt`）

- **身份键 `contentKey = role|name`**：跨快照、跨滚动稳定；`ref` 每次读屏重排，
  `resourceId` 同列表全同构，都不能认"同一条"。
- **游标 advance**：读屏 → 匹配出条目（role 全等 / text 子串）→ 记 seen；
  第一个 contentKey ∉ done 的 → DoNext；无未做条目且刚滚过一次且无新 contentKey →
  End；否则 → Scroll。
- **失败语义**：Stop（安全默认，停在原条，留下可重试）/ Skip（投递类常用，
  失败也记 done，免得下一轮撞同一条）。
- **就地循环与「打开→做→返回」无区别**：执行器只关心这条做没做成；就地移除时
  列表上移但 contentKey 不变，游标照常去重。
- **已知边界**：同名条目（contentKey 相同）收敛成"做一次"——元素信息不足以跨
  滚动区分两条同名条目；文档写明，不算缺陷。

## 落点与接线

| 件 | 落点 |
| --- | --- |
| 工具 schema | `server/phones/tools.ts`（`PHONE_TOOL_NAMES` 进 53） |
| 提示词 | `server/phones/instructions.ts`（何时用 do_each 而非 RUN 循环） |
| 活动行/写集合 | `server/chat-notices.ts` + `shared/outbound.ts`（写工具，走卡片） |
| 不可逆闸 | `server/phones/confirm.ts`：body 步骤与 PHONE_UI_RUN 同规则（首条命中
  分类词的步骤拒绝整个调用）；`@item` 步骤与 RUN 的后续屏步骤同一姿态——
  运行时目标不在服务器看过的屏上则无法预判，靠每轮答案带整屏保持服务器视图新鲜 |
| 守卫 | 每步经执行器 write 路径 → 既有 repeat/unchanged/cycle 守卫照常计数 |
| Android 引擎 | `android/app/src/main/kotlin/com/lunabot/companion/phoneui/PhoneUiDoEach.kt`
  （纯 data-in/data-out：read/scroll/doItem 回调注入，无协程与 Android 类型），
  `PhoneUiTaskExecutor` 注册 `doEach`，body 步骤复用 `PhoneUiRun` 的步骤执行 |
| 测试 | 引擎 JVM 单测（游标/摘要/失败语义/`@item` 替换）+ server 侧 schema/confirm 用例 |

## 不做（本轮）

- **EachLoopDetector**（检测"逐条干活"动词重复 3 次提醒改用 do_each）：那是
  agent 循环层的补充，先靠 instructions 里一句提示词引导；真实跑出低效模式
  后再立项。
- `clear` 操作：fork 的 PHONE_UI_RUN 步骤集没有它，维持不动。

## 验证

1. JVM：`PhoneUiDoEachTest`——advance 三态、contentKey 去重、stop/skip、
   max_items 兜底、`@item` 直点。
2. server：schema 校验、confirm 对 body 命中分类词的拒绝、活动行文案、
   i18n en+zh。
3. 真机抽查：改用隔离 fixture 全链先过（`pnpm control:omb` 纪律不变）。
