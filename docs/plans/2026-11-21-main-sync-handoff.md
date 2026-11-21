# main 分叉收口接手手册（2026-11-21）

## 任务一句话

`lunabot/` 的本地 main 与远端分叉（23 本地 / 179 远端）。合并已在独立
worktree 做完并验证，本手册只负责把结果落到 main + 过 T2 + 推送。

## 已就绪的合并结果

分支 `chore/main-merge-sync`（worktree `lunabot-main-sync/`，已推送，
tip `aef4f0bf2e`）：

- `edeba36a65` merge 提交：本地 main（Muse/Android 23 提交）合入远端
  main（含 #31 审计线 + #32 blank-chat）。**仅 2 个真冲突**，已解：
  - `src/state/store.tsx`：配置键 union 取**并集**——本地 `newBots` /
    `cloudStarter` / `waitingForRoom` / `planTurns` / `botLimit` +
    远端 `seedance` 全保留。
  - `src/components/settings/rows.ts`：取远端 `backups` 分档语义，
    `noticeLearn` 保留并与 `phoneVerify` 同组归 `backups`。
- `aef4f0bf2e` 棘轮钉更新（如实增长）：index.ts 16088、store.tsx 3384、
  agents-call/catalog 各 1096、store.ts 2277、RoutineCalendarPage 1623。

已验证：`pnpm typecheck` 绿、棘轮测试绿。BotSettingsDialog avatar 3 败
是本地 main 侧基线红（Muse 会话 avatar 在制品，**勿顺手修**）。

## 执行步骤（PR 路线，全量在 CI 跑）

已拍板（2026-11-22）：不走本地 T2，PR 的 CI 分片即全量门禁。

1. `gh pr create --base main --head chore/main-merge-sync`——diff 即
   本地 23 提交 + 2 处冲突解 + 棘轮钉，写清楚即可。
2. 等 CI：vitest 分片与全量同套件。判据——失败清单与已知基线红
   对比（avatar 3 败是本地 main 侧在制品、及此前记录的环境/基线），
   **不应出现合并引入的新红**；有新红先查两侧归属。
3. GitHub merge → 远端 main 进合并 commit。
4. `lunabot/` 里 `git pull`：本地 tip 是合并祖先 → **FF 落位**。
   - 若 Muse 会话又前进了：变普通 merge，预计无冲突，照常提交。
   - 若工作区未提交修改挡住 checkout：等它先提交，勿动（红线）。
5. **收尾**：`git worktree remove ../lunabot-main-sync` →
   `git branch -d chore/main-merge-sync`（远程随 PR 合并删/手动删）
   → 台账 §5 本行标关闭、main 行更新。

附注：`feat/grok-connector-link`（worktree `lunabot-grok-move/`）
同策略——开 PR 让 CI 当 T2，不占本机。

## 边界

- `lunabot-grok-move/`（`feat/grok-connector-link`）在飞，勿动。
- `mausbot-cn-design/` 不动。
- 禁止 force-push；FF 不成立（远端又进新 PR）时 = 再 merge 一次
  origin/main 即可，预期仍干净。
- 本文件随合并进入 main，落位后可留档（记录语义与验证判据）。
