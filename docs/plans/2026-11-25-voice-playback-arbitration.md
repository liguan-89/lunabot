# Plan: 双端自动朗读仲裁

## Why

手机本地朗读落地后，`speakReplies` 仍是 bot 级偏好：电脑和手机同时在线时，同一回复可能两边都读。目标不是做一个通用播放设备选择器，而是先消掉最差的用户可感知故障——叠声。

## Design

第一版只做“开始朗读前仲裁”，不做播放中跨端接管：

- 服务端增加内存态 speech arbitration：
  - phone listener：手机前台且未被通话、录音、语音条或音色预览静音时上报，短 TTL 过期；
  - reply claim：按 `(threadId, turnId)` 记录一个 claimant，短 TTL，可续期。
- 手机自动朗读开始前先 claim；同一 turn 已被另一设备拿走就放弃。
- 桌面自动朗读每个 prepare 前刷新 claim；若存在新鲜 phone listener，直接让路。
- 播放中不抢占：手机稍后亮起或桌面稍后才收到帧时，宁可当前 turn 由先开始的一端读完，也不两端同时出声。交接边界可能漏读，这是刻意选择的较小坏事。
- 手动语音条、音色预览、通话不受影响；仲裁只约束 bot `speakReplies` 的自动朗读。

## 验证

- server：listener 过期、桌面让路、同端续期、异端拒 claim。
- desktop：存在 phone listener 时不 prepare/播放；claim 网络失败不破坏既有朗读。
- Android：listener 只在前台且无 mute gate 时上报；自动朗读 claim 被拒时不合成/播放。

## 不做

- 不做用户可见的“选择播放设备”设置。
- 不做播放中接管或逐句迁移。
- 不依赖 PR #99 的 presence；它是更宽的人员在场语义，本线只登记“手机朗读能力在场”。
