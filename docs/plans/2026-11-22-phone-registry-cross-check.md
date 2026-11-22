# 两份手机登记表：让删除同步过去

日期：2026-11-22
状态：实施中

## 问题

一台手机在电脑上留下**两份**记录，各自回答不同的问题：

| 表 | 位置 | 键 | 回答什么 |
| --- | --- | --- | --- |
| sidecar 设备表 | `~/.lunabot-companion/devices.json` | 随机 UUID | 这台手机的**令牌**（只存 SHA-256），决定它能不能连 |
| harness 手机表 | `~/.lunabot/phones.json` | `companion:<deviceId>` | 这台手机**让机器人用哪些应用**（日历、通知、短信…） |

两份表没有任何同步。实测（2026-11-22）：sidecar 侧 0 条，harness 侧 3 条陈旧记录（最后活跃 11-16、11-20、11-21）。

### 为什么这不只是"看着乱"

1. **能力登记会留给下一位主人。** harness 按 `companion:<deviceId>` 记能力。设备被删后这条记录还在，`/api/phones` 一直列着它；设置里的「手机和设备」把它画成"已配对——近期不活跃"。用户看到的是一台不存在的手机。
2. **通知学习会继续为它留位置。** `host/phones.ts` 按 owner 维护 `NoticeInbox`，只在该 owner 最后一部手机离开时清；一台永远"存在"的幽灵手机让 inbox 和 triage 预算永远不清零。
3. **排查时指向错的方向。** 这就是本次排查绕远路的原因之一：一边空一边有 3 条，到底哪边算数要靠读代码。

## 方案：删除时同步

设备被删时，sidecar 已经在通知 harness —— `companion/src/harness-notice.ts` 的 `notifyDeviceRevoked()` 打 `POST /api/live/device-revoked`，让那台手机持有的 Live 通话结束。**同一个请求里把能力登记也删掉**，因为它们问的是同一件事："这台手机还在吗？"

改动：

- `server/routes/live.ts`：`LiveRouteDeps` 加 `phoneRevoked?(deviceId: string): void`，在 `device-revoked` 处理里调用。
- `server/index.ts`：接上 `phonesHost`，按 `companion:<deviceId>` 删掉 harness 侧记录（复用 `routes/phones.ts` 已有的 `removePhone`）。
- 不新增路由，不新增请求：sidecar 已经在这一刻打这个电话。

### 为什么不做双向对账

反向（harness 有、sidecar 无 → 删 harness）需要 harness 主动问 sidecar，而 sidecar 可能没起、可能睡下，判"没有"会误删。**单向删除是安全的**：sidecar 是令牌的持有者，它说"这台手机没了"就是没了。

也不做"定期扫描漂移"：那要处理"sidecar 没起时怎么办"，收益低于复杂度。这次的 3 条陈旧记录，正是历史上删除没同步留下的；修好之后不再产生，存量可以手动清一次。

## 验收

- 设备在电脑上被删 → `phones.json` 里 `companion:<deviceId>` 那一条消失。
- 设备只是断开（还在表里）→ 能力登记保留。
- 删一台手机不影响同一 owner 的另一台。
