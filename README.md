<div align="center">

# Luna Bot

**本地优先的 AI 智能体聊天应用：每个聊天都是一个真正能干活的机器人。**

[**cloud.dexai.vip**](https://cloud.dexai.vip) &nbsp;·&nbsp; [下载](https://cloud.dexai.vip/download) &nbsp;·&nbsp; [文档](https://cloud.dexai.vip/docs) &nbsp;·&nbsp; [反馈](https://cloud.dexai.vip/feedback)

<sub>Luna Bot 是 **OpenMausBot** 的独立分支（fork），保留上游 Apache-2.0 许可证与版权归属。
Luna Bot 与 xAI、Meta、OpenAI、Manus 或 OpenMausBot 维护者无关联。</sub>

</div>

---

## 下载

| 平台 | 安装包 | 说明 |
|---|---|---|
| macOS（Apple 芯片） | [下载页](https://cloud.dexai.vip/download) | arm64 DMG，拖到「应用程序」即可 |
| Android（arm64） | [dexbot.apk](https://cloud.dexai.vip/download/dexbot.apk) | 手机伴侣应用，可与桌面端配对 |

开发阶段只构建 macOS arm64 与 Android arm64；Windows / Linux 和 macOS x64 的配置保留，但暂不产出。

> macOS 构建目前使用 ad-hoc 签名，尚未使用 Developer ID 公证。首次打开若被 Gatekeeper
> 拦截，请在「系统设置 → 隐私与安全性」中允许，或右键应用选择「打开」。

## 这是什么

Luna Bot 把 AI 智能体做成通讯录里的联系人：侧栏里的每个机器人都可以有自己的性格、模型、
工作目录、已连接应用和云端电脑。你可以像发消息一样给它派活，看它执行，并在关键操作前审批。

- **机器人真的会动手**：读写文件、运行命令、操作浏览器、使用已连接的应用。
- **模型按机器人选择**：内置唯一的智能体引擎 pi；模型来自 pi 自身配置，或设置里唯一的
  自定义提供方（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages）。
- **本地优先**：桌面端内置服务器，对话、密钥和运行记录默认留在自己的电脑上。
- **Luna Bot Cloud**：用邮箱验证码登录后，同一账号可以管理自己的云电脑、桌面端和手机；
  云电脑在 Luna Bot Cloud 上运行，关掉本地电脑也能继续工作。
- **手机配对**：扫码或输入 12 位配对码，把 Android 手机接到同一台电脑或同一个 Cloud；
  也支持局域网和 Tailscale。
- **审批与提问**：命令、文件修改和敏感操作会变成聊天里的卡片，由你决定是否放行。

## 快速开始

1. 安装 macOS 应用并打开。
2. 按引导登录或注册 Luna Bot Cloud 账号（邮箱验证码）。
3. 在「设置 → Luna Bot Cloud」中确认 Cloud 状态；需要云电脑时按引导开通。
4. 在「设置 → Luna Bot Cloud → 配对手机」生成二维码或配对码。
5. 在 Android 上安装 `dexbot.apk`，登录同一账号，或扫描二维码 / 输入配对码。

桌面端和手机端使用同一个 Luna Bot Cloud 账号，因此不需要分别记两套凭据。没有 Cloud 账号时，
也可以只在本机使用桌面端。

## 从源码运行

要求：Node 24+、pnpm，以及 pi CLI
（`npm install -g @earendil-works/pi-coding-agent`）。

```sh
pnpm install

pnpm dev:server     # 内置服务器 → 127.0.0.1:8799
pnpm dev            # 网页界面 → 127.0.0.1:5199
pnpm dev:desktop    # Electron 外壳（保持上面两个命令运行）
```

常用检查与打包：

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm package:mac    # macOS arm64 DMG + ZIP，需要 Xcode / Swift 工具
```

Android：

```sh
cd android
./gradlew :core:test :app:testDebugUnitTest :app:assembleDebug :app:assembleDist
```

更多开发说明见 [`docs/`](docs/) 与 [`android/README.md`](android/README.md)。这些文档中
仍有一部分沿用上游 OpenMausBot 的术语和截图，品牌迁移尚未全部完成。

## 架构

两进程结构：

- `electron/`：桌面外壳、窗口、托盘、更新、云账号和手机伴侣的生命周期。
- `server/`：内置 harness 服务器，负责机器人、对话、审批、模型、浏览器、云电脑和触发器。
- `src/`：React 聊天界面，通过 HTTP + SSE 与服务器通信。
- `android/`：Kotlin / Compose 手机伴侣。
- `dex-cloud/`：Luna Bot Cloud 控制面，负责账号、云电脑开通、配对码和下载页。

服务器只监听本机回环地址；需要从其他设备访问时，通过配对、局域网、Tailscale 或
Luna Bot Cloud 显式开启，不会默认暴露到公网。

## 许可与归属

- 本项目使用 [Apache License 2.0](LICENSE)。
- 原项目版权归 Milind Soni 与 OpenMausBot 贡献者所有，详见 [NOTICE](NOTICE)。
- `enterprise/` 目录按[其自身许可证](enterprise/LICENSE)提供；删除该目录后剩余部分即为开源版本。
- 打包的第三方组件（Cua Driver、cloudflared、DuckDB、OpenCode、T3 Code 等）保留各自的
  许可证与声明，随安装包一同分发。

Luna Bot 是独立分支，不是 OpenMausBot 官方发行版；上游项目的文档、issue 和发布渠道
不适用于本项目的安装包与 Cloud 服务。
