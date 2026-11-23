# 更新签名收口：macOS adhoc 走安装镜像交接，Android 渠道定 release 密钥

日期：2026-11-23 · 分支：`fix/update-signing` · 状态：实施中

## 背景（两端故障的实证）

**桌面（macOS）**：应用内更新四次失败（updater.log 2026-11-22~23），真实错误是
Squirrel.Mac 安装前校验：`Code signature … did not pass validation: 代码未能满足
指定的代码要求`。本机 2.1.5 与线上 2.1.6 全部是 adhoc 签名（无 Apple 开发者
证书），已装 app 的指定要求是 `designated => cdhash H"…"`——身份就是那一个
构建的哈希，任何新构建都不可能通过。结论：**不买证书的前提下，Squirrel 这条
自动安装路对 adhoc 安装永久失效**，每个版本都会报「更新未通过校验」。

**Android**：发布页 2.1.4（`desktop/LUNABOT-2.1.4-android-arm64.apk`）是
release 密钥签的（`1409d4a2…`，11-22 配好 `~/.lunabot-keys/release.p12` 后的
`assembleRelease` 产物），而渠道 `dexbot.apk` 与 2.1.5/2.1.6 全部是 debug
密钥（`bd2ccc9a…`，本机 `~/.android/debug.keystore`）。装过发布页 2.1.4 的
手机升 2.1.5/2.1.6 即签名冲突。根因：`dist` 构建类型写死
`signingConfig = signingConfigs.getByName("debug")`。

## 拍板（用户，2026-11-23）

1. macOS 不购买 Apple 开发者证书。adhoc 安装改走**安装镜像交接**：检测到
   adhoc 时不再让 Squirrel 下载 zip，而是自己下载 **DMG**、按 feed 的 sha512
   校验后打开，用户把 app 拖进「应用程序」完成更新。
2. Android 以 **release 密钥为唯一渠道签名**：`dist` 优先用 release 签名材料
   （无材料时回退 debug 并打警告，保住贡献者/README 验证流）。线上 2.1.6 用
   release 密钥重发；debug 密钥安装的手机需一次性卸载重装（换钥匙的必然代价）。

## macOS 实现要点

- `electron/app-signing.mjs`（新）：`appSignatureKind(execPath, runner)` 用
  `codesign -dv` 的 stderr 判 `Signature=adhoc` / `flags=…(adhoc`；解析不出
  （或非 darwin）返回 "unknown"，**fail-open 走原路**（不比现状差）。
- `electron/image-update.mjs`（新）：`createImageUpdateCoordinator`——复用
  electron-updater 只做**检查**（`checkForUpdates` + `update-available` 事件，
  `autoDownload=false`，永不调 `downloadUpdate`，Squirrel 原生 staging 完全不
  启动）。从 `info.files` 里挑 `.dmg` 条目，基址读 `process.resourcesPath/
  app-update.yml` 的 `url:`（vendor 的 `getFeedURL()` 是弃用桩）。下载到
  `userData/pending-image/<文件名>`（.part 原子落位），按 feed 条目的
  sha512(base64) 校验；命中缓存且校验一致则直接进 downloaded。`install()` 走
  注入的 `openPath`（即 `shell.openPath`）挂载镜像 → `handed-off`。错误统一
  过 `update-errors.mjs` 映射（sha 不符抛 `ERR_UPDATER_CHECKSUM_MISMATCH` →
  integrity 文案）；镜像交接没有 Squirrel 的半安装态，全部可重试。
- `electron/updater.mjs`：`startUpdater` 在 darwin 且 adhoc 时改走 image
  模式：`installMode: "image"`、不建 quiet install（不可能自装）、15s/每小时
  检查照旧；IPC 的 check/install 指向当前 controller。非 adhoc 的 mac 与
  Windows/Linux 行为零变化。
- UI：`installMode` 增加 `"image"` 值，四件（UpdateBanner / UpdateCard /
  UpdatesRow / SidebarProfileMenu）加镜像交接措辞分支。新键 en+zh：
  `update.image.readyNote / open / opening / openedTitle`、
  `settings.updates.readyImage / openingImage`、`sidebar.update.readyImage /
  openingImage`，主进程共享键 `native.update.imageOpened / imageOpenFailed /
  imageNoDmg`（native.* 前缀按 native-text 规则进全部语言包）。i18n:check 的
  `requireComplete` 默认关闭，其余语言回退英文合法。

## Android 实现要点

- `android/app/build.gradle.kts` `create("dist")`：
  `signingConfig = signingConfigs.findByName("release") ?: getByName("debug")`
  ——release 材料在场（维护者机器/CI secrets）即 release 签名；缺失回退
  debug 并 `logger.warn` 点名「此产物不可上渠道」。CI 不构建任何 Android 包
  （已核 workflow），回退只影响贡献者本机验证。
- 文档同步：android/README.md、android/PlayStore/README.md、README(.zh-CN)
  的 dist 段落改为 release 签名口径 + 上渠道前 `apksigner verify --print-certs`
  检查。

## 重发 2.1.6（release 签名）

同一棵树（`7779a7a52a`，即 v2.1.6 发布 pin）在 worktree 里 `assembleDist`
出 release 签名 APK → 本地 `apksigner`（期望 `1409d4a2…`，v2+v3）+ aapt2
（2.1.6/20106）核验 → 上服务器：`dexbot.apk` 换新（旧 debug 包备份
`.bak-2.1.6-debug`）、`desktop/LUNABOT-2.1.6-android-arm64.apk` 换新（旧包
备份同后缀）、`update.json` 重写 size/sha256 并在 notes 注明换签名需卸载
重装一次 → 公网 curl 复核。桌面端 dmg/zip 与三份 yml 不动。

## 验证

- T0：`node --test electron/app-signing.node-test.mjs electron/image-update.node-test.mjs`
  + `pnpm exec vitest run <改动 UI 测试>` + `pnpm exec oxlint --deny-warnings <改动文件>`。
- T1：`pnpm typecheck` + electron 全套 node-test + `pnpm i18n:check` +
  locales 目录定向测试（sent-keys/native-keys/everyday-words/data-keys）。
- Android：`:app:assembleDist` 产物 apksigner/aapt2 双核验（release 密钥）。
- 真机：PLZ110 装发布页 2.1.4（release）→ 应用内升级新 2.1.6 应直接通过。
