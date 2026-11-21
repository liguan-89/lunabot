# upstream 0.1.171 → 0.1.175 摘取审计（第二轮）

- 窗口：`upstream/release/v0.1.171..upstream/main`（至 v0.1.175，含其上 1 个提交），共 **453** 个提交
- 方法：3 段标题初审（各 151 条）→ 主会话对 41 个 `?` 项逐一 `git show --stat` 复核 + fork 文件存在性核查 + 同名补丁去重
- 结果：**P0 11 / P1 约 110（含重复 hash 去重后）/ P2 评审 ~30 / 跳 其余**

## 关键 fork 事实（分类依据）

- `server/drivers/builtIn.ts` 只有 `PiDriver` + `OpenAICompatDriver`——claude/codex/gemini/cline/antigravity/vibe/mistral/omp 驱动文件已删，相关提交一概跳
- `server/drivers/acp/` 仅剩 `quiet-status.ts` + `version-probe.ts`（被 live-steps/engine-errors 复用）——acp core/steer/omp 相关跳，quiet-status 修复照摘
- `packages/phone-protocol/` 不存在（上游重构产物）——落在该包的 widget 修复跳，但注意同类 bug 可能存在于我方 `shared/widget.ts`/`server/chat-widgets.ts`（见遗留核查项）
- `shared/composio-storage.ts`、`server/composio-files.ts`、`server/connector-files.ts`、`server/plan-usage.ts`（stub）不存在——落点在这些文件的提交跳
- `relay/` 存在但 Origin 处理已默认拒绝（`server.ts` 有 `relay_refused_total{origin}`），浏览器直连功能组不适用
- fork pi 已扩展：strictResume/cacheKeepWarm/compactionNotice/steerImages/piInstanceEnvs——上游 pi 修复与这些改造有交叠，摘时逐处比对
- fork 模型管理/UI 已 Muse 化——上游纯视觉打磨默认跳，行为修复照摘但需核落点
- **上游 train 流程把同一补丁以两个 hash 进主线**（分支原始提交 + merge 内重放），下表已标注去重关系

## 执行规则

1. 内容提交与 merge 壳并存时摘内容提交、跳 merge；仅 merge 承载内容（外部 PR）时 `cherry-pick -m 1`
2. 上游行数棘轮、版本 bump、上游品牌/基建提交不摘；我方棘轮钉值独立
3. 多内容打包提交（`0792adcc71`、`caa36ce5f9`）手术式拆取适用 hunk
4. 每组摘完跑同目录测试；pi/steer/store 等 fork 深改文件预期冲突

---

## P0（安全/数据损坏/崩溃，第一批摘）

| 提交 | 内容 | 落点 |
| --- | --- | --- |
| `4881327aa1` | 消息文件路由补 `visible.thread()` 检查（1 行） | `server/routes/threads.ts` ✅ 已确认 fork 缺失 |
| `213ccc236c` | 读完文件请求体后重查线程可见性 | `server/message-file.ts` |
| `dd9d8223bc`（merge）≡ `902b09591a` | connector 密钥脱敏恢复（load+output 边界） | `connector/src/*`，摘内容提交 |
| `be41a9ae65` | safety-floor：Clear-Disk 破折号变体逃逸 | `server/safety-floor.ts` |
| `bfc4c09a4d` | safety-floor：`%HOMEDRIVE%%HOMEPATH%` 漏检 | 同上 |
| `667b1d82f1` | safety-floor：拦 `Format-Volume`/`Clear-Disk -RemoveData` | 同上（三条同文件一次摘） |
| `ce304be157` | pi 丢游标时新会话拿不到已重建对话 | `server/drivers/pi.ts` |
| `6cec8c6ef9` | bot 保存只序列化具名 bot，safety 变更必随保存落盘 | server bot 保存路径 |
| `bbbb73f447` | routine 空 item 擦掉已交付报告 | `server/routines.ts`（随带 `30b5707134` import 清理） |
| `e0293d60a1` | routine run 撞上限丢 code+已交付 report | 同上 |
| `779ac78e95` | 翻译页面 MCP 列表加载完即崩 | src MCP 面板 |

## P1 摘取组（按主题分批，组内已去重）

### B1 pi 会话/驱动
`31ddcdc23f`（未落盘会话文件续 resume）、`97b3301938`（外来/失效游标开新会话）、`26edd8dc12`（按 audience+会话隔离持久化 pi session）、`66de394c0e` ≡ `b0592e56bf`（pi shell 超时上限，摘一）、`b35b91f93c`（bot box 内 pi session 文件可见）、`e3bbc68914` ≡ `87122ade0d` ≡ `3b9c7b9a4e` + `207fdc5be6`（turn MCP 目录进 box 读写清单，摘一组）

### B2 OpenAICompat 重试/上下文
`690b3f3560` `1bbad2584f` `d7ab658ec2` `16fca92555` `4c4bfb982e` `4cb246acda`（状态分类+transient 重试六连，≡ merge `1d1fd35cd9`）；llama.cpp 五连 `64376f6854` `1db963e01e` `4187ecf340` `fdf2444608` `2c83803820`（上下文溢出丢最旧工具输出+缩小重发+重试封顶）；`2d65d62050`（merge，Venice base-url 检查 ≡ `6e63cd4b6c`/`78af509067` 同源，取一）

### B3 引擎探测/ollama/vps
`12ee871b5a` `ccec24bff9`（ollama 重载 ≡ merge `89a2442aa4`）；`657ded6ea4` `1394b9f515` `6b811ef341` `ae0708b5bd` `3139706af7`（VPS 别名/不可达判定 ≡ merge `469c3f48e4`/`dc9b880da7`）；`41c442d3f1` ≡ `bb3d1481de`（设置页 VPS 选择，摘一）

### B4 procs 进程清理（macOS）
`c693d4c33e`（每轮一次 ps+不记 lstart）、`c28277c06a`（C locale 解析+zombie 计停止）、`5e5ae9e305`（逃逸进程组后代+execCli 超时）、`d4f404fc90`（merge，kill-tree，分支名误导）

### B5 companion e2e 会话
`fcf0e48f06` `a14ef45411` `d24316e728`（pinned key/PSK 长度、caller 输入拷贝、payload1/消息2/记录读取规范）；`481ccf8617` + `1f4c15810c`（socket CLOSING 期应答 drain 等待+测试）

### B6 协调器/回合语义
拒绝归因四连 `1d55de7af9` `6290560a7a` `2cb4157504` `449009bc04`（≡ merge `a41cc082b5`）；NEEDS INPUT 组 `2d8ef3312e` `27333c3866` `2726ab85f3` `8d8f304e0f`；`bb314547f4`（compact 摘要不复活已结束回合）、`f7442d3a63`（拒绝回合还原回绕标记）、`eb38dd69c6`（summarizing 行各出口清除）、`bc27ecd913`（merge，打断进行中工具调用）

### B7 房间/权限
`f5e0e338f5`（接管在 stall 判定之后建）、`dd5c2ad5e7`（到上限成员用自身 backup）、`6117d842c6`（已确认 model hold 不再重堵）、`3167b9fa90`（idle 计时器不杀繁忙/held 引擎）、`51d24a81fa`（成员流式时行不动）；`57eed6cd52`（新线程用自身层级非待批 Ask）、`0df4905165`（Ask 卡送达已开聊天）、`b98dc92e6a` + `4c4bf3cce6`（merge，新 bot 按保存的审批级别）

### B8 媒体/附件/steer
`d7957edb24` ≡ `5f2616d87d`（媒体预算计全 dataURL/fallback 帧/重放图）、`bf5d53af00`（native clip 进预算+不可读跳过）；图片引用 `b8a6ba3f61` ≡ `91fa19d7ad` + `4b7a37bb5c` + `3508dee100` + `c558785d0a`；steer 通知 `9b318b21db` `8089f84e36` + `3a3137508d` `da25c877a1`

### B9 CLI/导出
`3cdceb5df5` `568f19d51e` `427decacd1` `1e37a12276` `ec35541ec8` ≡ `87e8c9f6b4` `9579848775` `103e953b81`（同一 CLI 修复链两个 hash 系列，摘一组）

### B10 记忆/邮件/账号
`d734dfb857` `827ba816aa` `d6da38d176` ≡ `1972eea226` `936f3b3b15`（CRLF/遗忘细节）；`78dc0d23d5`（upkeep 超时下传）、`65c904c8ba`（dream 超时）；`72b6fa4d43` ≡ `f2ded07eb7`（地址组收件人）；`ea46e8497f`（SMTP 重发竞态）、`82e8e56f60`（重发码不被旧失败覆盖）；`a468ff2b30`（TOTP 校验不覆盖已存密钥）；`65f33fccb3`（Base32 组完整性——chunk1 核查称 fork 已有 base32 校验，摘前确认是否同病，疑似可跳）；`3c7cb48980`（失效云签名不锁死+配对不循环）

### B11 桌面/electron
`630712556a` ≡ `177248f6b3`（Wayland KDE 色彩）；macOS 13 组 `9dc2ee4f0c`（merge）≡ `f126f8a4d5` + `1d4a88693d`；`1d68f09bf8`（merge，Windows 安装目录）；`0af84856e0`（CUA Driver 用 System32 tar）；`360a38f675`（Linux 按 PATH 找 Chrome）；`c693badfec`（profile owner 随 pid 更换关闭）；`e1e7a171f0`（browser reset）

### B12 src UI（Muse 冲突面逐一核对）
`e6ca737553` ≡ `a79d2b07d2`（rail 着当前主题）；`8e43405003` ≡ `f466174d9c`（主线程留折叠列表）；`2fd0238de6` ≡ `9431348e22`（connected apps 命名）；`c517e27cd4` ≡ `0b2ae6d153`（IME 下划线）；词数/RTL `3471bd8819` `56840a5f68` `3187f132d9`；transcript `f7b4ff1450` `e5b9ae8f9b`；`d3f2397dcd`（config frames 保 place 字段+止无关重绘）；设置账号行 `1a6a624187` `4cc80937fe` `fd7ee6c27a`；`3b8b294f94`（跟随会话即时跟默认模型变更）；`17720726c6`（面板显示当前会话模型）；sidebar `7bc6c7f82d` `3b3089b0dc` + `d1abf55bc1`；`1a14202378`（已存语音语言在选择器可见）；`00c436dae2`（IME 确认键误存电脑名）；`9dab28531a`（配对卡四处 UX）；`81e3365c79`（MCP 面板错误声明顺序）；`6b998db17b`（新 bot 欢迎语按 app 语言+简中）；`5950b5ca2a` ≡ `03c5260380`（MCP 列表失败只报一次）

### B13 杂项修复
`e0eab4bd37`（connected-apps 服务版本检查）、`0379ca0603` ≡ `ec6dc3e950`（handoff 卡片附件保存）、`b806f7f731`（自动恢复备份计数）、`fe171fbea2`（liveBotFor 传 bot 声线）、`05d169d58f` ≡ `9b42032869`（@devs+CJK 判 bug 报告）、`5e24d3d7a4` ≡ `d20ea5d8cc`（team 已存在提示）、`33a3c12ce4`（digest 孤立 surrogate）、`368f7d2651`（Windows 上 ~/.hermes 标签）、`9c0e7438b5` ≡ `fbad4c490c`（无备用不静默换模型）、`2d9c61fd43`（饼图类目序）、`12935993ac` ≡ `c5422b7788`（weekdays 去重排序）、`2223dfd990` ≡ `568790dc63`（grapheme 截断）；quiet-status 四连+merge `02f35ac556` `eddc9381d2` `88bc088a59` `9591a02a12` `8710007447`；`0792adcc71`（**手术**：摘 data-dir 守护+stall 判定，idle cap/sleep 部分与我方已有实现核对）；`caa36ce5f9`（**手术**：只取 `deploy/update.sh` Podman 竞态段）；测试 fixture `ebb9089c6e` `06e0436d5f` `c3585618c4` `3ef3c9b3e2` `a4c067b1a3` `a47806be76` `59f79c92a6`

## P2（功能/改进，评审后决定）

- Grok Bot 聊天迁移六连 `e1f8795f89` `f8c36b5f82` `7b2d466d37` `2dc34e8e0e` `e8bff37e52` `2f18599d84`（fork 已有 grok 导入，此为聊天记录扩展）
- ElevenLabs Live：`79ac30c3bc`（bot 各自声线通话，新 provider）+ `7315b2f124`（其上的 prompt/凭据修复）+ `64302dad1e`（Scribe 听写+语言选择）——整组评审
- 空白聊天二连 `21ed317d41` + `afbff51b7c`（首条发送才建会话、面板行设空白选项）——与 fork 会话/模型流程交互风险
- 快照尾部 `fd8781a731`（首帧发屏外会话尾部+后台有界）
- 启动性能 `2dedbf5ffd`（启动包拆分）`b5588a013c`（launch 记录+早 45ms）`684eff585b`（splash 期读 keys/代理）
- Apps 性能 `464175e297` `ecabd15caa`；设置/服务器性能 `c4521f86f4` `9f7f7b1f3c` `7b7c5afc5a` `9b5fe33446`
- 侧边栏 `a90bf36551` `2e836a99be`（pinned 页归属+视觉）；`45c8efcd69`（team map 去闪烁）
- composer `4fbed9499a` `c8ced85bba`；吉祥物动画 `336b1d8d2c`（与 Muse 头像线重叠需协调）
- `b385217306`（model_catalog_json 发服务端字段，新 wire）
- `594adf83d7`（bot-api Retry 重跑调用方行）
- `94837949be`（宽屏附件傍会话）；`5bb3158cda` + `683f7590f5`（无 Chrome 引导+pt-BR）
- `b453044f36`（Hermes/OpenClaw 导入源扩展）；`0dab702856`（同名另一提交，核对是否同一）
- `84c328bd15` + `29c76c7c82`（rpm 发布，需 fork 发布链路对齐）
- `71ada2b579`（broker 目录页缓存+Session 复用——fork 自建 broker 直接受益）
- `9d06188c1c`（limit backup 跳过原因进日志）、`2359c38a09`（面板会话列表主线程星）、`adf4fd0ebc`（长会话摘要进度行）、`a5760dbedc`（Apps 错误态+pt-BR）、`1ba84ae67c`（antigravity 用量菜单——fork 无该引擎，倾向跳）、`237f3cbc10` ≡ `298bbc1c83`（automation 文案，小）

### 按上游思路的 fork 等价移植（用户拍板后追加）

- **rpm 打包**（`09b875dcc2`，= `84c328bd15`+`29c76c7c82`）：electron-builder rpm target+`fpm` 块（`/opt/LunaBot`、`_build_id_links none`）、after-remove 的 `%postun` 计数语义、verify 脚本 `verifySystemPackage` 对 DEB/RPM 同套检查、ci/package-linux/release 工作流产物清单、docs Fedora 节。fork 无 `sync-published-release.yml`，跳过。rpm 包名沿用 `dexbot`（与 deb Package 一致）。
- **boot-head-start**（`e71cc31666`，= `684eff585b` electron 半）：splash 就绪前并行预读 `secureCredentials`。上游的 proxy 项依赖其 system-proxy 缓存（fork 无），launch-record/`server/perf` 诊断链、launch-timings、`b5588a013c` 整提交（含约 10 个不相关 perf bullet）依赖上游 perf 基建——均未移。
- **快照尾部服务端**（`951e1f5dde`，= `fd8781a731` 服务端半）：`server/host/snapshot-tail.ts`+`threads.ts` 的 `tail`/`open` 参数，向后兼容。**欠账**：客户端有界裁剪（上游 `held-tails.ts`/`chat-snapshot.ts`/`message-history.ts` 改造、`use-transcript-viewport` reopen 逻辑）——fork `src/state/` 存在但消息历史结构不同，需专项移植。
- **空白聊天（`21ed317d41`+`afbff51b7c`）判为专项欠账**：试摘确认接线依赖 fork 缺失的 `fork-panel`（`removeForkOptimistic`）、`useBotListDrawer` 与发送管线改造，~450 行/13 文件；新模块 `src/state/new-chat.ts` 本身自足可复用，但需一次专门移植会话完成接线，不宜半途。

### P2 执行状态（评审完毕）

**第二批落地：**

- **摘** `9b5fe33446`（`67a1f160d1`）：usage-ledger 月账本解析缓存——fork `server/usage-ledger.ts` 同构适用，干净落。merge 壳 `7b7c5afc5a` 同内容，记 skip。

**评审判跳（含理由）：**

- ElevenLabs Live 三连 `79ac30c3bc` `7315b2f124` `64302dad1e`：`server/live-elevenlabs.ts`、`src/lib/live-call-elevenlabs.ts`、`server/tts/hearing-config.ts` 俱不存在，通话管线整体不在 fork。
- 空白聊天 `21ed317d41`+`afbff51b7c`：行为级功能（首条发送才建会话），落点在 fork 已分叉的 App/Sidebar/DetailsTab 结构，非修复。
- `fd8781a731` 快照尾部：主体落在 `src/state/`（store 拆分架构）与 `packages/phone-protocol`，两者 fork 俱无；fork 是单文件 `src/store.tsx`。
- `adf4fd0ebc` 摘要进度行：依赖 `context.summarizing` 事件+`deps.summarizing` 管线，B13 已确认该链在 fork 整条不存在。
- `1ba84ae67c` antigravity 用量菜单：引擎已删。
- `b385217306` model_catalog_json：落点 `server/drivers/codex-catalog.ts` 已删（遗留核查项 5 定案：与 pi-model-catalog 无关）。
- Hermes/OpenClaw `b453044f36`+`0dab702856`（同一内容）：fork `server/setup-import.ts` 无 Hermes/OpenClaw 导入源。
- rpm 发布 `84c328bd15`+`29c76c7c82`：上游 release 工作流改动，fork 发布链路不同；如要 Fedora 包需用户拍板后单独立项。
- `2359c38a09` 主会话星标：fork `SidebarThreadRow` 无 `main` prop/星标实现（上游面板 UI 分叉）。
- 启动/Apps/设置性能组 `2dedbf5ffd` `b5588a013c` `684eff585b` `464175e297` `ecabd15caa` `c4521f86f4` `9f7f7b1f3c`：全部落在上游 `src/state/`、`server/perf/`、`composio-catalog`、store-select/AppTile/app-catalog-cache 等 fork 不存在或已跳过的重构链上；`464175e297` 试摘确认 PluginsPanel 上游版整体依赖 AppTile 抽取（fork 版 994 行独立实现），abort。
- `94837949be` 宽屏附件面板：新 UX 功能（FilePreviewPanel 新组件），非修复；fork App.tsx 已分叉，需产品设计判断。
- 侧边栏 `a90bf36551` `2e836a99be`：改上游 Simple 布局 IA；fork 的 Simple 是自己的设计线（SidebarSimpleTop/Rail 等），上游改版不适用。
- composer `4fbed9499a` `c8ced85bba`、吉祥物 `336b1d8d2c`：纯上游视觉/动效改造，Muse UI 已分叉。
- `237f3cbc10` ≡ `298bbc1c83`（已摘后者）。

**遗留核查项终局：** ①widget children-in-object——fork `shared/widget.ts:564` 无上游单键解包约定，非数组 children 一律按单节点走校验（更严格，非 bug）；②R2 白名单——fork broker 无文件上传端点（`files.ts` 不存在），无落点，将来接上传时需同步；③TOTP base32 已更严；④`a468ff2b30` 在 B10 已确认等价；⑤codex-catalog 已删；⑥transcript 两提交已跳（bottom-follow 系）；⑦`fe171fbea2` 已跳（消费链不在）；⑧主线无未推新增。

### P2 第一批（已落地，明细）

- **摘** `298bbc1c83`（`6983f32f30`）：automation 报告——复制的 question 卡随原卡回答/驳回/过期同步结束态，启动时对账。fork 等价实现干净落。
- **摘** `a5760dbedc`（`d730d0b184`）：Apps 列表加载错误只在无存量列表时替换卡片（`loadError && servers === null`）；pt-BR 文案一并落。
- **摘** `5bb3158cda`+`683f7590f5`（`33134b6d3d`+`f34e1c4b76`）：无 Chrome 引导——`runsShellForWantOfChrome()`、`engineSummary` 带 `noChrome?: true`、BrowserSettingsRows 状态行+修复指引、en/pt-BR 键。**上游同提交的 proxy 字段与 proxy 设置 UI 不摘**（fork 无该功能面）。`BrowserSettingsRows.test.ts` 8 过。
- **摘** `9d06188c1c`（`ab55ee4b1c`）：limit backup 跳过原因进日志——`limit-takeover` 增 `BackupSkip`/`SkippedBackup`/`weighBackups()`/`passedOver()`（含 `redactSecretsInText`），`quota-switch` 改走 `weighBackups` 逐个尝试并上报 skipped。**保 fork 自动选默认模型策略与 `serverLine` 本地化；上游 `botsOn` stuck 名单不摘**。quota-switch+limit-takeover+bot-api-host 114 过。
- **摘** `594adf83d7`（`542d76f381`）：bot-api Retry 在调用方行重跑该调用。剥掉同提交带入的 acts-as-owner 特性测试（fork 无该功能）；`store.ts` `branchMessage` Pick 去掉 `apiAsOwner`。
- **摘** `71ada2b579`（`67c9aff36f`）：broker 目录页缓存+Session 复用——fork 自建 broker 直接受益，133 过。
- **摘** `45c8efcd69`（`d97ebc3238`）：team map 开局直出 settled 布局去闪烁——并入 fork `TeamOrgChart` 分支。
- **摘** Grok Bot 聊天迁移五连（`2f18599d84`→`e8bff37e52`→`2dc34e8e0e`→`e1f8795f89`→`f8c36b5f82`→`7b2d466d37`，落 `b444f1fa8e`…`2d01ed39a6`）：`POST /api/setup-import/grok/history`（local-only JSON、`historySchema`、404/400/415）、`GrokMoveDialog` 聊天记录导入 UI、settings 副标题提"聊天记录"、docs 页品牌改 Luna Bot。**connector-link 端点不摘**（依赖上游 `grokMove` 隧道功能，消费链不在 fork）。GrokMoveDialog 17 过；ja/pt-br/zh-tw/zh 译文已补，`source-hashes` 按当前 English 结算。

## 跳（按理由汇总，不再逐条）

- 已删引擎/文件：claude、codex、gemini、cline、antigravity、vibe/mistral、acp core/steer/omp（`6ac013e314` `59ba29c46b` `c571542394` `fc11f691a7` `37d2eb3462` `25b050e328` `baf0898df7` `72b7c93c38` `198b84350b` `17a3f5af39` `25f39b5b9a` `95b425c938` `be1bbce19c` `3ae034e0a9` `4740c6f1e0` `ca1610ec4d` `5cc8586a9f` cline 系列等）
- 落点文件不存在：`packages/phone-protocol/` widget 四修（`980b690d25` `65b8c9c398` `43f2a7ebfe` `03773c0076` `7b5378480b`）、`1d8f3267b5`（composio-files/connector-files）、`b9b00181ca`（ask-socket fixture）、`567bb2088c` ≡ `63bd6356cf`（composio R2，核心落点 `shared/composio-storage.ts` 缺；broker 侧文件在我方 worker 内，**遗留核查项**见下）
- 上游 relay 浏览器功能组：`e3d8f1a683` `426a344728` `8916c5ec0d` `22cd4cc15b` `185a5e8c77` `746a8c9246` `6a9867ec16`（fork relay 默认拒 Origin，浏览器端不存在）
- 已有等价实现：`b9ce0cfbd9` `38ce8b09ba`（pi strictResume/session 持久化我方已做）、`4aba61196a`（piInstanceEnvs）、`96c93df80f`（mcp-oauth clientSecret）、`2324448ea6`（totp base32）、`13a3e8e4a1`（liveVoice 任意声线）
- 版本 bump（0.1.172/173/174/175）、merge 壳/train 同步、上游 CI/测试基建/棘轮/品牌文档、pnpm shots 基建（`cc26a5f903` `148c5b1c38` `ae9125b614` `ecb258a8bf`）、已被 revert 的自我抵消组（#6714 antigravity 代理、#6717 登录卡）、上游回滚/合并内务
- `d14795e325`（codex credits——plan-usage 是 stub 功能不存在）、`4207c13854`（ACP 文案）、`54f9f249c9`（引擎 pin 测试集合不同）
- 纯视觉打磨（Muse UI 已分叉）：`51fc066e95` `613aff9d67` `45c8efcd69` 若判视觉部分等

## 遗留核查项（摘取时顺手确认）

1. `shared/widget.ts`/`server/chat-widgets.ts` 是否有上游 packages 版已修的 children-in-object 解析 bug
2. fork `cloudflare/composio-broker/src/files.ts` 是否有 R2 上传域名白名单需求（上游在 shared/composio-storage.ts 实现）
3. `65f33fccb3` TOTP Base32 组校验——fork `server/totp.ts` 若已覆盖则跳过
4. `a468ff2b30` TOTP 保留已存密钥——确认 fork 校验逻辑是否会覆盖旧密钥
5. `b385217306` model_catalog_json wire 字段与 `pi-model-catalog.ts` 的关系
6. `e5b9ae8f9b`/`f7b4ff1450` transcript 与 Muse UI 改造的落点核对
7. `fe171fbea2` bot 声线——与 elevenlabs feat（P2）决策解耦，可单独摘
8. 主 worktree 本地 main 未推送的 12 个 Android/桌面打磨提交与 B12 组潜在重叠

---

## 执行状态（2026-11-21 首批）

**已摘 9 提交**（`origin/main..HEAD`）：connector 脱敏恢复、线程可见性两修、MCP 列表崩溃、safety-floor 三连、routine 空 item 保留报告（手术取核心）。验证：threads/safety-floor/routines 731 测试过。

**复核后改判跳 6**：
- `e0293d60a1`：依赖 `server/routine-bounds.ts`（fork 已删的 missed-run 模块），bug 本体不存在
- `6cec8c6ef9`：依赖 `registry-store.ts` 窄序列化架构（fork 全量序列化，无此 bug）
- `e3bbc68914`/`3b9c7b9a4e`/`207fdc5be6`：fork pi 重构后 spawn 辅助统一带 `box:{rw:[mcpTempDir]}`，等价实现已在
- `66de394c0e`：fork `98a5d8cb19` 已实现相同 shell 超时边界（常量+tool_call 钩子一致）

**评审完结**：B1-B13、index.ts 撞点专项、B4 基座、P2 全部评完；各组执行状态见对应小节。`66de394c0e` 的 docs/verify 脚本留作参考不摘。

## 执行状态二（2026-11-21 续批，已推 `05e3616195`）

**B1 完结：8/8 全判跳**——pi 会话组四连均不适用：fork 会话文件在 engine home（box 本就 rw）不迁共享 `--session-dir`（`b35b91f93c`）；`26edd8dc12` 的共享目录隔离需求不存在；`97b3301938`/`31ddcdc23f` 的「整会话连挂」在 fork fail-soft rebuilt 兜底下不存在。

**B13 部分摘 5**：`33a3c12ce4`（merge，`digest` 孤立 surrogate）、`2d9c61fd43`（merge，饼图类目序）、`05d169d58f`（@devs+CJK）、`d05000319c`（team 已存在提示——**补移植 peer-roster `outsideDepartmentReason`+`managedDepartmentsHelp`**，上游依赖早期重构）、`05e3616195`（hand-off 卡片附件保存——取上游放宽门槛，**保留 fork `visible.thread` 行**，非 text 卡片仍只能服务显式附件，227 行兜底）；`2223dfd990`→`0202d3a106`（grapheme 截断）。

**复核改判跳 4**：`368f7d2651`（hermes/openclaw 导入功能 fork 没有）、`9c0e7438b5`（上游「不静默换模型」=策略变更，fork limit-takeover 自动选替代模型是刻意设计）、B4 整组（`c693d4c33e` 等依赖上游 macOS `psProcesses` 基座，fork procs.ts 无 darwin 层——需先摘基座再评）、`b806f7f731`/`fe171fbea2`/`e0eab4bd37`（撞 `server/index.ts`/`composio-files.ts` 缺文件，留专门批）。

**merge 规则已落实**：`git rev-list --parents -n1` 判 merge 后 `-m 1`；rebase 时用 `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash` 非交互折叠 fixup。

验证：threads/digest/notify/devs-mention/team-setup/pie-sort 测试过（team-setup 70/70）。

## 执行状态三（2026-11-21 续批，B2+B3，已推 `8361c0e9e2`）

**B2 完结：12 提交全摘**——OpenAICompat transient 重试默认开+HTTP 状态分类六连（`4cb246acda`…`1bbad2584f`，手术适配：retryScale 落调用点 `openai-compat.ts`、测试 env `FAKE_OPENAI_COMPAT_RETRY_SCALE`、恢复 fork 丢掉的 `StreamTruncatedError`+oMLX `TOOL_CALL_FAILURES`、保留 `stream_truncated`）；llama.cpp 上下文溢出五连（丢最旧工具输出→缩小重发→封顶）；`2d65d62050`（merge，Venice base-url 变更重查已存 key，`docs/custom-engines.md` 改 fork「Custom model provider」称谓）。`openai-chat.ts` 守 1000 行棘轮（SSE 行解析抽进 `openai-chat-refusals.ts`）。上游 `openai-chat.test.ts`/`KeysPage.dom.test.ts` fork 不存在，测试按 fork 结构落 `chat-size-limit`/`engine-errors`。验证：drivers 50 文件 1453 测试、typecheck 绿。

**B3 完结：摘 6 跳 2**——
- 摘：`657ded6ea4`（不可达旧别名可替换）→`3139706af7`（不可达可改可清+left-behind notice）→`ae0708b5bd`（能应答但不能验证仍 503）→`6b811ef341`（`VpsHostUnreachableError`，仅 SSH 自身失败才跳过）→`1394b9f515`（`sshNeverReachedHost` 精化判定）五连链 + `41c442d3f1`（WherePage 恢复 `CloudPreference`，PNG evidence 不带）。
- 适配点：`ensureVpsSshMaster` 上游返回 wake 耗时 ms（`deadline +=`），fork 版 `Promise<void>` 无 wake-script——保 fork 签名，deadline 不加，仅取错误包装增量。`server/index.test.ts` DU，其用例无 fork fixture（`fakeSsh*` 不存在），记覆盖欠债。
- 跳：`12ee871b5a`/`ccec24bff9`——`OllamaServer.tsx` 检查流程在 fork Muse UI 重构中已删，`OllamaStatus` 无消费者，无 check-result→refreshModels 落点。
- 验证：vps-computer/runner/inventory/ssh-init/cloud-backend 90 测试、BotSettingsDialog.simple 108 测试、typecheck 绿、oxlint 净。

## 执行状态四（2026-11-21 续批，B5+B6）

**B5 完结：摘 2+1 手术，跳 2**——`481ccf8617`+`1f4c15810c`（companion drain 应答 CLOSING socket，测试落 `companion/test/e2e/phone.test.ts`）；`a14ef45411` 手术取 BOM（`jsonObject` 改 `TextDecoder(ignoreBOM)`，copy-before-await/record 队列属上游 async 实现，fork 同步实现无此面）；`fcf0e48f06`/`d24316e728` 跳——fork 版 `phoneHello` 顶部即验 `isPublicKey`+psk 长度（更严）、`parsePayload1` 已做全 spec 校验。验证：companion e2e 136 测试。

**B6 完结：摘 7，跳 5**——
- 摘：`8d8f304e0f`（NEEDS INPUT "none" 不问）+`27333c3866`（多语 NOTHING_TO_ASK 集）+`2d8ef3312e`（hand-back 读全行）；拒绝归因四连 `449009bc04`→`2cb4157504`→`6290560a7a`→`1d55de7af9`（settled 记 runId、take 只报本 run、statusOf 留重排队 run）。index.ts 两处手术：坐标调用点注 `callRun`、createRefusedHandoffs 注 `statusOf`，行数守 16067 钉。
- 跳：`2726ab85f3`（merge 壳，内容即 `8d8f304e0f`）；`bc27ecd913`（merge 仅动 claude 驱动，fork 已删）；`bb314547f4`+`eb38dd69c6`（`context.summarizing` 事件+`deps.summarizing` 管线在 fork 整条不存在，turn-status 无该 case——重构中删去的功能链）；`f7442d3a63`（修的是 P2 `594adf83d7` 的 retry 函数，fork 无该功能——P2 评审时随基座一起定）。
- 验证：refused-handoffs/acting-person/runtime-coordinator 151 测试、typecheck 绿、oxlint 净。

## 执行状态五（2026-11-21 续批，B7）

**B7 完结：摘 6，跳 3**——
- 摘：`f5e0e338db`（roomLimits 挪到 watchdog.start() 行，fork 同款切片测试）；`dd5c2ad5e7`（房间成员到上限用自身 backup——新模块 `host/room-limit-takeover.ts` 适配落：upstream-only `peer-limit-resend`/`takeRoomPick` 无对应，`nothingRan` 内联、`oneTimeInputTaken` 只看 heldReplay；`limit-takeover.ts` 加 `chosen`/`takeoverAtStart`/`heldAtStart`，fork 自动兜底选替代语义保留；`quota-switch.ts` 抽 `turnLimitScope`）；`3167b9fa90`（idle 计时器复查 `engine.idle()`+armed stale 守卫，fork 无 `held`/`spare`/`sweepIdleEngines` 机制按最小守卫适配）；`57eed6cd52`（`botLevel` 落 `store.ts` `buildTask`，`task-record.ts` 是 fork 已删文件；`own-threads.ts` 加 `approvalFor`+`savedLevel`）；`0df4905165`（`effectiveOutboundPolicy` 落 `shared/outbound.ts`——上游定义在 `packages/phone-protocol`，fork 无该包；DU 删 `phone-protocol/src/outbound.ts`）；`b98dc92e6a`（team-setup 新 bot 用保存的 New bot 层级——`this.own`/`sharedAsMaker` 是 peer-roster/new-bot-sharing 上游独有，保 `this.bot`+visibility 行）。
- 跳：`6117d842c6`（merge 壳，内容是 model-hold 的 acp/steer，fork 无该模块）；`51d24a81fa`（修的是上游独有 live-reply 行内流式架构——`useLiveTranscript`/`useLiveRow`/`roomAddressees`/`drawn-bots` 全在 fork 已删链上，fork 房间用尾部单 `LiveReplyBubble`，无该渲染路径）；`4c4bf3cce6`（`b98dc92e6a` 的 PR merge 壳，双 hash 去重）。
- 欠债：`room-limit-takeover.e2e.test.ts` 未移植——fixture 第二引擎基建（codex/claude fake driver）在 fork 已删，单测 35 覆盖模块逻辑，e2e 集成路径记欠。
- 验证：11 文件 430 测试（room-limit/limit-takeover/refused-handoffs/session-idle/turn-watchdog/store/task-record/new-bot-defaults/team-setup-requests/outbound/quota-switch）+ PluginsPanel.grants/PermissionsSection/outbound-hold 61 + typecheck 绿 + oxlint 净；index.ts 棘轮 16067→16082。

## 执行状态六（2026-11-21 续批，B8）

**B8 完结：摘 5（组），跳 5（组）**——
- 摘：`b8a6ba3f61` ≡ `91fa19d7ad`（图片引用保留 `<attached-file>` 路径——fork admitted 后剥路径同病，已落 `turn-images.ts`；DU 测试去掉已删 `codex-images` 依赖改直接 `execFileSync` 验文件）；`842a1f8b16`（源路径 `%?#`/`file:` 字面名——`sourceFileLink` 落 `bot-attachment.ts`，保 fork 签名不引 upstream-only inbox 回退；`message-file.ts` `pathToFileURL`）；steer 通知四连 `8089f84e36` `9b318b21db` `3a3137508d` `da25c877a1`（`blockedBy` 进回执+队列项持久化；steer-images notice 带 threadId；noticeTimer 先清旧计时器；threadOf 含 `switchingTo`；arrival filter 拒非开着的 thread 级 notice——fork 无 zustand `store.getState()`，适配为 `stateRef`+`reducer()` 同步算 post-state；`composer.queued.roomSteerHeld` locale 键补 en+zh）。
- 跳：`d7957edb24` ≡ `5f2616d87d`、`bf5d53af00`（媒体预算/native clip 全在 fork 已删的原生视频 clip 管线——`sendTurn` 不传 `videos`，`nativeClips`/`sent`/`clips` 条件永假，帧管线无同病）；`4b7a37bb5c`/`3508dee100`/`c558785d0a`（steer-e2e 断言更新+merge 壳——fork 无该 e2e harness；`c558785d0a` 内含的实修即 `842a1f8b16` 已摘）。
- 验证：steer-queue/bot-attachment/box-attachments/turn-images/store 5 文件 374 测试全过 + typecheck 绿 + oxlint 净 + i18n:check 绿；index.ts 棘轮 16082 持平。

## 执行状态七（2026-11-21 续批，B9）

**B9 完结：摘 5，跳 3（merge 壳）**——
- 摘：`ec35541ec8`（Markdown 导出保留 widget/app 文本）；`1e37a12276`（job 导出落盘前校验——`removeEarlierExport`，冲突处保 `lunabot` 品牌）；`427decacd1`（bot 命令认 `--bot/--channel/--thread` 选择器——`named`/`resolveTarget` 与 fork 既有 verb pattern 同构）；`568f19d51e`（force 导出先验目的地——`run-export.test.ts` 是 fork 不存在文件，DU 删，行为改动已随 export.ts 落）；`3cdceb5df5`（named target 拒多余参数）。
- 跳：`87e8c9f6b4` `9579848775` `103e953b81`（同链 PR merge 壳，双 hash 去重）。
- 验证：headless 目录 15 文件 155 测试全过 + typecheck 绿 + oxlint 净。

## 执行状态八（2026-11-21 续批，B10）

**B10 完结：摘 7，跳 6**——
- 摘：`3c7cb48980`（云登录失效不锁死+配对不循环——electron/cloud-account+cloud-signin 干净落；`CloudAccountSettings.tsx` 上游 `part` rail 架构 fork 无，手术落 `resetSaved`/`resetButton` 进 fork Card 布局：signedOut 与 signed 按钮行都优先 reset；`cloudBuy.signIn.*` 新 locale 键保 Luna Bot 品牌）；`a468ff2b30`（TOTP 校验不覆盖已存密钥——内容已在 fork，空 pick）；`827ba816aa`（多行 note 遗忘匹配细节）；`d6da38d176`（CRLF note 识别）；`d734dfb857`（CRLF 新条目免逐出）；`72b6fa4d43`（地址组收件人保留）；`82e8e56f60`（重发码不被旧失败覆盖——测试 `Promise.withResolvers` 超 fork lib 目标，改手写 deferred）；`78dc0d23d5`（upkeep 超时下传——`generateText` 加 `timeoutMs`；e2e 用例依赖已删 ClaudeDriver+fake-cli，改写为桩引擎版：断言 `timeoutMs===DREAM_TIMEOUT_MS` 透传 + 180s 中止语义不变）。
- 跳：`65f33fccb3`（base32 组完整性——fork `decodeBase32Secret` 已有 `bits >= 5` 校验且更严 `allowIncompleteGroups` 参数化，同病不存在）；`1972eea226` `936f3b3b15` `f2ded07eb7` `ea46e8497f` `65c904c8ba`（对应改动的 PR merge 壳，双 hash 去重）。
- 验证：memory/email/totp/sign-in-mail/workspace/CloudAccountSettings 8 文件 181 测试 + electron node 测试 82（cloud-account/cloud-signin/clouds/home-window-pairing）+ typecheck 绿 + oxlint 净 + i18n:check 绿。

## 执行状态九（2026-11-21 续批，B11）

**B11 完结：摘 7，跳 3（merge 壳）**——
- 摘：`0af84856e0`（CUA Driver 用 System32 tar 解包+无版本说明）；`360a38f675`（Linux 桌面按 PATH 找 Chrome——`linuxDesktop`/`linuxChromeOnPath`/`noChrome`；`noChrome?: true` 类型加宽属窗前进件同步补 + 兜底行加 `noChrome`，fork 三处断言跟上契约）；`f126f8a4d5`+`1d4a88693d`（macOS 13 组——capabilities.cjs `macDriverUnsupported`、cua.mjs、MacLocalControl 重试保留原因；`source-hashes.json` 冲突重新生成）；`630712556a`（KDE Wayland color-manager 静默——`disableWaylandColorManager`，导入处保 fork `desktop-mount`/`file-dialogs` 增删并集、`setDesktopName` 保 `LINUX_DESKTOP_NAME`）；`c693badfec`（daemon pid 更换后关旧 profile owner）；`1d68f09bf8` docs 部分（Windows 安装目录说明落 mdx，README 表格行 fork 品牌版无对应位置跳过）。
- 跳：`177248f6b3` `9dc2ee4f0c` `e1e7a171f0`（对应改动的 PR merge 壳，双 hash 去重）。
- 验证：capabilities/cua-launch/MacLocalControl/local-computer/browser-engine/cua-binary-version/resolve 164 测试 + linux-gpu node 测试 + typecheck 绿 + oxlint 净。

## 执行状态十（2026-11-21 续批，B12）

**B12 完结：摘 16（含 1 手术 + 1 merge `-m 1`），跳 6**——
- 摘：`9dab28531a`（My Cloud 配对——`retry({pressed})` 落 `home-window.mjs` 保 Luna Bot 注释；`SAVED_STUCK` 按平台分化 keychain/keyring 文案、reset 永不作主按钮；`blockedProblem` 两处映射——后被 `1a6a624187` pick replay 覆盖丢一次，fixup 归位至该 pick 之后）；`8e43405003`（主线程留折叠会话列表——fork 行组件无主会话星标，测试去星标断言）；`c517e27cd4`（IME 下划线）；`00c436dae2`（IME 确认键误存电脑名）；`3471bd8819`+`56840a5f68`（bidi 词数判定——句末词计入、数字非 RTL、技术 token/裸地址排除、首强方向仅平票用；`3187f132d9` 为旧版「more letters」已被词数版取代）；`3b8b294f94`（跟随会话即时跟默认模型变更）；`17720726c6`（面板模型行跟当前会话——`currentTaskBot`+`key=threadId`，上游 `EffortRow` fork 刻意不放）；`7bc6c7f82d`（side switch 跟侧栏所列）；`3b3089b0dc`（`defaultBot:null` 降级同时清 `sidebarHidden`）；`d1abf55bc1`（常规 bot 残留 `sidebarHidden` 仍列出）；`1a6a624187`（`useSheetOffered` 新检查 pending 时复位）；`4cc80937fe`（后续检查失败隐行——行为已含于前者，空 pick）；`fd7ee6c27a`（无 sheet 页隐账号/登出行——落 fork `useAccounts`/`openSheet` 门控，不恢复已删 `AccountPages.tsx`）；`6b998db17b`（新 bot 欢迎语按所选语言——保 fork 自调中文案，`personLanguages.forPlace` 接线 Store+setup 路由）；`81e3365c79`+`5950b5ca2a` `-m 1`（Apps/MCP 列表 loadError，`mcp.loadAppsFailed` locale 键；两提交撞出重复声明已去重）；`d3f2397dcd` **手术**（只摘 config 帧保 place 字段——fork `ConfigStatus` 有 6/11 字段，`PLACE_FIELDS`+`held` 落 `configStatusFromFrame`、调用点传 `stateRef.current.config`；130+ 文件 useStoreSelector 重构/棘轮基建不摘）。
- 跳：`e6ca737553`（worn rail 主题依赖整套上游 `theme/runtime`+`shared/theme.ts` 体系，fork 不存在）；`2fd0238de6`（`registry-bots.ts` 不存在且 fork 已名「Connected apps」）；`1a14202378`（`hearLanguage` 语音语种功能 fork 已删）；`f7b4ff1450`+`e5b9ae8f9b`（transcript 视窗/选择保持绑上游独有 `transcript-follow`/`transcript-selection` 模块，fork 用 `bottom-follow` 系——30 行步进想法记欠另评）；`3187f132d9`（被 `56840a5f68` 取代）。
- 验证：store/AccountMenu/ChatMarkdown/Conversations/BotSettingsDialog/McpServersPanel/initial-greeting/default-bot/bot-patch 等 287+ 测试 + electron node 159 + typecheck 绿 + oxlint 净 + i18n:check 绿（意大利语 `templates.*` 两处陈旧为基线既有）。`ModelPicker.simple.test.ts` 一条 `border`/`bg-control` 断言失败为基线既有（`ELEVATED_TINT` 含 `border-color`），与本线无关。

## 执行状态十一（2026-11-21 续批，B13 + index.ts 撞点）

**B13 完结：摘 9 + 手术 2，跳 8**——
- 摘：fixture 七连 `59f79c92a6`（mcp 私网 fixture 隔离 host 代理）`a47806be76`（chrome fixture 关 native 搜索）`a4c067b1a3`（desktop sync fixture 隔离磁盘）`3ef3c9b3e2`（bot-box denied 读输出分离）`c3585618c4`（boxed 附件 fixture 先建 workspace）`06e0436d5f`（sign-in-mail 改工程兼容 promise 门——与 B10 手写 deferred 撞名，取上游侧统一）`ebb9089c6e`（MentionTextarea 先验 composition restart）；`b806f7f731`（`chosenBackups` 统一按 `enabled` 计安装级备份——index.ts `chosen:` 换接；fork 保留刻意自动选，测试只断言 `chosenBackups` 契约）；`12935993ac`（weekdays 去重排序——落 fork `shared/plain-time-zone.ts`，上游已迁 `packages/phone-protocol/`）。
- 手术：`0792adcc71` 只取 data-dir 守护——`config-cli.ts` 是唯一绕开 `resolveDataDir` 的入口（还指向旧名 `.openmausbot`），改走统一 resolver；idle cap 依赖 upstream-only `server/perf/`+引擎状态模型、loop-stall sleep 部分同模块不存在，不摘；`caa36ce5f9` 只取 `deploy/update.sh` Podman 竞态段（inspect 空答重读），podman 测试 fixture 上游独有不落。
- 跳：`e0eab4bd37`（落点 `composio-files.ts`/`connector-files.ts` 已删）；`fe171fbea2`（`LiveBot.voice` 消费链 `bot.liveVoice`+`botCallVoice`+ElevenLabs session 俱不在 fork，落即为死数据——随 P2 ElevenLabs 评审重议）；`368f7d2651`（fork 无 Hermes 导入源）；`9c0e7438b5`（fork 刻意保留无备份时自动选默认模型策略）；quiet-status 四连+merge `02f35ac556` `eddc9381d2` `88bc088a59` `9591a02a12` `8710007447`（全改 `describeQuiet` 通知文案——fork 该函数不存在，`live-steps.ts` 把 quiet 状态映射为通用 kind，文案链不成立）。
- index.ts 撞点专项三连随本组判完：`b806f7f731` 摘、`fe171fbea2` 跳、`e0eab4bd37` 跳。
- 验证：limit-takeover/sign-in-mail/plain-time-zone/MentionTextarea/mcp-gate/mcp-remote-proxy 114 测试 + typecheck 绿 + oxlint 净 + update.sh `bash -n` 通过。

## 执行状态十二（2026-11-21 续批，B4 macOS 进程基座）

**B4 完结：摘 2（含基座手术），跳 2**——
- 摘：`5e5ae9e305` **手术**——按上游终态形状把 macOS `ps` 基座拼进 fork 版 `server/procs.ts`：`psProcesses(pids?)`（`/bin/ps -p 列表|-A`，`pid=,ppid=,stat=,lstart=`，`LC_ALL=C`，2s 超时，lstart 空白折叠）、`treeReader`（一轮一次 ps）、`linuxProcess`/`captureCliTree`/`addDescendantsFromEveryProcess`/`signalLinuxDescendants` 开 darwin 支路、`spawnCli`/`execCli` 非 win32 均注册初始树（execCli 超时也能收逃逸后代）。**未引入**上游 `engine-owners`/`engine-records`/`crash-guard`/`process-room`/`process-shortage` 依赖与 `linuxGroupOnlyExited` 架构；fork 特有 `execCliBoxed`/`sharedBoxScope`/`outsideBoxOptions`/`botBox`/UTF-8 `setEncoding` 全保留。新测试 `server/kill-tree-escaped.test.ts`：execCli 超时杀脱组 SIGTERM 免疫孙进程；`c28277c06a`（C locale+空格折叠+zombie 计停——源码部分随上者终态手术已含，pick 落为测试 `alive` 僵尸态修正）。
- 跳：`c693d4c33e`（`treeReader` 一轮一 ps 部分已在手术里按终态落地；`engineOwners.track` 依赖上游独有模块，余量为空 pick）；`d4f404fc90`（merge 壳，含已摘两提交）。
- 验证：`kill-tree-escaped.test.ts` darwin 实测通过（孙进程被 SIGKILL）+ typecheck 绿 + oxlint 净。
