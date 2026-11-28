# 自定义模型提供方完整模型目录

## 背景

自定义模型提供方首次连接时会读取 `/models`，但实现复用了 API Key 测试的预览解析，
只保存前 5 个模型；配置、pi 注入和前端手工添加又各有 64 个上限。tk1688 这类聚合
平台有几百个模型，部分保存后「重新检查」也只重读 pi 目录，不会补全。

## 目标

- Key 测试仍只展示前几个模型，避免把几百个 ID 倒进设置页提示；
- 首次连接保存 `/models` 返回的完整模型 ID 列表，不保留数量上限；
- 「重新检查」时 pi 用提供方当前 `/models` 补齐 live 环境，服务端把 pi 目录中的
  自定义模型持久化回 `openaiCompat.models`；
- 已经手工添加、但 `/models` 未返回的 ID 保留，不做破坏性替换；
- 前端手工添加、配置 schema、pi 注入都不再截断数量。

## 非目标

- 不处理 `/models` 分页（OpenAI 兼容端点本身不分页）；
- 不改模型隐藏、默认模型或手工删除语义；
- 不为无 Key 的本地服务新增目录拉取（保持现有 Key 校验边界）。

## 验证

- `provider-key-check`：Key 测试默认仍截断，完整拉取模式不截断；
- `openai-compat-models`：首次连接保存超过 5 个/64 个的完整列表；
- pi driver：refresh 后 live catalog 与 `models.json` 包含数百个自定义模型，手工 ID 保留；
- provider key flow：refresh 后 `config.json` 持久化完整列表，Key 测试仍只回前 5 个；
- `model-management` 纯函数测试、typecheck、oxlint、i18n check。
