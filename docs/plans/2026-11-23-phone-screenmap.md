# Phone screenmap：认屏与屏图

上游参考：Mika `core/screenmap/`（ScreenNode/Graph/Recognizer/Render，
2026-11-20 `9b5364f8` 系）与 `replay/Route.kt` 的 `RouteAnchors` 骨架口径
（Apache-2.0）。设计页照惯例先落一页纸。

## 问题

bot 每次开进一个 App 都靠 PHONE_UI_OBSERVE 从零认屏；同一 App 的固定框架
（标题、标签、底部栏）每回合重复烧 token，bot 也不知道「这个 App 有哪几屏」。

## 提议（v1）

服务端自学习屏图：从已回答的 PHONE 写操作的屏幕（host 已记录的 last screen）
提取骨架锚点，按 App 积累「结构页」节点；回合注入时给模型一张紧凑屏图。

- **骨架锚点**（`RouteAnchors.texts` 口径）：非输入框、不在列表/可滚动容器内、
  短（≤12 字）、不含数字/货币/百分号的文字；带 viewId 的排前，屏上顺序去重。
  列表条目是内容，输入框是用户打的字——都不是锚点。
- **节点身份**：`screenId = sha256(app \0 signature)` 前 8 字节，signature =
  锚点去重排序拼接；同一骨架永远同一 id，重建逐字节相同。
- **认屏**（纯函数零模型）：`score = coverage × rarityMean`，coverage = 命中
  锚点/节点锚点，rarityMean = 命中文字的 1/文档频率均值；低于 0.5 返回 null
  不猜——「确定/返回」哪屏都有，稀有度自然压下去。
- **转移边**：同 App 连续两屏骨架不同 → 一条 `tap(target) → next` 边，按
  (action, target, to) 去重计数；LEFT_APP/未识别目标记 UNKNOWN。
- **渲染**：屏清单 +（认得出当前屏时）从这屏出发的边，超 12 屏截清单、
  超 1200 字截断——挤不掉元素列表，只作参考资料。
- **存储**：`DATA_DIR/phone-screenmaps/<owner>/<package>.json`，0700/0600，
  原子写，每 owner 上限 20 个 App、每 App 上限 60 屏。

## 接线

| 件 | 落点 |
| --- | --- |
| 纯核心 | `server/phone-screenmap.ts`（骨架/id/认屏/边/渲染/合并） |
| 学习+存储 | `server/host/phone-screenmap.ts`（每 owner observer：prev 屏 + 本次屏
  + 动作 → 片段并入；内存去抖，同屏不重复学习） |
| 学习钩子 | `server/phones/host.ts` `noteEvidence`——owner 经 `deps.turnOwner(turn)` |
| 注入点 | `server/host/phones.ts` `parts()`：phoneUi 写权限的 bot，回合注入其 owner
  已学的 App 屏图（compact 段） |
| 测试 | 纯核心全量（锚点/认屏/边/渲染/合并）+ store 原子写/上限 |

## 不做（本轮）

- 转移边上的 `offTrack` 跑偏计数与回放接图（`0f364ece` 的认屏重试）：等
  route-replay 消费方出现再立项。
- Mika 的 `levels`（页面层级字段）、`name` 人工标注：留空字段，不填。
- Android 侧零改动：骨架来自服务器已见的答案屏，不需要手机配合。

## 验证

1. 纯核心：锚点抽取规则（数字/列表/输入框排除）、id 稳定性、认屏阈值
   （稀有文字命中才认）、边去重、渲染截断、合并幂等。
2. store：0700/0600、原子替换、App/屏上限淘汰。
3. host 接线：同屏不重复学、LEFT_APP 记 UNKNOWN、注入段有屏图才出现。
