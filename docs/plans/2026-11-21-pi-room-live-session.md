# pi 房间 live-session：同一成员的 delta 回合

## 目标

让 pi 进入 `ROOM_SESSION_ENGINES`：同一成员回到同一房间时恢复它自己的
原生 session 并只补没见过的行（delta-resume），而不是每回合重放整个房间窗口。

## 门禁盘点（roomSessions.dispatch 放行 delta 需要）

| 条件 | pi 现状 |
| --- | --- |
| driverKind ∈ `ROOM_SESSION_ENGINES` | 本次加入（`piAgent: "PI"`，`sessionIdlePolicy("PI")` 已有） |
| `strictResume` | 已有（#16/#29：持久化 session + `switch_session` 严格恢复） |
| 压缩可观测 | 本次新增能力位 `compactionNotice: "native"`：pi 引擎压缩时驱动会发 `context.compacted` |
| `!guestConfined` | 不变 |

`input.hooks` 门禁的本意是"引擎自己压缩时 host 必须知道，否则 delta 账本
不可信"。pi 没有 generic hook 通道，但 `compaction_end` 流事件已经转发成
`context.compacted`——所以门禁改为：`input.hooks || compactionNotice === "native"`，
不把 pi 伪装成 `hooks` 能力。

## 实现

- `server/contracts.ts`：`ProviderAdapterCapabilities` 新增
  `compactionNotice?: "native"`。
- `server/drivers/pi.ts`：adapter 声明 `compactionNotice: "native"`。
- `server/host/room-sessions.ts`：
  - `ROOM_SESSION_ENGINES` 加 `piAgent: "PI"`；
  - `RoomSessionEngine.adapter.capabilities` 加 `compactionNotice`；
  - dispatch 门禁改为 `hooks || compactionNotice === "native"`；
  - `onEvent` 处理 `context.compacted`：作废在飞成员的账本
    （`drop` + `flight.distrusted`，事件无 botId，flight 上带着——只有
    在飞成员的引擎能发出这个事件）。
- `server/testing/room-handoff-agent.ts` + `fake-pi-cli.ts`：plan 字段
  `compacts` 在 steps 与回复之间经 `view.onCompact` 发
  `compaction_start`/`compaction_end`（可用 summary）。

## 安全不变量（沿用现有）

- 不确定就发送完整窗口：成员交替（`spokeLast` 门禁）、失败/停止回合、
  `contextFell`（同 session token 下降）、`nearCompaction`（80% 阈值）、
  `context.compacted`、sessionId 变化（`session.started` 不匹配 →
  turn.completed 时 drop）、strict-resume 失败（`recoveryText` 全量重建）——
  全部退回 start/legacy 全窗口。
- 不同成员的 native session 继续隔离：per-room-thread 一个 warm 进程，
  接棒照旧杀旧进程起新进程，本次只优化同一成员连续/回访回合。

## 验证

- 单测 `host/room-sessions.test.ts`：pi（strictResume+compactionNotice、
  无 hooks）走 start→resume delta；`context.compacted` 事件后回 start；
  无 hooks 无 notice 的引擎仍 legacy。
- e2e `room-sessions.e2e.test.ts`（隔离 fixture + fake pi）：
  - 同成员第二回合 = NOTE + 仅新行，复用同一 warm child/session；
  - 成员插队后回来 = 全窗口 + 新 child，再下一回合又回 delta；
  - 失败/停止回合后 = 全窗口；
  - 回合中他人 room post 只出现一次，之后 delta 不再重复；
  - plan `compacts` 回合后 = 全窗口（distrust 链路端到端）。
