# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.

---

# 本 fork 开发纪律（追加，上游内容以上为准）

## 测试分层（开发阶段）

全量（`pnpm test` ≈ 2100+ 非 e2e 文件 + electron + 打包冒烟）只在合并回 main
之前跑；开发阶段不得自主执行 `pnpm test` / `pnpm test:e2e` /
`pnpm test:packaged-server` / `pnpm package:*`。

- 改动自检：`pnpm exec vitest run <同目录测试文件>` + `pnpm exec oxlint --deny-warnings <改动文件>`。
- 任务收尾：`pnpm typecheck` + `pnpm exec vitest run <模块目录>`；
  动了 `src/locales/` 加 `pnpm i18n:check`。
- 合并回 main 前：`pnpm test` 必须绿。发版前：`pnpm test:e2e` + 打包冒烟。

## Git 安全

- 开工先 `git status`：有来源不明的脏文件或未推送提交，先问用户再动手。
- 本仓库有未提交内容时，其他会话禁止 `checkout` / `reset` / `clean` / `stash`。
- 小步提交；离开工作线前 commit + push；禁止 force-push `main` 与已推送分支。
- 并行任务在独立 git worktree 里做，不在主仓库切分支。

## 子代理红线

子代理不跑全量测试、不做 git 写操作、不装依赖、不 kill 进程、不起长驻服务；
提交与合并由主会话做。多会话协作与 worktree 台账见工作区根目录的 `AGENTS.md`。
