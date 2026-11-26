# 手机端凭据卡 HPKE 提交

## 目标

让 Android 手机能像 iOS 一样，直接填写一张 pending 凭据卡并提交；凭据明文在手机上只存在到本地加密完成，HTTP、chat、SQLite、SSE、日志与 sidecar 都只接触 HPKE envelope 或状态。

## 安全边界

- pairing QR 的 `secretKey` 是桌面 P-256 HPKE recipient public key；手机只在扫码配对时 pin 它。手工配对、旧配对或没有该字段的连接继续可聊天，但不能提交凭据，UI 指引重新扫码配对。
- 只走受保护路由：hosted HTTPS、Tailscale，或已建立的 e2e 加密通道。LAN/Bonjour 明文 HTTP 不提交。
- 算法为 RFC 9180 base mode：DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM。
- AAD 与服务端 `phoneSecretAAD` 完全一致：`lunabot-phone-credential-v2`、keyId、认证设备 id、bot、thread、message、target、requestKey，八字节段以 `\n` 连接。
- `keyId` = recipient public key uncompressed point 的 SHA-256 前 16 字节，base64url 无填充。
- 网络结果不确定时重试必须复用同一份 envelope；明文输入在加密后立即清空，envelope 只保存在内存。

## 实现切片

1. `Connection` 增加 `secretPublicKey` 与 `companionDeviceId` 两个可空持久字段；`PairingInvite` 解析并校验 `secretKey`，配对成功后保存 device id。坏 key 会让整个 invite 失效，不静默降级。
2. core 增加最小 HPKE sealer，不引入新依赖；用固定 ephemeral key 的跨语言测试向量锁定字节级兼容，并用生产随机 ephemeral 的 Kotlin envelope 做服务端 `@hpke/core` 解密复核。
3. `CompanionClient` 增加 100 秒预算的 `provideSecretCard`，POST 且只 POST 协议规定的八个 envelope 字段；`Session` 在提交前重新检查当前真实 transport 的 keyId、deviceId 与路由保护状态，而不是只信已保存的连接快照。
4. 凭据卡 UI：pending 时提供密码输入、提交、跳过；缺 key/device/受保护路由时显示明确降级原因。传输不确定失败后保留 envelope 并重试；服务端权威拒绝后清空 envelope，允许重新输入。
5. legacy host 候选与 typed endpoint 共存时，active protected route 在候选排序中保持领先，避免 failover 候选把 hosted HTTPS 隐式改写成 LAN cleartext。
6. 定向测试覆盖 pairing pin、HPKE 向量、client 请求 shape、Session 错误折叠与 UI 规则。

## 非目标

- 不做 TOFU 补 pin；旧配对必须重新扫码才能获得凭据提交能力。
- 不把凭据明文写入磁盘、日志、分析或 chat。
- 不改变服务端 HPKE 协议或 companion allowlist。
