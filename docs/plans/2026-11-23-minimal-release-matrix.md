# 最小化发布矩阵 + 服务器只留最新版

日期：2026-11-23 · 分支：`chore/minimal-release-matrix` · 状态：实施中

## 背景与拍板（用户，2026-11-23）

现发布矩阵每版在 GitHub + 服务器各存 ~2.3G：mac dmg+zip、win nsis（另有
未上线的 zip target）、linux AppImage+deb+rpm、android apk 手工渠道。
服务器 `downloads/desktop/` 已囤 4 个版本共 49 文件 ~8.3G，整机磁盘 82%。

拍板：

1. 构建只留四个产物：macOS arm64 **dmg+zip**（zip 保留——Squirrel 标准件，
   将来买证书可直接用）、Windows x64 **setup.exe**、Linux x64 **仅 .deb**、
   Android arm64 APK（本就不进 GitHub release，走渠道手工上）。
   Linux 选 deb 的理由：Ubuntu/Debian 生态同时覆盖服务器与桌面 Linux 主流，
   `apt install` 是标准路径；AppImage 是桌面免安装方案对服务器无意义，
   rpm 只覆盖 Fedora/RHEL 系份额小。
2. 服务器 feed 每版只留最新一版全套：发版上传后删除旧版本
   `LUNABOT-X.Y.Z-*`，保留当前版版本化文件 + 稳定名 + `latest*.yml` +
   `SHA256SUMS-ubuntu-x64.txt`。
3. Android 渠道 `dexbot.apk` / `update.json` 只留当前，`.bak-*` 换包时
   全清、不再累积。

## 目标产物矩阵

| 平台 | 产物 | 备注 |
| --- | --- | --- |
| macOS arm64 | `LUNABOT-<v>-arm64.dmg` + `.blockmap`、`-arm64.zip` + `.blockmap` | 不变 |
| Windows x64 | `LUNABOT-<v>-setup.exe` + `.blockmap` | 顺手删 win zip target（本就不上传，纯省 CI 时间） |
| Linux x64 | `LUNABOT-<v>-amd64.deb` | 砍 AppImage/rpm，每版省 ~560MB |
| Android arm64 | `dexbot.apk` + `desktop/LUNABOT-<v>-android-arm64.apk` | 渠道手工上，不进 GH release |

GitHub assets 18 → 14：版本化 9→7、稳定名 5→3（`LUNABOT.dmg` /
`LUNABOT-setup.exe` / `LUNABOT-amd64.deb`）、3 个 yml + SHA256SUMS 不变。

**Linux 自动更新不受影响**：fork 的 vendored electron-updater 6.8.9 自带
`DebUpdater`（`resources/package-type` = `deb` 路由，读 `latest-linux.yml`），
deb 安装走包管理器升级链路；被砍的 AppImage/rpm 存量用户失去对应格式的
更新通道，GitHub 旧 release 资产保留可手动下载（用户已知悉并拍板）。

## 改动清单

1. `electron-builder.yml`：`linux.target` 删 AppImage/rpm 只留 deb；
   `win.target` 删 zip；删 `rpm:` 配置段与 `toolsets.appimage`（只被
   AppImage 用）；`pacman:` 段保留（`package:arch` 独立使用，不在发布矩阵）。
2. `.github/workflows/release.yml`：
   - linux job：稳定名复制与 `SHA256SUMS-ubuntu-x64.txt` 只算 deb 两份；
     `upload-artifact` path 只留 `*.deb` + sums + `latest-linux.yml`；
     `pnpm smoke:linux-package` 依赖 AppImage → 改对 `release/linux-unpacked`
     或已装 deb 跑 `smoke-linux-package.mjs`（支持 `LUNABOT_SMOKE_EXECUTABLE`）。
   - assemble job：`required` 列表与 feed 校验 `expectedUrls` 同步减项。
   - **核查结论**：app-builder-lib 26.15.3 的 `getUpdateInfoFileName` 按
     平台生成 `latest-linux.yml`，deb 产物同样触发 update-info 任务——
     deb-only 下 yml 照常生成，无需摘除。
3. `scripts/verify-linux-package.mjs`：删 AppImage/rpm 断言（exactlyOne
   .AppImage/.rpm、rpm 元数据与 scriptlet、AppImage 解包验证）。
4. `scripts/run-linux-package-smoke.mjs`：不再断言「恰好一个 AppImage」，
   改跑 `release/linux-unpacked/lunabot`；SIGTERM/SIGKILL 生命周期测试
   同样改指 unpacked 可执行文件。`scripts/smoke-linux-update.mjs`（仅服务
   于 AppImage 更新链路的手工诊断）与 `package.json` 的 `smoke:linux-update`
   一并删除。
5. `scripts/bundle-updater.mjs` + `patch-appimage-updater.mjs`：**实施期
   决定保留**。vendored electron-updater 的 `AppImageUpdater` 代码无论如何
   都在 bundle 里，patch 修的是上游真实的 launcher 孤儿 bug；服务器上仍
   可下载的 2.1.7 AppImage 及任何手工 AppImage 构建都受其保护。摘除只省
   构建期几毫秒，却要重写 ~330 行 updater 测试，得不偿失。
6. `.github/workflows/package-linux.yml` + `ci.yml` 的 `package-linux` job：
   同步减项（job 名、apt 工具清单、AppImage 断言与稳定名段、artifact path）。
7. 新增 `scripts/publish-desktop-feed.mjs`（`pnpm publish:feed`）：输入
   组装后的 assets 目录 → rsync 精确资产集到
   `wholesale:/opt/dex-cloud/data/downloads/desktop/` → 删除所有不在本次
   上传清单内的 `LUNABOT-<semver>-*`（不仅限旧版本——同版本的 AppImage/rpm
   残留同样清掉）→ `--apk` 时换 `downloads/dexbot.apk`、按 APK 字节重写
   `update.json`（versionCode=MAJOR*10000+MINOR*100+PATCH，沿用
   `?v=<versionCode>` 缓存戳），并删 `downloads/` 下 `*.bak-*` → curl 复核
   三份 yml 与 update.json。`--dry-run` 只打印 put/delete/keep 清单。
   宿主与路径走 `LUNABOT_PUBLISH_HOST` / `LUNABOT_PUBLISH_DATA_DIR` /
   `LUNABOT_FEED_BASE` 环境变量覆盖。
8. 文档：`docs/releasing.md`（矩阵、14 assets、`publish:feed` 步骤）、
   `docs/linux-desktop.md`（DEB-only 全文）、`docs/cloud-pro.md`、
   `docs/browser-packaging.md` 同步。

## 服务器留存规则（`/opt/dex-cloud/data/downloads/`）

- `desktop/` 保留：当前版 `LUNABOT-<v>-*`（版本化 7 件 + android apk）、
  稳定名 3 件、`latest-mac.yml`/`latest.yml`/`latest-linux.yml`、
  `SHA256SUMS-ubuntu-x64.txt`。
- `desktop/` 删除：所有 `LUNABOT-<旧版>-*`。
- 顶层删除：`dexbot.apk.bak-*`、`update.json.bak-*`（换包时全清）。
- GitHub 旧 release 资产不动（发布记录，非服务器）。

## 一次性清理（实施时另行确认，属破坏性操作）

- `desktop/` 删 2.1.4–2.1.6 全部版本化文件（留 2.1.7 全套）→ 省 ~5G
- `downloads/` 删全部 `.bak-*` → 省 ~220MB
- `data/desktop-archive-2.0.0/`、`data/incoming-2.0.3/`（42MB 疑似残缺
  dmg）→ 评估后删
- 清理后 `/opt/dex-cloud` 占用预计 40G → ~33G

## 影响与风险

- AppImage/rpm 存量用户失去该格式更新通道；旧版本直链 404（用户拍板接受）。
- `release.yml` 的 verify/feed-check 是硬门禁，required 列表与三 feed
  `expectedUrls` 必须同步改漏一处 CI 即红。
- win zip target 删除只省 CI 时间，产物本就不上传。
- Android `.bak-*` 全清后服务器端无回滚副本；回滚靠本地/CI 留存的 APK
  产物重传，`publish:feed --apk` 重跑即可。

## 验证

- T0：改动文件对应测试 + `pnpm exec oxlint --deny-warnings <改动文件>`
- T1：`pnpm typecheck` + `pnpm exec vitest run <相关目录>` + electron
  node-test（bundle-updater/vendor-updater 链路）
- 真实验证：下次 release.yml 全程；发布前可本地 `pnpm package:linux`
  验证 deb-only 产物（耗时长，或交 CI 首跑把关）
- 服务器脚本：先 `--dry-run` 人工确认删除清单再执行
