# 自托管云桌面：彻底移除 Boat，Cloud desktop 改走 VPS

## 决策

用户已拍板：

1. **桌面来源两者都要**：
   - 现有 BYO VPS 路线保留：用户自己的 Linux VPS，由 Docker-over-SSH 管理每 bot 一个桌面容器；
   - dex-cloud 增加托管桌面容量：运营者自己的桌面 VPS 池为 hosted Cloud home 提供同款 VPS 桌面。
2. **彻底删除 Boat 支持**：删除 Boat key、box 后端、included Boat、Boat relay/翻译层、相关 UI 配置与测试。这里只指外部 boat.dev 云桌面；`server/bot-box/` 是 Luna Bot 自己的进程沙箱，名字相似但完全无关，保留。

本页取代刚才的 Boat relay 设计；不再实现 `/api/cloud/services/boat/...`，也不需要 Boat API key。

## 关键事实

- `server/vps-computer.ts` 已经有完整 VPS 桌面实现：Docker-over-SSH、每 bot 一个 hardened Cua/XFCE 容器、创建/启动/停止/删除、MCP 屏幕工具、截图、noVNC 隧道、inventory 与生命周期测试。云桌面重构必须复用它，不再发明第二套桌面自动化。
- Cloud home 镜像当前没有 `ssh` 和 Docker CLI；也没有自动写入 VPS SSH key/config 的机制。
- dex-cloud 当前只 provision Cloud home 容器，不知道任何桌面主机；README 也明确 per-Cloud network isolation 尚未实现。
- 不能把宿主机 rootful Docker daemon 直接暴露给多个 Cloud home：能操作 Docker 就等价于宿主机 root，可跨租户读写其它容器和卷。托管路线必须做租户隔离。
- rootless Docker-in-Docker 仍需要 `--privileged`（Docker 官方文档），所以“每台 Cloud 一个 DinD 容器”不是安全的多租户方案，不采用。
- 选择的安全边界：**专用桌面 VPS + 每台 Cloud 一个 Linux 租户用户 + 该用户自己的 rootless Docker daemon**。Cloud home 只拿到这个受限用户的 SSH key；即使 key 被 bot 读到，也只能控制该 Cloud 自己的 rootless Docker，不控制宿主机或其它租户。
- rootless Docker 的容器 IP 通常不能像 rootful bridge 那样从宿主机直接访问，noVNC 直播路径需要单独验证；预计要允许仅绑定 `127.0.0.1` 的容器端口，并让 VPS viewer 走该 loopback 端口，而不是容器 private IP。这个验证是托管路线的第一技术关口。

## 名词与兼容迁移

- “Cloud desktop”在产品里仍叫云端桌面，但 provider 只有 VPS；不再有 Boat/box backend 选择。
- `cloudBackend` 是历史 wire/config 字段。第一步先让 `vps` 成为唯一有效值；存量 `box` 在读取时迁移/清除，bot 的 `computer:"cloud"` 保留，含义变为 VPS 桌面。
- 存量 Boat 桌面无法迁移：升级后不再能操作 boat.dev 里的机器。升级文案/文档要说明用户需先在 boat.dev 手动清理；Luna Bot 不再保存或使用 Boat key。
- team shared computers 当前是 Boat-backed。功能不删除，改为用同一 VPS 后端：`teamComputerOwner(id)` 作为 VPS owner id  provisioning 一台 VPS 容器。这个移植如果阻塞主线，先显式隐藏创建入口，不允许保留半坏的 Boat 路径。

## 分阶段实施

### 阶段 A：VPS-only 产品化，删除 Boat

1. 删除 Boat provider 实现与状态：
   - `server/boat*.ts`、Boat create/delete journal、Boat inventory/lifecycle/provision/screenshot/wait 测试；
   - `server/boat-relay.ts` 与 included Boat relay 测试；
   - `config.box` / `BOX_TOKEN` / `LUNABOT_BOAT_API` / `LUNABOT_CLOUD_BOAT_*`；
   - `included-services.ts` 里的 Boat credential，只保留 voice/decider/x 等其它 included services。
2. 改 cloud backend 合同：
   - `shared/wire.ts` 的 `CloudBackend` 只保留 `"vps"`，或彻底移除该字段（按编译错误选更小改动）；
   - store migration 把旧 `box` 清掉；PATCH 不再接受 `box`；
   - `cloudBackendChangeError`、bot patch、new-bot defaults、desktop update tests 同步。
3. 改 turn routing：
   - explicit/Auto cloud 只走 `mountBotVps`；
   - 删除 `mountBotBoat`、`attachTeamBoat`、Boat lifecycle/recovery/auto-sleep/host power 中的 Boat 分支；
   - team computers 改为 VPS provisioning，复用 `vpsComputerAction` / `vpsComputerMcp` / `vpsComputerScreenshot`。
4. 改 routes/UI：
   - 删除 Settings → API keys 的 Boat key panel；
   - 删除 `CloudBackendPicker` 或把它变成纯 VPS 说明（优先删除选择器，因为没有第二个 backend）；
   - Works on / Place 文案不再提 Boat；无 VPS 时指引到 VPS 设置；
   - usage/computers frames/inventory 只统计 VPS；
   - i18n 全语言去掉 Boat key/cloud backend 文案，保留历史 verification evidence 不动。
5. 文档：
   - `docs/cloud-pro.md` 删除 “Included Boat computers”；
   - `docs/byo-vps.md` 成为唯一云端桌面使用文档；
   - release/migration notes 说明 Boat key 与旧 Boat 桌面不再可用。

验证目标：无 Boat env/key 时，self-hosted server 配置 VPS alias 后 explicit Cloud、Auto cloud、team computer、screenshot、viewer、删除 inventory 的定向测试通过；任何 `boat`/`BOX_TOKEN` 只剩历史文档或无关 `bot-box` 语境。

### 阶段 B：Cloud home 能使用 VPS

1. Cloud home 镜像安装：
   - `openssh-client`；
   - Docker CLI（官方 Debian repo 的 `docker-ce-cli`，pin 一个已发布版本；只装 CLI，不装 daemon）。
2. 增加 Cloud home boot contract：
   - 非 secret env：`LUNABOT_CLOUD_DESKTOP_SSH_ALIAS`、`LUNABOT_CLOUD_DESKTOP_SSH_HOST`、`LUNABOT_CLOUD_DESKTOP_SSH_PORT`、`LUNABOT_CLOUD_DESKTOP_SSH_USER`；
   - secret：`LUNABOT_CLOUD_DESKTOP_SSH_PRIVATE_KEY`、`LUNABOT_CLOUD_DESKTOP_SSH_KNOWN_HOSTS`。
3. `cloud-home-start` 在准备 `/data` 时写入：
   - `/data/.ssh/config` 的 managed host block；
   - `/data/.ssh/dexcloud-desktop`（0600）；
   - `/data/.ssh/known_hosts`（0600）。
   写入要原子、root 初始化后 chown 给 `lunabot`，并允许用户自己的 config host 先赢（沿用 `vps-ssh.ts` Include 顺序）。
4. server config resolution：
   - `vps.sshAlias` 仍是用户自己的 BYO alias，优先；
   - 没有用户 alias 且 managed env 存在时回落到 `LUNABOT_CLOUD_DESKTOP_SSH_ALIAS`；
   - config status 增加 `included/managed` 标记，UI 能区分“Cloud 附带桌面主机”和“自己的 VPS”。
5. Cloud home 默认 Auto/explicit cloud 使用这个 managed alias；用户保存自己的 alias 后覆盖它。

验证目标：Cloud home 容器内 `docker -H ssh://<managed-alias> version` 通；无用户配置时 VPS status ready；保存用户 alias 后走用户主机。

### 阶段 C：dex-cloud 托管桌面 VPS 池

1. 新增 `dex-cloud/desktop-host/`，提供运营者在一台**专用 Ubuntu 22.04/24.04 x86_64 VPS** 上执行的安装脚本。该主机不运行 Cloud home、账号服务或其它控制面。
2. 安装脚本负责：
   - 安装/校验 `uidmap`、`slirp4netns`、`fuse-overlayfs`、`docker-ce-rootless-extras`、OpenSSH；
   - 创建固定数量 tenant users（如 `dxd0`…`dxdN`），配置 subuid/subgid；
   - 为每个 tenant user 生成 concrete systemd service，直接 supervision `dockerd-rootless.sh`，`Delegate=yes`，并设置 tenant 总 `MemoryMax`/`CPUQuota`；
   - 安装 forced-command wrapper：只允许 `docker system dial-stdio`；禁止 shell/scp/sftp/agent forwarding；viewer 所需端口转发单独最小化；
   - 安装 provisioning helper，只允许 dex-cloud provision 用户通过 sudo 执行固定命令。
3. dex-cloud config 增加：
   - `LUNABOT_CLOUD_DESKTOP_HOST`、`DESKTOP_SSH_PORT`、`DESKTOP_PROVISION_USER`、`DESKTOP_PROVISION_KEY(_FILE)`、`DESKTOP_HOST_PUBLIC_KEY`、slot/capacity/resource env；
   - 未配置时 managed desktop 关闭，BYO VPS 不受影响。
4. provisioner 流程：
   - 生成 per-Cloud ed25519 client key；
   - 通过 provisioning SSH 调 helper 分配 free tenant slot、安装 forced-command authorized key；
   - 把 alias/host/user/private key/known_hosts 注入 Cloud home boot contract；
   - Cloud 删除时调用 helper 清除 key、停止并删除该 tenant 的容器、释放 slot；
   - re-provision 保留同一 slot/user，轮换 client key。
5. store schema 增加 desktop assignment 字段/表：`cloud_id`、host、slot/user、key fingerprint、assigned_at、released_at。库中绝不存 private key；private key 只传给该 Cloud home 容器。
6. 成本控制：
   - 第一阶段以 tenant cgroup 总量限制为主（CPU/memory/pids），防止一个 Cloud 挤爆桌面宿主机；
   - server 侧沿用/补齐 cloud computer at-once 计数逻辑，避免无上限 bot 桌面；
   - 不做虚假“小时计费”，文档明确自托管成本由运营者主机容量承担。

第一技术验证（先于大规模接线）：在一台桌面 VPS 上手工跑安装脚本，证明 rootless Docker 能 build/pull/run pinned Cua image、`docker exec` MCP 可用、loopback-only noVNC viewer 可用。若 rootless 网络不满足 viewer，先改 VPS viewer，再接 dex-cloud。

### 阶段 D：部署与迁移

1. 先在测试/桌面 VPS 验证 host install，再部署 dex-cloud。
2. 重建 Cloud home image（含 ssh/docker CLI）并 promote。
3. 对现有 Cloud 触发 re-provision（保留 volume），让新 env/secrets 生效。
4. 端到端验证：创建 bot → explicit Cloud desktop → provisioning → screenshot → file/background command → sleep/wake → viewer。
5. 生产当前 VPS 只有 8GB RAM、磁盘约 8.4GB 可用，不适合作为长期桌面池；它可以做一次性 smoke，不应作为正式容量。正式桌面池建议单独 VPS，按每台 tenant desktop 2 CPU/4GB 预算。

## 明确不做

- 不实现 Boat-compatible relay；不保留 boat.dev API client。
- 不把宿主机 rootful Docker socket 挂进 Cloud home。
- 不用 privileged DinD 当多租户隔离边界。
- 不在第一阶段实现多桌面 host 调度、真实计费、跨 host migration；单个配置的桌面 host + 固定 slots 即可。
- 不删除历史 verification evidence 或上游审计文档里的 Boat 记录；只删除当前产品支持与运行依赖。

## 当前最大风险

1. rootless Docker 与 `vps-computer.ts` 的兼容性（尤其 noVNC private IP/端口、cgroup limits、`--cgroupns private`）尚未实测。
2. systemd-wide 监督 rootless docker 虽可运行 direct `dockerd-rootless.sh`，但 Docker 官方更推荐 user systemd；安装脚本必须在目标 Ubuntu 版本实测，不行就切到 per-user systemd + linger。
3. Boat 删除面很大，尤其 team computers、usage、place/copy、测试 fixtures；必须小步提交并用 typecheck/定向测试收敛，不能一把梭。
