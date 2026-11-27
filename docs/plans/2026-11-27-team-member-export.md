# Team Cloud 成员数据全量自助导出（issue #130）

决策（issue #130 评论）：成员数据全量；成员自助随时导出 zip；不做成员级登录；离开流程只提醒不耦合。

## 范围

成员 person key `p_xxx` 的全量数据，与 `team-member-left.ts` 删除集同构：
- 私聊线程（starters 私聊 + own bot 全部线程），**全分支**消息（messagesFor，非 activePath）JSON + 每线程 markdown
- memory 层 `workspaces/<botId>--member-<person>/`（MEMORY.md + memory/*.md）
- about-you/profile（`people/<person>/about.json`、`profile.json`）
- 住在私聊的 routines（routineHome === person）+ 其 runs
- 未发送上传 `people/<person>/uploads.json` + inbox 过滤项
- 附件二进制：私聊线程引用的 + 未发送上传的（排除仍被共享引用——与删除流程同 logic 但导出侧简化：只要不删数据，共享引用无影响，附件全收）

## 形状

- `POST /api/me/export` → 生成 zip 到临时 artifact（`{owner, path, expires}` 模式，仿 workspace-backup-http），返回 `{id, expires}`
- `GET /api/me/export/:id` → 流式下载，content-disposition attachment，仅 owner 本人
- CLIENT_ALLOW 加两行（member 自助）
- zip writer：`server/testing/zip-fixture.ts` 的 buildZip 逻辑提升为生产 `server/zip-write.ts`（store 模式直写本地头+中央目录，附件用 deflate）；大附件流式落盘不再内存翻倍——先写临时文件再 createReadStream 回传

## UI

设置 general 区块加「导出我的数据」卡（`state.config.team` 门控，仅 team cloud 显示），POST 后 `<a download>` 触发。

## 不做

- 不做成员级登录（决策 3）
- 不耦合 member-left 删除流程（离开只提醒——提醒 UI 本批不做，决策原文「只提醒不阻断」指流程语义，提醒界面留后续）
- 不导出共享房间内容（成员数据主权=自己的数据，房间属于团队）
