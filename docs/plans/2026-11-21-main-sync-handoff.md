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

## 执行步骤（在 `lunabot/` 做）

1. **开工三查**：`git status`（脏文件是否还在）、`git log --oneline -3`、
   台账 §5。若 Muse 会话已把脏文件提交进本地 main——不影响本流程，
   merge 会再带一层，见第 3 步备注。
2. `git fetch origin`，确认 `git merge-base --is-ancestor main
   chore/main-merge-sync`（本地 tip 是合并第二父 → FF 成立）。
3. `git merge chore/main-merge-sync`：
   - 正常 = fast-forward 到 `aef4f0bf2e`，零冲突零新提交。
   - 若本地 main 又前进了：变普通 merge，预计无冲突（新提交在旧 tip
     之上），照常提交 merge commit。
   - 若工作区有未提交修改挡住 checkout：等 Muse 会话先提交，勿动它的
     文件（红线）。
4. **T2 门禁**：`pnpm test` 全量。判据——
   - 失败清单与已知基线红对比（avatar 3 败 + 此前记录的基线），
     **本合并不应引入新红**。有新红先查两侧谁引入，不该是合并语义。
5. `git push origin main`（远端 tip `f3b51bafbb` 是合并祖先 → FF）。
6. **收尾**：`git worktree remove ../lunabot-main-sync` →
   `git branch -d chore/main-merge-sync` + `git push origin --delete
   chore/main-merge-sync` → 台账 §5 本行标关闭、main 行更新。

## 边界

- `lunabot-grok-move/`（`feat/grok-connector-link`）在飞，勿动。
- `mausbot-cn-design/` 不动。
- 禁止 force-push；FF 不成立（远端又进新 PR）时 = 再 merge 一次
  origin/main 即可，预期仍干净。
- 本文件随合并进入 main，落位后可留档（记录语义与验证判据）。
