# Plan: pi 原生空闲摘要（cacheKeepWarm.compact）

## Why

`warm-summary-host` 的 `native` 路径目前全引擎休眠：`adapter.cacheKeepWarm`
没有任何驱动实现，`nativeCompactTokens` 是返回 undefined 的桩——所有引擎的
空闲会话都只走 harness 文本折叠兜底。pi 是主力引擎，协议侧 `clone`（按叶
entry 分支出新 session 文件并把 child 切上去）+ `compact`（就地压缩，
返回带 usage 的 `CompactionResult`）+ `get_state`/`switch_session` 链路
齐全，可以成为第一个真实实现者。

## Decisions

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 在哪跑 compact | 复用该 thread 的 warm child | child 空闲、已在会话上；fork 后 child 天然落在新文件上，下一回合直接复用 |
| fork 语义 | `clone`（fork position:"at" 当前叶） | 原会话文件不动：compact 期间有 turn 进来时旧文件仍可安全续接，与契约「on success 才换游标」一致 |
| 失败/中断兜底 | clone 后 get_state 拿到 fork 文件即刻更新 `warm.sessionFile`；abort 时若无法确定 child 所在文件则 closeWarmSession | `warm.sessionFile` 必须永远等于 child 真实所在文件，否则下回合会骑错会话 |
| `ping` | 显式拒绝（BYOK：ping 烧的是用户自己的 token，收益为负） | 契约类型要求成员存在；keep-warm 调度器本就按 `billing !== "subscription"` 提前拒绝 pi，该方法不会被调用 |
| `hold` | 调 warm child 的 idleTimer（null=回到普通 TTL） | presence 挂起期间保住 warm 复用，无额外成本 |
| `nativeCompactAt` | pi：`contextWindow - 16384`（pi 的 auto-compaction 触发线，`compaction.js:176`） | 桩函数按 driverKind 分支，pi 之外的引擎行为不变 |
| 会话持久化 | 去掉 `--no-session`，文件落 `PI_CODING_AGENT_DIR/sessions/` | 真机验收发现 persist=false 时 `sessionFile` 恒 undefined——resumeCursor/switch/clone 全是死代码；实例 agent dir 本就与操作员 `~/.pi` 隔离 |
| `sessionFile` 获取 | openSession 后补 `get_state` | 真 pi 的 `new_session`/`switch_session` 响应只有 `{cancelled}`，文件路径只在 `get_state` 里回（fake 已对齐此协议形状） |
| `contextTokens` 上报 | `turn_end` 发 `thread.token-usage.updated`（`input+cacheRead+cacheWrite`） | 真机实测 usage 三段齐全；不上报则 native plan 永远拿不到 contextTokens |

## 真机验收记录（pi 1.5.2，`--mode rpc`）

- `get_state.sessionFile` 返回 `~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl` 真实路径
- `clone` → child 切到真 fork 文件（get_state 前后路径不同）
- `compact` 小会话拒绝 `"Nothing to compact (session too small)"` → 映射 `ok:false`
- 单 prompt 会话 `input+cacheRead ≈ 13.4k`（pi 系统提示常驻），远低于 55.8k 触发线——不会误触发

## Steps

1. `server/drivers/pi.ts`：adapter 增加 `cacheKeepWarm { ping, hold, compact }`。
   - `compact`：校验 `session`（options.session 或 warm.sessionFile）；
     不一致先 `switch_session`；`clone` → `get_state`（取 fork 文件，更新
     `warm.sessionFile`）→ `compact {customInstructions}` → 返回
     `IdleCompactResult`（usage 从 `CompactionResult.usage` 映射）。
   - 并发护栏：`active.has(threadId)` 或 `warm.compacting` → `{busy:true}`；
     compact 期间暂停 idleTimer；`sendTurn` 复用检查跳过 `warm.compacting`。
   - compact 期间的 `extension_ui_request` 一律回 `cancelled`。
2. `server/index.ts`：`nativeCompactTokens` 对 `driverKind === "piAgent"`
   返回 `contextWindowFor(instance.models.default, instance.models) - 16384`。
3. `server/testing/fake-pi-cli.ts`：实现 `clone`（分支 `currentSessionFile`
   为 `*.fork<N>.json`）与 `compact`（发 compaction_start/end + 带 usage 的
   response）。
4. 测试（`server/drivers/pi.test.ts`）：turn 停车 warm child → compact 返回
   ok 且 `session !== sessionBefore`、`warm.sessionFile` 已是 fork 文件、
   usage 记账字段存在；`hold` 延长/恢复；`ping` 拒绝；clone 失败→ok:false；
   compact 进行中 turn 到达→busy。
5. `nativeCompactTokens` 单测（就近 warm-summary-host.test.ts 或新用例）。

## Risks / Notes

- `session === sessionBefore` 的守卫在 host 侧：compact 返回的 `session`
  是 fork 文件，永远不等于入参，语义自洽。
- fork 产生 `session_start` → 扩展 intersect() 重写 scope receipt——同一
  contract 下内容一致，不改变 scope 语义。
- fork 文件 prompt-split receipt 不存在 → 下回合重锚一次系统提示（一次
  性成本，语义正确）。
- 不做 `ping`（BYOK 成本）、不碰 `edits/custom` 审批等协议层缺口。
