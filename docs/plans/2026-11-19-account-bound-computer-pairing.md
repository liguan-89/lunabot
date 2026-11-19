# 账号绑定本机 —— 设计

日期：2026-11-19
状态：实施中

## 问题

手机登录「DEX 账号」后，只能看到并配对**云电脑**（`/v1/clouds`），看不到自己名下的
本地电脑。想连本机必须扫码或手输地址+配对码，换网络就失联。

用户诉求：登录同一个账号，就能绑定并连接这台电脑。

## 为什么现在做不到

1. 账号层面已经有"我的电脑"数据：控制面 `GET /v1/installations` 返回该账号注册过的
   所有 installation（名字、平台、版本），但手机端没有用它。
2. 即使列出，也没有"批准连接"的通道：配对码由桌面端的 sidecar 生成，控制面不能代签；
   端到端密钥（e2e transport key）只在配对时一次性交换。

## 方案：账号发起 → 桌面批准 → 交回同一张配对凭据

不引入新的密码学。账号只负责**找到电脑并递话**，真正的凭据仍是桌面端生成的那张
`lunabot://pair?...` 链接（与扫码完全同构，含 e2e/中继描述符）。因此：

- 手机远在公网、电脑在中继后面，批准后仍能连上（链接里带中继凭据）。
- 账号泄露也连不上：仍需要那台电脑上的人点「允许」。
- 每台手机依然是独立设备凭据，可单独吊销。

### 接口（控制面 `dex-cloud`）

| 方法 | 路径 | 鉴权 | 作用 |
| --- | --- | --- | --- |
| `GET` | `/v1/installations` | 账号 | 已有；响应补 `lastSeenAt`、`online` |
| `POST` | `/v1/installations/{id}/pair-requests` | 账号 | 手机发起：`{ deviceName }` → `{ requestId, expiresAt }` |
| `GET` | `/v1/installations/{id}/pair-requests/{rid}` | 账号 | 手机轮询：`pending` / `allowed`（带 link）/ `denied` / `expired` |
| `GET` | `/v1/installations/self/pair-requests` | installation 凭据 | 桌面轮询待办 |
| `POST` | `/v1/installations/self/pair-requests/{rid}` | installation 凭据 | 桌面答复：`{ decision: "allow", link }` 或 `{ decision: "deny" }` |

约束：

- 请求 5 分钟过期；答复（link）2 分钟内可读，读后保留到过期以便重试。
- 每台 installation 每小时最多 20 次请求（防止账号被盗后刷屏骚扰）。
- 只允许账号拥有该 installation 时创建/读取；只允许该 installation 的凭据答复。
- link 原样存库，不含额外秘密（本身就是一次性配对凭据，且桌面端随时可重开新窗口使其失效）。

### 桌面端

- 登录且在线时，每 15 秒 `GET /v1/installations/self/pair-requests`（轻量）。
- 有待办 → 设置里出现一张卡（含手机名称、时间）+ 系统通知。
- 点「允许」：打开配对窗口（与扫码同一路径），把生成的 link 作为答复提交。
- 点「拒绝」：提交 deny，不再提示。
- 未登录或未开「随处连接」时该卡不出现（此时中继未起，link 只有局域网地址）。

### 手机端

- 「DEX 账号」区在云电脑之外新增「我的电脑」列表（来自 `/v1/installations`）。
- 每行显示名称、平台、在线状态；点「连接」→ 创建请求 → 轮询 → allowed 后交给现有
  配对流程（同一套 `PairingInvite.parse`），与扫码结果完全一致。

## 安全边界

- 账号只是"递话人"，不是"授权人"：没有桌面端的人工批准，拿不到可用凭据。
- 控制面不存端到端私钥，link 里只有公钥与一次性代码。
- 拒绝与过期都是终态；重复批准会覆盖旧 link 并使旧代码失效。

## 验证

- `dex-cloud` 单测：越权创建/读取被拒、过期、拒绝、限额、答复后 link 可见。
- 端到端：手机登录 → 我的电脑 → 连接 → 桌面弹卡 → 允许 → 手机连上（先局域网，再关 Wi-Fi 走中继）。
