# upstream 0.1.175 → 0.1.177 摘取审计（第三轮）

- 窗口：`upstream/release/v0.1.175..upstream/main`（v0.1.176 + v0.1.177 + 其上 1 提交），**394** 提交（merge 壳 144 + 内容 **250**）
- 方法：3 段标题初审（各 ~83 条）→ 主会话对全部 P0/P1 候选 `git show --stat` 复核 + fork HEAD 落点存在性核查 + 等价实现 grep 对拍；8 处关键 P0/P1 由主会话抽查原文确认（redact 正则、backup 排除正则、broker-env、routines paused、call-consent、browser 15s、main.mjs 1636、connector-proxy 空表——全部属实）
- 结果：**P0 3 / P1 20 组（30 hash）/ P2 评审 46 / 跳 171**

## 关键 fork 事实（本轮修正与新增）

- **`src/lib/relay-server.ts`、`src/lib/e2e/` 在 fork HEAD 不存在**——它们是上游 #5665「Phone web app」（浏览器侧 E2E 栈，本窗口 12+ 提交）的落点。fork 真在用的手机中继栈是 `companion/src/e2e/`（自研早期实现）+ `server/phone-relay.ts` + `server/routes/upgrades.ts`。本窗口所有 relay-server/e2e/websocket 修复一概跳。
- **`companion/src/e2e/yamux.ts` 与上游 main 逐字节一致**，且已含 `data_after_fin`/二次 FIN 防御（L316/325）——上游 yamux 三连修（3d885ba0d6/1417cd55ae/e4ae1ecf5d）fork 无需移植；上游对 `companion/interop-server.ts` 仅测试 helper +11 行。
- fork `server/phone-relay.ts:336-338` 已带 upgrades 通道（另有 directUpgrade+intercept 扩展，`companion/test/live-relay-upgrade.test.ts` 在）——`1094b18ae0`「手机 WS upgrade 过 phone relay」**已修，跳**。
- 其余沿用 0175 审计：驱动只剩 Pi+OpenAICompat；acp/ 仅 quiet-status+version-probe（grok/antigravity/claude 等 9 提交跳）；`packages/phone-protocol`、composio-storage/connector-files/plan-usage 不存在；浏览器私有显示栈（display/desktop pane/browser-pane-*）fork 无；handoff/announcements/card-chips/sending-sessions/server/perf/dispatch-claims/app-settings/login-fill(fork 无 hasUsername) 均无落点；pi 深改区（strictResume/cacheKeepWarm/compactionNotice）无上游 pi 提交交叠。
- `57eed6cd52`（own-threads 修复版）**fork 已逐字节含修复**，跳。

## P0（3，全摘）

| 提交 | 内容 | 落点 |
| --- | --- | --- |
| `60ba1c0df9` | **redaction 平方级回溯**：JWT 模式 `\beyJ…\b` 与 PEM 块从词边界扫到长串尾，400KB base64url ≈10s、MB 级分钟级，跑在服务器主线程上；修复=JWT/PEM 线性扫描（`jwtSpans`/`maskPemBlocks`）+ KEY_VALUE/URL_USERINFO 限定 name(128)/scheme(32) 上界。fork `shared/redact.ts:39` 逐字同款无界正则（已抽查）。补丁自包含，附 81 行 fuzz 测试 | `shared/redact.ts` + 测试 |
| `e767621714` | **备份丢 Data 表**：policy 排除 `bots/<id>/data.duckdb(.wal)`，恢复即丢用户 Data 表（fork `workspace-backup-policy.ts` `liveDataEnginePath` 同款排除，已抽查）。修复=data 引擎先 `release()`（WAL 落盘）再按静止文件拷贝 + 快照步骤 + move 入口注明 Data 表不随迁移。fork 无 bursts.db，该子部分不取 | `server/workspace-backup.ts`、`workspace-backup-policy.ts`、`server/data/engine.ts` |
| `ac66ed052c` | **bot-box 第二把 key 明文泄漏**：同 base URL 的第二把 key 命中「已指向 broker 就跳过」分支 → 原始 key 明文留在 box 环境；bearer-only 端点还每回合 401。修复=`routed` map 按 base URL 共享 grant 重写 | `server/bot-box/broker-env.ts` + 测试 |

## P1（20 组，按主题；手术式摘取，fork 结构差异处就地适配）

### C1 浏览器（seg1）
- `32b6b1ddf0` Chrome 首标签等待 15s→60s（`FIRST_TAB_MS`；fork `server/browser/service.ts:249` 逐字同款，单行）
- `f6f04fede9` 预算近界 "still starting" 即时应答（记 `browser_starting` 不锁存）+ Chrome 先死即报（`opened.exited` 竞速）。fork service.ts 有 callBudgetMs/#withinBudget/opened.exited 同构；input-log 部分跳
### C2 electron（seg1，同批）
- `c4bd86cd5f` 删 home 服务器后本机副本回归：forgetEnvironment 后 `env.kind !== "local"` 时 `ownHome?.kick()`；own-home-main 的 `ended` 不再看 journal（fork 两处病灶签名均在）
- `e8638a639d` 无窗切换永久卡 splash：`navigateMainWindow` 前查 `mainWindow && !isDestroyed()`（fork `electron/main.mjs:1636` 逐字同款）
### C3 通话中文（seg1+seg2 成对，共 4 hash）
- `0dfb1061d2`+`df93aa5c2c` 净效果：`shared/call-consent.ts` 增 `chineseConsent()`（ZH_YES/ZH_NO），CallView/GroupCallView 决策行接第三级中文判定，英文路径逐字节不变；`1aab8027b9` live-call 中文挂断词；`67a2961569` 权限卡中文 yes/no。fork call-consent/live-call 零中文（已抽查）
### C4 connector discovery 兜底（seg1）
- `4d225552f3` 新增 `connector-discovery-fallback.ts`（COMPOSIO_SEARCH_TOOLS/GET_TOOL_SCHEMAS/MULTI_EXECUTE 短 schema）；断电类失败（超时/断连/5xx/429/JSON-RPC 错/坏帧）回退列 service 自带工具，4xx 明确拒绝仍空表。fork `connector-proxy.ts:274-282` 病灶同款；composio 桥名按 fork 清单裁剪
### C5 人的输入到达页面（seg2，大件 ~208 行+2 新文件）
- `e5490f70de` 人接管后下拉/按键/点击真正到页面 + bot 假成功报错。fork browser-live.ts 同源祖先（INPUT_RELAY/DISCRETE_KEYS/HoldClock）；新 `server/browser/live-action.ts`/`live-page.ts` 需等价重做
### C6 人接管期间 bot 只读放行（seg2）
- `e6518ef442` `HOLD_READ_TOOLS`（status/snapshot/screenshot/read/tabs）在 owner hold 期间放行且不抢前台 tab。fork `browser/dispatch.ts:435` 全拒同款（已抽查）
### C7 starter routine 唤醒 paused bot（seg2）
- `da592ee725` 新增 `starter-routine-wake.ts`（112 行），routines 的 paused 检查改经它落 `failRun`。fork `routines.ts:1131` 病灶同款（已抽查）
### C8 备份导出断线恢复（seg2）
- `89d33f8bcc` `exportJobs`/keepUntilExpiry，断连后可续（fork workspace-backup-http.ts 与修复前镜像同构，67 行逐字吻合）；`05088509d9`（P2 跟随）中断备份清理顺带摘
### C9 bot 线程继承审批级别（seg2，需 fork 等价重做）
- `72abd60945` spawn-level resolver。fork own-threads.inherited() 只继承 modelSelection；无 task-record.ts，按 fork store/task 结构重做
### C10 quota 转备份（seg3 两连）
- `f4a439ca02`+`fb01192749` `turnFailed` 加 `settled` promise（settle 屏不算 ran）；`continueOn` 重读 request/model 用 weighBackups 复核；`nothingRan` 移 turn-outcome.ts 排除 compaction/screen。fork 无 dispatch-claims.ts，settled 用 fork 会话 settle 链等价实现
### C11 技能目录 cwd（seg3）
- `c69dd50ca5` `claudeUserSkillsDir` 加 cwd，项目同名技能遮蔽人级。fork 签名 `(dataDir, home)`
### C12 MCP 工具授权跨会话/引擎（seg3 两连）
- `fe586cfbb6`+`8e45588473` 授权键按「配置指纹/内建桥名」重构 + `savedToolGrant(key,…)` bot 级跨会话；computer/phone 工具永不记忆。fork 为旧 isReadOnlyTool 版；BUILTIN_SERVERS 按 fork 裁剪
### C13 reactions 队列撤回（seg3）
- `6f18a37529` queued 投递后撤回被取代的回答
### C14 memory removals 顺序误判（seg3）
- `3a37f663c9` 历史满时 moved removals 保留（fork L167 旧判定）
### C15 附件满盘重试豁免（seg3）
- `5443c19e24` 已占用字节的 committed move 重试不再二次过配额闸（`stored:false` 豁免）
### C16 app-events 轮询泄漏+开关同步（seg3 两连）
- `ac39e88c7a`+`5ca1b7a253` runVersion 守卫 stop/restart；applyEnabled 带目标状态。fork 无 runVersion、applyEnabled 单参
### C17 brief 早日卡 Dismiss（seg3）
- `8a3f85cabc` 服务端登记 earlier 卡
### C18 profile-versions 旧行崩溃（seg3）
- `e1a844a951` `row.via.startsWith` 对无 via 旧行防崩（fork L168 同款）
### C19 surface 借出电脑路由（seg3 两连）
- `bb8f767ea2`+`669d48b8d3` 自托管服务器借出电脑后的 shared_computer 路由与 bots 可达（fork 有全套 lent-computers 配套，无 lentToServer）
### C20 bot-box own-folder uploads（seg3 两连）
- `f8df8699a9`+`27f2ad3a22` box 启动前建 uploads 目录 + `attachmentsForBox` 加 turn 参（fork 旧签名；依赖 uploadsConversation helper 一并取）

## P2（46，评审记录；本轮摘 3 条一行级，余不摘）

摘：`96795bf64a`（templates 上限 100→1000+测试）、`36bd43fcbf`（Ctrl+= 放大菜单加速器）、`ec48552c74`（DST 搜索窗 9→16 天）。
余 43 条评审后不摘：大件/结构缺失（e5330c39c4+7fec804610 Bitwarden provider、720198e5f0 perf 模块、399d6da901 chrome wrapper、f59d495dd6 container probe、eb6469d9c5/bee9395412 dictation feat、e56284502b vm_exec feat、88d16bb40d TTS 流式、afbff51b7c DetailsTab、fd7a062ff8 PinnedSignInSlot、252f97f72a snapshot-tail 映射、687fb73d8f queue-receipts、c2f7b18b8c store 索引、5e2e84eb6d save-batch、ecfc7eb0b3 merge perf、31158c9f41 vps ssh error、7e7a45eaec/3c0b93341a BrowserPanel 两修、57717bea73/00ff350b9a login-fill、5a211dd768 retry-after HTTP-date、31e6870688/c279806439 turn-route vendor、6ff7f8f47e package-export requirements、17cbddc2ae/5f715b116f/50ced2f575/1d661f4415 测试、09c22a0e89/5113658607/1210eeec77/9f50046841 新功能、0da252b066 运维脚本、618682611e composer、d73f26a386 lending refused、4dacbb98ca/575eac7499/893634b411 显示栈、fcfb4edda0 已有等价、6eac5069c7/74aca90e41 Hermes gateway fork 无、88b5b81c05 查询 fork 无、05088509d9 已随 C8）。

## 跳（171）分类

Phone web app 新栈 12+（fork 无 src/lib/e2e）· relay-server/e2e 修 6（同上）· grok/acp 9（驱动已删）· handoff 9 · 显示栈/pane 10 · locales/文案 12 · CI/goldens/train 12 · 棘轮/版本/公告 8 · 新功能默认关 6 · 纯视觉 6 · fork 已修/已有等价 3（1094b18ae0、57eed6cd52、fcfb4edda0）· 落点缺失其余 ~78（mcp-grant-spec/setup-recovered/own-mcp-http/place-inbox copyOf/brief 机制外、usage 自有实现等）

## 执行规则

1. 内容提交直摘；成对/成组的按组摘（双 hash 同补丁取净效果）
2. 每组摘完跑同目录测试；quota/dispatch-claims、spawn-level、live-action 等结构差异处按 fork 等价实现，不硬 cherry-pick
3. 摘取顺序：P0 三连 → C1/C2（小）→ C3/C4 → C7/C11/C13/C14/C15/C16/C17/C18（小 P1 批）→ C8/C12 → C6/C19/C20/C10 → C9 → C5（大件殿后）
