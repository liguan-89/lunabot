# Android 写操作反馈与延迟修复

## 背景（真机实测证据）

2026-11-27 一加真机巡检（report: /tmp/lunabot-device-audit/report.md）发现：
所有控制类写操作统一 15–20 秒才生效且全程零反馈——话题重命名、例程暂停/恢复、
团队记忆增删、通知办结。用户体感是"功能坏死"，实际请求最终都成功。

## 根因分析

1. **mutation 后 `refresh()` 拆流重建**（架构级）：`Session.renameTask/pinTask/
   archiveTask/snoozeTask` 在 RPC 成功后调用 `refresh()`，其实现是
   `streamJob.cancel()` + 重建整条 E2E 流 + `withTimeoutOrNull(10s)` 死等
   connecting 结束。这一件事就贡献 10 秒以上的延迟，且反复拆建隧道会导致
   在飞请求（图片上传等）死半截、隧道质量退化。
   注释自承 "The PATCH's bot frame also lands on the stream"——流本来就会把
   变更推过来，拆流重建既无必要又有害。
2. **无乐观更新**：rename/pin/snooze 的 RPC 返回 void（sendUnit），调用方
   拿不到更新后对象，于是用了 refresh 这个重锤。但目标值（新标题、置顶态、
   延后时间）调用方本来就知道，根本不需要服务端回推。
3. **UI 等流推送才变**：例程暂停/恢复、记忆、办结没有乐观更新，列表项等
   frame 推送才变化，延迟被进一步放大。

## 修复方案

### A. 移除 mutation 后 refresh()，改为本地真值应用

- rename/pin/archive/snooze：RPC 成功后直接用**调用方已知的目标值**更新
  state 中对应 task 字段（无需服务端返回完整对象）。流推送到达后自然覆盖，
  最终一致性不变。
- 失败路径不变：mutateTask 的 `_actionError` 已就位。
- refresh() 本身保留给真正需要全量刷新的场景（如下拉刷新），但 mutation
  路径一律不再调用。

### B. 写操作乐观更新统一层

- 例程暂停/恢复：点击后立即在列表中切换"已暂停"标记，RPC 失败回滚+报错。
- 通知办结：点击后乐观移除条目（read 已有同样模式，对齐）。
- 团队记忆增删：提交后乐观插入/移除条目，失败回滚+报错。
- 话题重命名对话框：RPC 在飞期间保持 saving 态（已有），成功后立即关闭——
  A 修复后延迟从 15-20s 降到 RPC 单程（预期 1-3s）。

### C. 明确不做

- 不改二进制上传/隧道传输层（独立问题，另开工单）。
- 不改服务端推送时机（先验证 Android 侧修复后的实际延迟，若 RPC 单程本身
  就慢再查服务端）。

## 验证

- T0：Session 层单测（mock client 验证不再调 refresh、乐观更新正确应用）
- T1：typecheck + android 模块测试
- 真机复测：重命名/暂停/记忆/办结延迟从 15-20s 降到 3s 内，且操作后立即
  有可见反馈。

## 源码调查追加（2026-11-27 深夜）

服务端写路径全部为同步直返，无队列/确认等待机制——15-20s 延迟不是服务端制造。
新发现传输层放大器：**每个 authenticated 请求实际是串行两次 HTTP**——
`Client.perform` 每次先无缓存 GET `/.well-known/dexbot/environment` 再发真正
请求（Client.kt:332-340, 1840-1851）。修复 refresh/reload 后若裸 RPC 仍超
5s，下一步候选：environment 预检缓存化、OkHttp host 并发与 20s long poll
的相互作用、yamux 大帧队头阻塞。
