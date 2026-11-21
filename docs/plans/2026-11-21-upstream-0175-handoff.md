# upstream 0.1.171→0.1.175 摘取——接手手册

新会话从这里继续。审计定稿（分组/hash/跳取理由全集）在同目录
`2026-11-21-upstream-0175-audit.md`，本文件只讲「怎么续」。

## 环境

- worktree：`lunabot-upstream-175/`（工作区根下，**不要**进 `lunabot/`——那是主线会话的）
- 分支：`chore/upstream-0175-audit`，跟踪 origin 同名分支
- 基线：`origin/main` @ `9968d838ab`（摘取窗口 `release/v0.1.171..upstream/main`，453 提交）
- `node_modules` 是链到 `../lunabot/node_modules` 的符号链接，测试直接用

## 已完成（`origin/main..HEAD` 可见）

- 摘 15：P0 9 + B13 散项 6（详见审计文档「执行状态」两节）
- 跳 14：理由都写在审计文档；B1 pi 会话组 8/8 全跳（fork 架构不等价于上游假设）
- 文档提交：`73a6733f95`、`6da62b8292`（内嵌）、`9c6a272be1`

## 剩余工作（按序）

1. **B2 OpenAICompat 重试/上下文**：`690b3f3560` `1bbad2584f` `d7ab658ec2` `16fca92555` `4c4bfb982e` `4cb246acda`；llama.cpp 五连 `64376f6854` `1db963e01e` `4187ecf340` `fdf2444608` `2c83803820`；`2d65d62050`（merge）
2. **B3 ollama/vps**：`12ee871b5a` `ccec24bff9` `657ded6ea4` `1394b9f515` `6b811ef341` `ae0708b5bd` `3139706af7` `41c442d3f1`
3. **B5 companion e2e**：`fcf0e48f06` `a14ef45411` `d24316e728` `481ccf8617` `1f4c15810c`
4. **B6 协调器/回合**：`1d55de7af9` `6290560a7a` `2cb4157504` `449009bc04` `2d8ef3312e` `27333c3866` `2726ab85f3` `8d8f304e0f` `bb314547f4` `f7442d3a63` `eb38dd69c6` `bc27ecd913`(merge)
5. **B7 房间/权限**：`f5e0e338f5` `dd5c2ad5e7` `6117d842c6` `3167b9fa90` `51d24a81fa` `57eed6cd52` `0df4905165` `b98dc92e6a`+`4c4bf3cce6`(merge)
6. **B8 媒体/steer**：`d7957edb24` `bf5d53af00` `b8a6ba3f61` `4b7a37bb5c` `3508dee100` `c558785d0a` `9b318b21db` `8089f84e36` `3a3137508d` `da25c877a1`
7. **B9 CLI 链**：`3cdceb5df5` `568f19d51e` `427decacd1` `1e37a12276` `ec35541ec8`（与 `87e8c9f6b4`/`9579848775`/`103e953b81` 同链，摘一组即可）
8. **B10 记忆/邮件/账号**：`d734dfb857` `827ba816aa` `d6da38d176` `78dc0d23d5` `65c904c8ba` `72b6fa4d43` `ea46e8497f` `82e8e56f60` `a468ff2b30` `65f33fccb3`（疑似 fork 已有 base32 校验，先核对）`3c7cb48980`
9. **B11 桌面/electron**：`630712556a` `9dc2ee4f0c`(merge)/`f126f8a4d5`+`1d4a88693d` `1d68f09bf8`(merge) `0af84856e0` `360a38f675` `c693badfec` `e1e7a171f0`
10. **B12 src UI**：全部——**先核对 `lunabot/` 主线未推送的 12 个 Muse/Android 打磨提交**，UI 面重叠最可能冲突，逐一判断保留 fork 语义的哪一侧
11. **B13 剩**：quiet-status 四连+merge（`02f35ac556` `eddc9381d2` `88bc088a59` `9591a02a12` `8710007447`）；手术项 `0792adcc71`（只摘 data-dir 守护+stall 判定，与已有 idle cap 实现核对）、`caa36ce5f9`（只取 `deploy/update.sh` Podman 竞态段）；fixture `ebb9089c6e` `06e0436d5f` `c3585618c4` `3ef3c9b3e2` `a4c067b1a3` `a47806be76` `59f79c92a6`
12. **index.ts 撞点专项**：`b806f7f731`（自动恢复备份计数）、`fe171fbea2`（liveBotFor 传声线）、`e0eab4bd37`（connected-apps 版本检查——`server/composio-files.ts` 不存在，先找 fork 等价文件再定摘/跳）。index.ts 是棘轮钉住文件（`scripts/testing/file-size-ratchet`），行数涨了要重算钉
13. **B4 procs macOS 组**（`c693d4c33e` `c28277c06a` `5e5ae9e305` `d4f404fc90`）：依赖上游 `psProcesses` 基座（`git log -S psProcesses upstream/main` 找引入提交），先摘基座再评，或直接判跳并记录
14. **P2 ~30**：逐项评审（Grok 迁移六连、ElevenLabs Live 三连、空白聊天二连、快照尾部、启动性能三连等，清单在审计文档末节）

## 操作规则（本批踩过的坑）

- **merge 提交**：`git rev-list --parents -n1 <h>` 输出含两个父→`git cherry-pick -m 1 -x <h>`，普通提交 `-x` 即可
- **冲突判定顺序**：先看冲突文件在 fork 是否存在（DU = fork 已删该模块，整提交多半判跳）→ 再看 fork 同位置语义是否更严/刻意不同（保留 fork 侧，只摘增量）→ 拿不准判「评估」记入文档
- **摘进来引用悬空**：上游依赖早期重构（如 `outsideDepartmentReason`）——把缺失的小函数移植进 fork 同文件，用 `git commit --fixup <pick>` + `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <pick>^` 归位；**不要 `commit --amend`**（HEAD 多半已不是那个提交）
- **验证**：`pnpm exec vitest run <同目录测试>`，收尾 `pnpm typecheck`；禁止 `pnpm test`/e2e/package（T2 前红线）；动了 locales 加 `pnpm i18n:check`
- **提交纪律**：每组摘完即 push（pre-push lint 会跑）；离开 worktree 前必须 commit+push
- **台账**：进展写回工作区根 `AGENTS.md` §5 对应行 + 本文档末节追加执行状态

## 收尾

全部摘完后：`pnpm typecheck` + 受影响模块测试 → 更新审计文档最终状态 → 台账标「待 T2」→ 报告用户开 PR（T2 全量门禁在合并前跑）。
