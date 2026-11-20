# 账号里过期手机记录的自动清理 —— 一页纸设计

日期：2026-11-19
状态：实施中

## 问题

账号下的 `installations` 表把手机、电脑、服务器混在一起。手机只在**登录那一刻**
注册一次（`POST /v1/installations` → `insertInstallation`），之后再不写自己的行。
于是：

- 换手机、重装 App、模拟器试装，都会留下一行永久垃圾。现在账号里有 4 条：
  `2db4863b`（一加 15T 2.1.0）、`18eb763d`、`faa34e09`、`85c380d2`（两台模拟器 2.0.0）。
- `last_seen_at` 对手机行实际上等于 `created_at`，所以**不能**直接按时间清：
  一台天天在用的手机，行里的时间也会一直停在注册那天。

所以清理必须和「在线心跳」一起做，否则要么清不掉，要么把活人删了。

## 方案

### 1. 心跳：`POST /v1/installations/self/presence`

账号鉴权（`cps_` 会话），body `{ clientInstanceId, name?, appVersion? }`：

- 行存在 → 更新 `name`/`app_version`/`last_seen_at`，**不动凭据**。
- 行不存在（刚被清掉，或本机首次）→ 插入 `kind = "phone"` 的新行，**不发凭据**
  （手机从来不用 installation 凭据；它用的是账号会话）。
- 返回 `installationShape(installation)`。

不复用 `POST /v1/installations` 的原因：那条路由每次都会吊销旧凭据、重新签发。
手机若拿它当心跳，会把**桌面**那条安装凭据一起踩掉——桌面的配对轮询和
relay token 都靠它，等于每次打开手机设置页就把电脑踢下线。

### 2. 清理：`store.purgeStalePhones(before)`

只删 `kind = 'phone' AND last_seen_at < before` 的行，同一事务里吊销该安装的
凭据、删掉它的 `pair_requests`。桌面和服务器行一律不碰（桌面行可能正被某台手机
钉着中继身份，删了会让手机一直敲 4404）。

挂在 `server.js` 已有的每小时 sweeper 上，窗口取 `DEXCLOUD_STALE_PHONE_DAYS`，
默认 7，`0` 表示关闭。

### 3. 注册路由顺带刷新

`POST /v1/installations` 命中已存在的 `clientInstanceId` 时，除了吊销旧凭据，
也更新 `name`/`platform`/`app_version`/`last_seen_at`。桌面的登录注册因此也算一次心跳。

## 不开心的边界

- **2.0.x 老版本手机**不会发心跳。它们 7 天后被清掉——正是要清的垃圾；行消失对用户
  无感（「我的电脑」只画桌面），升级或重新登录即恢复。
- 清理后手机仍保持**账号登录态**（`control_sessions` 与安装记录是两张表），
  只是列表里少一行；下次打开设置页时心跳会把行重新建出来。
- 老数据里 `kind` 缺失的行按 `desktop` 处理（既有约定），永不被清。

## 测试

`dex-cloud/test/flow.test.js`：

1. presence 对已存在的行刷新 `lastSeenAt`，不换 `id`、不发凭据。
2. presence 对被清掉的行重新建出来，`kind = "phone"`。
3. `purgeStalePhones` 删 7 天前的手机行、吊销其凭据、删其 pair_requests。
4. 同一次调用里，7 天前的**桌面**行和刚上报的手机行都还在。

## 版本

只动控制面，不需要发新版手机 App（`2.1.3` 已装机的版本在下次打开设置页时
会因为还不知道 presence 而继续不发心跳——它们会先被清一次，之后靠登录恢复）。
心跳接线放到下一次 Android 发版（2.1.4）。
