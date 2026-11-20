# Plan: pi 能力补齐（steerImages / strictResume / effort 提示）

## Why

pi 驱动声明的能力面比协议实际支持的小。对照 `ProviderAdapter.capabilities`
契约（`server/contracts.ts`）和 pi 1.5.2 的 RPC schema
（`steer`/`follow_up`/`prompt` 均带 `images`，`switch_session`/`new_session`
有 success/failure 应答），有三处是"协议能做、我们没接"的真缺口：

- **带图 steer**：运行中发图只能排队等下轮，`engineSteersImages` 恒 false。
- **resume 静默降级**：`switch_session` 失败被 catch 吞掉，回合跑在空白
  会话上且无人知晓——违反 strictResume 契约"exact session / fail /
  rebuilt, never a blank one"。
- **effort 被拒不报**：`set_thinking_level` 失败静默保持引擎默认，人不知道
  档位没生效。

## Design

### steerImages

- `pi-rpc.ts` 提取 `piImagesOf(images)` 供 prompt 与 steer 共用
  （`TurnImageInput[]` → `{type:"image",data,mimeType}[]`）。
- `steerActiveTurn(text, images)`：图文件读不出来时整个 steer 返回
  `"refused"`（契约：不能读图就拒整个 steer），否则随帧发 `images`。
- capabilities 加 `steerImages: true`（`queueing`+`nativeImageInput` 已有，
  `engineSteersImages` 随之放开带图插话）。

### strictResume

- 握手提取 `openSession(command)`：`cancelled: true` 也按拒绝处理。
- `turn.resumeCursor` 存在且 switch_session 失败（拒绝/取消/超时）：
  1. 子进程还活着 → `new_session` 重开；
  2. 重开成功 → `sessionRebuilt`：prompt 用 `turn.recoveryText ?? turn.text`，
     `session.started` 带 `rebuilt: true`，并发 `rebuiltSessionNotice("pi")`
     的 runtime.notice；`sessionFile` 必须换成新文件，不得留下被拒的旧游标；
  3. 重开也失败 → 回合失败：startupRecovery 时 `TurnNotStartedError`
     （harness 重放），否则 `runtime.error` + `settle(false)`。绝不跑空白会话。
- `new_session`（非 resume 回合）失败仍保留原有宽松：`--no-session` 裸跑。
- capabilities 加 `strictResume: true`。注意这只打开 delta-context 的
  unseen/handed 记分路径；房间 live-session 交接还需要 `ROOM_SESSION_ENGINES`
  + `hooks`，不在本次范围。

### effort notice

- `set_thinking_level` 失败且回合仍活 → `runtime.notice` 新键
  `chat.notice.piEffortUnsupported`（en + zh；其余语言回退英文，
  `--check` 不要求完整翻译）。

## 验证

- `pnpm exec vitest run server/drivers/pi.test.ts`（新增：带图 steer 落线、
  switch 失败→rebuilt+`rebuilt:true`+recoveryText、两者皆败→回合失败、
  thinking 拒绝→notice）
- `pnpm exec oxlint --deny-warnings`（改动文件）+ `pnpm typecheck`
- `pnpm i18n:check`（动了 locales）

## 不做

modelVariants / edits / custom / hooks / cacheKeepWarm / mcpToolsFoundByName /
usage-limits / agents bridge：pi 概念层没有或安全决策，维持现状。
