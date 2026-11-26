# 手机端交互卡补齐：非 request 选项卡、grantProposal、setupSuggestion

2026-11-26 · 分支 `feat/phone-interactive-cards`

## 背景（审计发现的三处半成品）

1. **非 `requestId` 选项卡**：桌面端对无 `requestId` 的卡（onboarding 问答、模型切换提议、
   例程/资料请求等）走 `PATCH /api/bots/:id/cards/:mid` + 把答案作为普通消息发出；
   Android 未封装该 PATCH，且 `isPending` 要求 `requestId != null`，导致这类卡一律显示
   「已处理」且永远无法回答。
2. **`grantProposal`**：桌面端渲染 Grant/Refuse 按钮调 `/api/grants/answer`；Android 不解码
   该字段，只剩一条不可操作的文字。临时授权功能在手机上形同虚设。
3. **`setupSuggestion`**（helperKey）：桌面端有「添加密钥 / 暂不」；Android 不解码，
   「暂不」无法落盘，建议永远悬着。添加密钥本身按威胁模型留在电脑端。

## 范围

- Android core：
  - `Message` 增解码 `grantProposal`、`setupSuggestion`；`OptionCard` 增解码 `fixedOptions`。
  - `Client` 新增 `patchCard(botId, messageId, threadId, answered?, dismissed?)`、
    `answerGrant(threadId, messageId, answer)`、`dismissHelperSuggestion(threadId, messageId)`。
  - `Session` 新增对应 perform 包装；非 request 卡答案走「PATCH + send()（带 sendId）」。
- Android app：
  - 非 request 卡未回答时渲染选项按钮 + 自定义回复行 + 跳过；答后/跳过后显示结算行；
    桌面同款规则「之后已有用户文字则隐藏」在 ChatScreen 列表层实现。
  - TEXT 消息带 `grantProposal` 时渲染授权卡（允许/拒绝/已过期/已结算）；
    带 `setupSuggestion` 时渲染建议卡（暂不；添加密钥显示「请在电脑端添加」静态提示，
    因为决策模型密钥按设计只能在电脑上配置）。
- companion：`POST /api/grants/answer`、`POST /api/helpers/suggestion/not-now` 进白名单
  （harness 侧本来就 owner/admin 校验，scope 不放大）。

## 不做

- 房间内非 request 卡的回答（桌面同样不做，`inRoom` 直接 return）。
- `mcpRequest` 选项文案本地化（手机显示原文，与现状一致）。
- Add-key 的机内跳转——手机上没有决策模型密钥设置页，这是刻意的信任边界。

## 验收

- `:core:test`、`:app:testDebugUnitTest` 相关新增测试绿；
  `./gradlew :app:compileDebugKotlin` 过。
- companion 白名单测试同步更新。
- 定向 vitest（companion、grants、helper-suggestion 相关）绿；oxlint 改动文件零告警。
