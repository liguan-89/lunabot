# Plan: Android 真 steer + presence 上报（半成品排查批次1）

## Why

全面排查（2026-11-25 主仓库审计）确认两块手机端半成品：

- **假插话**：服务端/桌面端已有真 steer（`POST /api/bots|groups/:id/queue/:queueId/steer`，
  不打断当前回合把队首消息并进去），companion 白名单也已放行；Android「插话」按钮却只会
  `interrupt` 打断当前回合。桌面 `Composer.steerQueued` 的正确语义是混合式：引擎支持
  steering（`capabilities.queueing`）就走真 steer，否则回退 interrupt。Android 只有后半截。
- **无 presence**：`POST /api/presence/active` 白名单放行且注释写明接受 `source: "phone"`，
  桌面端用它报到「人回来了、开着哪个会话、时区语言」，服务端据此发到达简报；Android 从不调用。

## Design

### steer（对齐桌面 `Composer.steerQueued` 语义）

- `Client.steerQueued(queueId, to)`：POST `/api/bots/:id/queue/:queueId/steer` 或
  `/api/groups/:id/queue/:queueId/steer`，body `{threadId}`。404 处理复用
  `cancelQueued` 的旧电脑甄别模式（sidecar 对未放行路由也答 404，只按 harness 自己的措辞
  正向匹配「不是队首/不存在」类错误，其余 404 报「电脑版本过旧」）。
- `Session.steerQueued(send, chat)`：包 perform 语义，错误进 `_actionError`。
- `ChatScreen`：`steerNow` 改为混合式——`engineCanSteer`（实例在 `steeringInstanceIds`）
  且队首存在 → `session.steerQueued`；否则维持 `session.interrupt`。
  房间本轮仍不提供插话（现状如此，不是回归；房间真 steer 涉及 busyBot 归属，记后续）。

### presence

- `Client.reportPresence(body)` → `POST /api/presence/active`。
- `Session.reportPresence(threadId?)`：安静失败（不进 actionError，这是遥测性质的 ping），
  body 带 `source:"phone"`、`timeZone`（设备时区）、`language`（zh）、当前打开的 threadId。
- 触发点：app 回前台（节流，对齐桌面 `duePing` 意图：间隔内不重复）+ 打开聊天线程切换时。
- 应答里的 open target（到达简报）：服务端无论如何都会把简报写进线程；手机端本轮不自动跳转，
  用户在列表可见未读。记后续评估是否复用 PendingThreadNavigation。

## 验证

- `cd android && ./gradlew :core:testDebugUnitTest --tests '*Client*' --tests '*Session*'`（定向，不跑全量）
- 新增单测：Client steer 路由/body、404 甄别；presence body 形状与节流。
- 真机验证留用户：排队后点插话，pi 引擎应不打断当前回合直接并入（看电脑端日志/回合连续性）。

## 不做

- 房间 steer、presence 到达简报自动跳转、qwen/volc 语音（`lunabot-voice-mobile-parity` 线）。
