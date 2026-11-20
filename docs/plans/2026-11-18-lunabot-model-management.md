# Luna Bot 模型管理（AI 设置页合并）

## 背景

pi 是唯一引擎后，AI 设置页仍以「你的 AI → 自定义模型提供方」的引擎实例视图呈现；
同一份自定义提供方（URL / key / 协议 / 模型列表）又在「API 密钥」页出现一次。

## 目标

AI 页只留一个「Luna Bot 模型管理」：

- 列出 pi 的模型目录（`get_available_models`，含 pi 自带模型与自定义 provider 的模型）；
- 就地管理自定义 provider：协议、Base URL、API 密钥、模型列表；
- 重新检查：走 pi 的模型刷新（`/api/instances/pi/refresh-models`）；
- 增删自定义模型（写入 `cfg.openaiCompat.models`，由 pi 的 `models.json` 模块落地）；
- 隐藏任意模型（`cfg.hiddenModels`，只影响 Luna Bot 的列表与模型选择器，不改 pi 的 provider/auth 配置）；
- 设新机器人默认模型（`cfg.defaultModelSelection`）。

「API 密钥」页不再重复展示自定义提供方，其余密钥不变。

## 非目标

- 不改 pi driver、`models.json` 格式或 `get_available_models` 协议；
- 不做 pi 自带 auth.json / `pi auth` 的管理界面；
- 高级设置里的引擎维护（CLI 路径、版本更新）保持原入口。

## 数据流

| 数据 | 来源 | 写回 |
| --- | --- | --- |
| 模型目录 | `state.instances` 的 pi 实例（`models.options`） | `POST /api/instances/pi/refresh-models` |
| 自定义 provider | `state.config.openaiCompat`（url/protocol/models/key） | `PUT /api/config { openaiCompat }` |
| 新机器人默认 | 新增 `configStatus.defaultModelSelection` | `PATCH /api/config { defaultModelSelection }` |

配置保存后服务端会 reload provider，再刷新一次模型目录即可。

## 文件

- `server/index.ts`、`src/state/config-status.ts`、`src/state/store.tsx`：透出 `defaultModelSelection` 与自定义 provider id。
- `src/lib/model-management.ts`：模型行、增删/校验纯函数。
- `src/components/ModelManagement.tsx`：页面组件（复用 `OpenAiCompatUrl`、`KeyRow`、`BuiltInReplyWait`）。
- `src/components/SettingsSimplePages.tsx`：AI 页接入。
- `src/components/keys/KeysPage.tsx`：过滤重复的 `openaiCompat` 条目。
- `src/locales/en.json`、`src/locales/zh.json`：新文案。

## 验证

- `ModelManagement` 纯函数单测；设置页/密钥页相关测试；
- `pnpm typecheck`、`pnpm exec oxlint --deny-warnings`、`pnpm i18n:check`。