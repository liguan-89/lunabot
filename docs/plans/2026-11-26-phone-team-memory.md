# 手机端团队记忆实施计划

2026-11-26。批次 5 剩余的团队记忆：服务端 `GET/POST/PATCH/DELETE /api/team-memory` 已存在，companion 白名单已放行，桌面端已有完整管理弹窗；Android 完全没有实现。

## 范围

本轮做完整管理，不做只读半成品：

- 查看一个分区的共享记忆，区分已采纳与待确认；
- 添加、编辑、置顶、删除；
- 采纳或跳过智能体提出的记忆；
- 查看历史版本并恢复；
- 409/428 版本冲突与其他不可用分开：冲突先刷新并提示，避免人误以为保存成功。

不做：分区说明编辑、空分区分组管理。手机端目前只能从现有分组与 General 进入；空分区仍属于电脑端团队地图的管理范围。

## 入口

- 普通分区：roster 分组头右侧「记忆」。折叠/展开点击区与记忆入口分开，避免嵌套点击和无障碍语义合并。
- General：抽屉里的「通用记忆」，因为 General 没有 roster 分组头。

## 实现边界

- core wire model 把 kind/status 保持字符串，未来服务端新增种类时手机仍显示原文。
- GET 响应含 `section/label`；写操作响应只含 `entries/loadedIds`，客户端按真实契约分开建模，写成功后并入当前页面状态。
- 修订票 `revision/expectedRevision` 只按服务端契约透传，不在手机端自行生成。

## 验证

- `TeamMemoryClientTest`：query、路径转义、修订票与真实写操作响应形状。
- `SessionTeamMemoryTest`：读失败 null、写冲突/不可用/成功三态。
- `TeamMemoryRulesTest`：中文分类、未来 kind 保留、来源与加载状态文案。
- `NavigationTest`：新 destination 持久化往返，包括空 section。
- Android core 全量单测与 app 编译/单测；app 本机既有两颗 Compose 红候选单独核对。
