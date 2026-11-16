# pi-only 交接说明

> 分支：`pi-only-engine`（未推送）。工作区除与本改造无关的 Android 改动外是干净的。
> 基线：`main` (`6f029f5ad`)；本分支共 45 个提交。

## 1. 这次做什么

产品只剩一个 agent：pi（`server/drivers/pi.ts`），所有内置 AI 提供方都不再是引擎实例，
唯一提供方是自定义 provider（配置仍在 `cfg.openaiCompat`，通过
`DEXBOT_PI_CUSTOM_*` 和 pi 的 `models.json` 落地）。Claude/Codex/OpenCode/ACP/Cline/
Grok/Copilot 等驱动已删除。

本阶段完成的收尾：

1. 两个结构性棘轮清零：把一个 15k 行的 `server/index.ts` 路由块挪进
   `server/routes/`，把超长的 driver/store/组件拆出独立模块。
2. 把最后一批引擎矩阵 end-to-end 配方迁到 fake pi；纯已删引擎的配方删除。
3. 验证面收敛：`pnpm test:e2e` 现在就是 pi 套件（`test:e2e:pi`）；旧的跨引擎套件
   保留为 `test:e2e:legacy`，不作为验收门。
4. 修了迁移过程中暴露的真实产品 bug：失败 turn 已流式输出的文本落在失败行之后。

## 2. 验证结果（可复现）

| 命令 | 结果 |
| --- | --- |
| `pnpm test:e2e:pi` | 116 文件 / 535 用例（2 skip）。最后一次完整并行运行：114 文件通过 + 1 skip，仅 `cli-stop` 因 fixture 竞态失败；修复后单跑 2/2 通过。用户叫停前的串行确认跑到 85 用例、0 失败。 |
| `npx vitest run --exclude '**/*.e2e.*'`（排除 e2e） | 2088 文件，28,457 通过，89 skip，3 todo；2 个失败见第 5 节。 |
| `npx vitest run scripts/testing/file-size-ratchet.test.ts` | 通过 |
| `npx vitest run scripts/testing/index-route-ratchet.test.ts` | 通过 |
| `npx tsc -b && npx tsc -p tsconfig.server.json --noEmit` | 通过 |
| `npx oxlint --deny-warnings <改动文件>` | 通过 |

自动恢复修复后的复验（同口径）：`server/drivers/pi.test.ts` 93/93（含 3 个新用例）、
`automatic-recovery.e2e` 3/3（含真实恢复用例）、`incidents.e2e` 10/10、
两个棘轮与 `tsc -b`/`tsc --noEmit`/oxlint 均通过；全量非 e2e 套件
28,459 通过、3 失败（基线 2 个已知项 + `vps-ssh-init` 在与 e2e 并行
负载下的一次时序抖动，单跑 6/6 通过）。

棘轮现状：

- `server/drivers/pi.ts` 1039 行（上限 1167）
- `server/store.ts` 2250 行（上限 2291）
- `src/components/PhoneSetupFlow.tsx` 1072 行（上限 1089）
- `server/index.ts` 的 `path === "/` 83 次（上限 84）、`path.match(` 23 次（上限 24）

## 3. 本阶段新增/拆出的文件

| 文件 | 作用 |
| --- | --- |
| `server/drivers/pi-model-catalog.ts` | pi 模型目录的解析、注入模型与本地 catalog 写入，从 driver 拆出 |
| `server/store-rooms.ts` | 房间默认回复者归一化、@ 路由、hold 清理，从 store 拆出 |
| `server/routes/calendar-calls.ts` | 日历调用路由，从 `server/index.ts` 拆出 |
| `src/lib/phone-setup-bridge.ts` | 手机设置页的 bridge 读取/状态合并，从组件拆出 |

产品修复（`server/drivers/pi.ts`）：`finishRun` 在发出 `runtime.error` 之前先
`flushAssistantText()`，保证 transcript 中失败行保持最后。

## 4. e2e 验收面

- 套件清单在 `package.json` 的 `test:e2e:pi`（116 个文件）。
- fixture 说明与已迁移配方清单在 `docs/verification/pi-e2e.md`。
- 启动器是 `scripts/control-omb.ts`：只注入一个 `pi` 实例，CLI 指向
  `server/testing/fake-pi-cli.ts`，并写 `fake-pi-dump.jsonl`；
  `server/testing/pi-dump.ts` 负责读回 launch、prompt、模型与会话。
- 本阶段迁移的配方包括：parallel-threads、thread-aware-bots、group-goal-run ×2、
  long-running-chief、headless-cli、reply-behaviour、direct-coordination、
  room-context、key-rejected、openai-boat、digest-control、digest、agents-bridge、
  automatic-recovery、bot-visibility、computer-engine-removal、decider-rooms、
  full-access-workflows、incidents、limit-reset、notification-routing、openai-tools、
  room-sessions、team-move、thread-model-follow、trust-controls、voice-notes。
- 删除的四套纯已删引擎配方：cline-native、cline-ui、portable-hermes、hooks（Claude
  Code 的 hook 通道；pi 没有 hooks 能力）。

## 5. 已知问题与产品缺口

1. ~~**`phone-relay` 的「停顿流」用例在本机挂起**~~（已修，2026-11-14，两侧）。
   companion sidecar 侧是三层叠加的泄漏链——① 响应先于请求体结束时代理不销毁请求
   （`proxy.ts`）；② `duplexPair` 的 destroy 不传播到对端，origin 关闭后 `near`
   永远等不到写完成（`origin.ts`）；③ 会话桥只看 `socket.readableEnded`，漏掉
   「流没读到 FIN」的半开形态（`session.ts`）。修复后 mux RST 能一路传回手机，
   `activeStreams` 归零；顺带把 `remoteReset` 改为干净销毁（RST 到达时 Node client
   可能已剥掉 error 监听，带 error 的 destroy 偶发炸掉进程，约 50% 复现于并行跑）。
   回归用例在 `companion/test/e2e/sidecar.test.ts`（"resets an upload whose
   harness goes quiet"），`phone-relay.e2e` 也已修复（含两处 rebrand 遗留：health
   `lunabot`→`dexbot`、节点 `*.lunabot.com`→`*.dexai.vip`，2/2 恢复）。
   server 侧同日修复：`enforceDeadlines` 到期不再裸 destroy（那只会发 RST，手机端
   等不到 "end"），改为先答 `HTTP/1.1 408` 再优雅 FIN——`duplexPair` 半关闭把 EOF
   传到 mux 的 finish 帧，手机栈拿到可报告的超时与 EOF；流未完成的另一半由再次
   到期收回。已开始的应答无法注入 408，仍走 destroy。`relayed()` 同步补上 companion
   proxy 的守门规则：应答先于请求体结束时销毁未读完的请求。
   `server/phone-relay.test.ts` 14/14（含 "ends a stream that stalls in its
   request headers or body"），companion 树 589 通过无回归，`phone-relay.e2e` 2/2。
2. **`server/drivers/pi.test.ts` 的 willRetry 用例在 4 路并发下偶发失败**；
   单跑 90/90 通过。是时序抖动，不是逻辑失败。后续在 `awaitResponse` 加了
   死亡子进程即时拒绝（waiter 注册晚于 `close` 事件时原先会挂到超时），
   连续复跑未见复发；未做全量并发复现，不宣称根除。
3. **Mimosa 深度审计未封存**：深度扫描在 audit 阶段停留约 55 分钟无进展，已取消。
   2026-11-14 复测三次：deep 两次（`scan-job-mwfd551z-…`，attempt 1/2 在 audit 冻结
   26/10 分钟）+ normal 一次（`scan-job-mwfen16k-…`，audit 冻结 65+ 分钟）——
   停滞与深度无关，可复现，属扫描器侧问题，与本仓库改动无关。
   2026-11-14 下午在 phone-relay 挂起用例修复后、项目树稳定时再测两次
   （`scan-job-mwfvb1k0-…`，attempt 1/2 在 audit 冻结 85/60 分钟后取消）：排除了
   「挂起测试拖住 audit」的假设，结论不变，仍属扫描器侧。
   因此**不能声称项目安全**；合并前需要在扫描器修复后重跑完整审计。
4. ~~**pi 下自动恢复不可达**~~（已修）：pi adapter 现在把"prompt 帧发出之前"
   的失败（子进程死亡、set_model 失败、prompt 帧写出失败）分类为
   `TurnNotStartedError` 并在 `startupRecovery` 下安静结算，harness 的
   `automaticRecovery` 因此在同实例的备用模型上重放一次。prompt 已被接受
   之后的失败仍一律报告、绝不重放（e2e 两面都有覆盖：
   `server/automatic-recovery.e2e.test.ts`，fixture 旋钮 `FAKE_PI_EXIT_ON_FIRST_MODEL`）。
   退休的签名拒绝/限额拒绝类别仍然没有 pi 等价物。
5. **agents tool bridge 对 pi 永远拒绝**：`engineBridgeRefusal` 对 `piAgent` 一律返回
   拒绝，bridge 在本 build 不可能启用；测试已改为断言这个拒绝。
6. **pi 不报告 plan usage / reset / 登录状态**：`limit-reset` 从 11 个子测试收敛为 1 个
   诚实用例（限额拒绝、保留提供方原话、不伪造 reset、创建一次性 `limit_reset`）。
7. **Boat 的 cloud computer 调用没有逐次审批卡**：pi 扩展只 gate
   `local-computer`/`custom` server；Boat 挂载时没有 scope。审批卡本身仍有独立覆盖。
8. **清空自定义 provider key 不再参与 cloud routine readiness**：pi 快照永远
   `available`，无 key 的运行会晚些在 provider 内失败。
9. **假 pi 的能力缺口**：没有 `getActiveTools`/`setActiveTools`，所以工具范围受限的
   pi turn 会被 driver 正确拒绝（fixture 缺口，不是产品行为）；plan evidence 只带
   挂载工具名，不带描述/schema，因此丢了两个 `start_thread` schema 断言。
10. **233 个旧 e2e 文件未迁移**：都是上游的跨引擎/云/浏览器/UI 配方，配置已删除的
    `claudeAgent`/`grokAgent`/ACP 实例，或依赖真实云与浏览器环境。`test:e2e:legacy`
    用于单独运行它们，但**该命令的 vitest 子串过滤尚未实测**，第一次用请先小范围验证。

## 6. 建议的下一步

1. 合并前重跑完整 Mimosa 审计并取得封存结论。
2. 单独定位 `phone-relay` 停顿流用例（companion mux 的 reset 传播），不要和 pi 改造混在一起。
3. ~~若要恢复自动恢复能力~~（已做）：pi adapter 在 `startupRecovery` 下把
   pre-prompt 失败以 `TurnNotStartedError` 拒绝，`automaticRecovery` 在备用
   模型上重放；单测与 e2e 均覆盖。
4. 若要恢复 plan 限额/登录状态，需要 pi 或自定义 provider 暴露对应读数；目前没有。
5. 剩余旧 e2e 按需分批迁移（每批 5 个、并行子代理）；不必一次性清完。
   进度（2026-11-14）：legacy 清单实测 190 个（文档原记 233，期间已消化）。
   第一批收编 3 个进 `test:e2e:pi`（现 119 个）：digest、digest-control、
   phone-relay——原样通过（phone-relay 需先修 §5.1 的停顿流与 rebrand 遗留；
   digest 两个此前被误记为已迁移）。native-replay 与 recent-work 试收编后
   确定性失败，退回 legacy：前者还在 PATCH 旧的 `openaiCompat` 实例 API
   （pi-only 已挪到 `/api/config`），后者等的房间上下文 system prompt 需要
   room-context 式迁移。纯 fixture 桶其余配方判定为真迁移（依赖 Claude Code
   技能目录、engine family 默认值、审批级别等已删能力）。
   另：`server/vps-ssh-init.test.ts` 的 initialization 竞态用例在并行负载下
   复现失败（单跑通过），与 willRetry 同类，已列入观察。

## 7. 交接注意

- Mimosa PreToolUse 会拦截通过 Bash 直接写源码/配置；改文件请用 Write/Edit。
- commit hook 可能报 `scanner_no_output`；这只表示没有完整扫描结论，不代表安全。
- 不要对用户正在运行的 app/data 做验证；所有 e2e 都应在隔离 fixture 里跑。
- 工作区里的 Android 改动已单独提交（`8175faabc`，Luna Bot 品牌与设置页重构），
  与本改造无关。
- 本阶段提交（新→旧）：
  `c8e7eb791`、`9172ed512`、`fec063c12`、`8875fc118`、`b9da64152`、
  `fa0377360`、`4efb88076`。
- 后续修复（自动恢复 + willRetry 竞态防护）见最新提交记录。

## 8. 关键文件索引

- 引擎：`server/drivers/pi.ts`、`server/drivers/pi-model-catalog.ts`
- 提供方接线：`server/drivers/pi-custom-provider.ts`
- 测试 fixture：`server/testing/fake-pi-cli.ts`、`server/testing/pi-dump.ts`、
  `scripts/control-omb.ts`
- 验收清单位置：`package.json`（`test:e2e:pi`）
- 迁移说明：`docs/verification/pi-e2e.md`
- 结构棘轮：`scripts/testing/file-size-ratchet.test.ts`、
  `scripts/testing/index-route-ratchet.test.ts`