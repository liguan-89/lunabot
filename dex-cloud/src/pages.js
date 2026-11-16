import { escapeHtml } from "./http.js";

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--ink:#151515;--muted:#666;--line:#e5e5e2;--accent:#1f6feb}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#191b1e;--ink:#f2f2f0;--muted:#a0a0a0;--line:#2c2f34;--accent:#6ea8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
nav{max-width:760px;margin:0 auto;padding:20px 22px 0;display:flex;gap:18px;flex-wrap:wrap;font-size:15px}
nav a{color:var(--muted);text-decoration:none}nav a[aria-current=page]{color:var(--ink);font-weight:600}
main{max-width:760px;margin:0 auto;padding:24px 22px 80px}h1{font-size:30px;letter-spacing:-.02em;margin:0 0 8px}h2{font-size:20px;margin:36px 0 10px;scroll-margin-top:16px}h3{font-size:17px;margin:0 0 6px}p.lead{color:var(--muted);margin:0 0 28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin:14px 0}
.card h3{margin:0 0 6px;font-size:17px}.price{font-size:24px;font-weight:650;margin:8px 0}.note{color:var(--muted);font-size:14px}
label{display:block;font-size:14px;color:var(--muted);margin:14px 0 6px}input,select,textarea{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font:inherit}
textarea{min-height:140px;resize:vertical}
button{margin-top:14px;padding:12px 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
button:disabled{opacity:.6;cursor:default}
code{background:rgba(127,127,127,.14);padding:2px 6px;border-radius:6px;font-size:15px}pre{background:rgba(127,127,127,.1);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow:auto;font-size:13px}
.status{min-height:22px;color:var(--muted);font-size:14px;margin-top:12px}.ok{color:#17803d}.bad{color:#c0392b}
a{color:var(--accent)}ul,ol{padding-left:22px}li{margin:4px 0}
dl{margin:0}dt{font-weight:600;margin-top:14px}dd{margin:4px 0 0;color:var(--muted)}
footer{max-width:760px;margin:0 auto;padding:0 22px 48px;color:var(--muted);font-size:13px}
footer a{color:var(--muted)}
`;

const TABS = [
  ["/docs", "文档"],
  ["/download", "下载"],
  ["/feedback", "反馈"],
  ["/cloud", "Luna Bot Cloud"],
];

function layout(title, body, script = "", current = "") {
  const nav = TABS.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Luna Bot</title><style>${STYLE}</style></head>
<body><nav>${nav}</nav><main>${body}</main><footer>Luna Bot · 自建 Luna Bot Cloud · <a href="/docs#privacy">隐私说明</a></footer>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

const APPLY_SCRIPT = `
const $ = (id) => document.getElementById(id);
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || "request failed");
  return data;
}
`;

export function approvalPage(userCode, _config) {
  const code = escapeHtml(userCode);
  const body = `<h1>在 Luna Bot 中登录</h1>
<p class="lead">确认这台设备可以登录你的 DEX 账号。代码 <code>${code}</code>。</p>
<div class="card">
  <label for="email">邮箱</label><input id="email" type="email" autocomplete="email" placeholder="you@example.com">
  <button id="send">发送登录码</button>
  <div id="step2" hidden>
    <label for="code">邮箱里的 8 位登录码</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="12345678">
    <button id="approve">登录并批准</button>
  </div>
  <div id="status" class="status"></div>
</div>
<p class="note">Luna Bot 不会看到你的邮箱密码；登录码只用于这一次登录。</p>`;
  const script = `${APPLY_SCRIPT}
const userCode = ${JSON.stringify(userCode)};
let attempt = null;
$("send").onclick = async () => {
  $("status").textContent = "正在发送…";
  try {
    const data = await post("/api/cloud/desktop/approve/start", { userCode, email: $("email").value });
    attempt = data.attempt; $("step2").hidden = false; $("status").textContent = "登录码已发送，请查看邮箱。";
  } catch (error) { $("status").textContent = error.message; }
};
$("approve").onclick = async () => {
  $("status").textContent = "正在验证…";
  try {
    await post("/api/cloud/desktop/approve/verify", { userCode, attempt, code: $("code").value });
    $("status").textContent = "已批准。回到 Luna Bot，它会自动登录。"; $("status").className = "status ok";
    $("send").disabled = true; $("approve").disabled = true;
  } catch (error) { $("status").textContent = error.message; $("status").className = "status bad"; }
};
if (!userCode) { $("status").textContent = "缺少设备代码，请从 Luna Bot 重新打开登录页。"; }`;
  return layout("登录", body, script);
}

export function plansPage(_config, plans) {
  const cards = plans.map((plan) => `<div class="card">
  <h3>${escapeHtml(plan.name)}</h3>
  <div class="price">$${plan.priceUsd}/月</div>
  <p class="note">${escapeHtml(plan.note)}</p>
  <button data-plan="${escapeHtml(plan.tier)}">选择 ${escapeHtml(plan.name)}</button>
</div>`).join("");
  const body = `<h1>Luna Bot Cloud</h1>
<p class="lead">一个账号管理你的桌面端、手机端和云电脑。自建服务由 dexai.vip 运营。</p>
${cards}
<div id="status" class="status"></div>
<p class="note">已经有桌面端？在 Luna Bot → 设置 → Luna Bot Cloud 里直接登录即可。<a href="/docs">先看文档</a>。</p>`;
  const script = `${APPLY_SCRIPT}
for (const button of document.querySelectorAll("button[data-plan]")) {
  button.onclick = async () => {
    $("status").textContent = "正在创建订单…";
    try {
      const data = await post("/api/cloud/checkout/create", { plan: button.dataset.plan });
      location.href = data.url;
    } catch (error) { $("status").textContent = error.message; }
  };
}`;
  return layout("Luna Bot Cloud", body, script, "/cloud");
}

export function buyPage(checkoutId, plan, _config) {
  const body = `<h1>开通 ${escapeHtml(plan.name)}</h1>
<p class="lead">${escapeHtml(plan.note)} 价格 $${plan.priceUsd}/月（自建实例，本站不收取支付信息）。</p>
<div class="card">
  <label for="email">邮箱</label><input id="email" type="email" autocomplete="email" placeholder="you@example.com">
  <button id="send">发送登录码</button>
  <div id="step2" hidden>
    <label for="code">邮箱里的 8 位登录码</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12">
    <button id="activate">登录并开通</button>
  </div>
  <div id="status" class="status"></div>
</div>`;
  const script = `${APPLY_SCRIPT}
const checkoutId = ${JSON.stringify(checkoutId)};
let attempt = null;
$("send").onclick = async () => {
  $("status").textContent = "正在发送…";
  try {
    const data = await post("/api/cloud/checkout/start", { checkoutId, email: $("email").value });
    attempt = data.attempt; $("step2").hidden = false; $("status").textContent = "登录码已发送，请查看邮箱。";
  } catch (error) { $("status").textContent = error.message; }
};
$("activate").onclick = async () => {
  $("status").textContent = "正在验证…";
  try {
    await post("/api/cloud/checkout/verify", { checkoutId, attempt, code: $("code").value });
    $("status").textContent = "已开通。回到 Luna Bot，它会自动刷新。"; $("status").className = "status ok";
    $("send").disabled = true; $("activate").disabled = true;
  } catch (error) { $("status").textContent = error.message; $("status").className = "status bad"; }
};`;
  return layout("开通", body, script, "/cloud");
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(0)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function desktopFileLabel(name) {
  if (/^latest.*\.yml$/.test(name) || name.endsWith(".blockmap")) return null;
  if (name.endsWith(".dmg")) return "macOS 安装包（.dmg）";
  if (name.endsWith(".zip")) return "macOS 自动更新包（.zip）";
  if (/-setup\.exe$/i.test(name)) return "Windows 安装程序（.exe）";
  if (/\.exe$/i.test(name)) return "Windows 程序（.exe）";
  if (/\.AppImage$/i.test(name)) return "Linux 便携版（.AppImage）";
  if (/\.deb$/i.test(name)) return "Linux 安装包（.deb）";
  return "桌面端文件";
}

export function downloadPage(_config, desktopFiles = []) {
  const installers = desktopFiles.filter((file) => desktopFileLabel(file.name));
  const desktop = installers.length
    ? installers.map((file) => `<p><a href="/desktop/${encodeURIComponent(file.name)}" rel="noreferrer">${escapeHtml(desktopFileLabel(file.name))}</a> <span class="note">${escapeHtml(file.name)}${sizeLabel(file.size) ? ` · ${sizeLabel(file.size)}` : ""}</span></p>`).join("")
    : `<p class="note">这个服务器上还没有上传桌面端安装包。当前测试版本请从构建机获取。</p>`;
  const body = `<h1>下载 Luna Bot</h1>
<p class="lead">桌面端与手机端使用同一个账号。局域网、Tailscale 和配对码连接都保留。</p>
<div class="card"><h3>Android</h3><p class="note">与官方应用可同时安装，包名 <code>com.dexbot.companion</code>。</p>
<p><a href="/download/dexbot.apk">下载 APK</a></p></div>
<div class="card"><h3>桌面端</h3><p class="note">macOS 版已在本站提供；Windows 与 Linux 构建完成后也会出现在这里。</p>
${desktop}</div>
<div class="card"><h3>手机配对</h3><p class="note">桌面端 → 手机和设备，扫二维码即可；同一 Wi-Fi 或 Tailscale 下也可直接输入地址。详见 <a href="/docs#phone">手机端文档</a>。</p></div>
<div class="card"><h3>遇到问题？</h3><p class="note">先看 <a href="/docs#troubleshooting">疑难解答</a>；仍然不行就 <a href="/feedback">发一条反馈</a>。</p></div>`;
  return layout("下载", body, "", "/download");
}

function section(id, title, html) {
  return `<h2 id="${id}">${title}</h2>${html}`;
}

export function docsPage(_config) {
  const body = `<h1>Luna Bot 文档</h1>
<p class="lead">桌面端、手机端和云电脑共用一个 DEX 账号。这里说明怎么安装、登录、连接和排查问题。</p>

${section("start", "快速开始", `<div class="card"><ol>
<li>在 <a href="/download">下载页</a> 安装桌面端；需要手机时再装 Android APK。</li>
<li>打开 Luna Bot → <strong>设置 → Luna Bot Cloud</strong>，用邮箱登录。</li>
<li>第一次登录会为你创建一台 <strong>My Cloud</strong> 云电脑；桌面端会在“服务器”列表里显示它。</li>
<li>手机连电脑：桌面端打开 <strong>手机和设备</strong>，扫码即可。</li>
</ol></div>`)}

${section("account", "账号与登录", `<p>一个邮箱账号管理所有客户端：桌面端、手机端、云电脑。登录方式有两种：</p>
<dl>
<dt>邮箱登录码</dt><dd>桌面端和手机端输入邮箱，收到 8 位登录码后填回应用。登录码 10 分钟内有效，只用于这一次登录。</dd>
<dt>浏览器设备码</dt><dd>桌面端也可以打开浏览器里的批准页（<code>/cloud/desktop</code>），在同一台或另一台设备上完成登录。应用会轮询直到批准完成。</dd>
</dl>
<p class="note">测试阶段邮件投递可能延迟。没有收到时先检查垃圾邮件；仍然收不到就联系管理员从服务器日志取码。</p>`)}

${section("connect", "连接方式", `<p>桌面端可以在不同网络条件下被手机访问，按优先级选择：</p>
<dl>
<dt>局域网</dt><dd>手机和电脑在同一个 Wi-Fi。桌面端“手机和设备”里会显示地址，手机直接输入或扫码。</dd>
<dt>Tailscale</dt><dd>两端都加入同一个 Tailscale 网络，使用电脑的 MagicDNS 名称连接。不需要公网端口。</dd>
<dt>Luna Bot Cloud 云电脑</dt><dd>账号自动获得 <code>https://c-xxxx.cloud.dexai.vip</code> 地址，任何网络都能打开，不需要电脑一直开机。</dd>
<dt>配对码 / 二维码</dt><dd>桌面端生成一次性配对码，手机扫码后自动填入地址和凭据。</dd>
</dl>`)}

${section("phone", "手机端", `<div class="card"><h3>安装</h3>
<p>从 <a href="/download">下载页</a> 安装 APK。包名是 <code>com.dexbot.companion</code>，可以和官方应用同时安装，方便对比。</p>
<h3>配对</h3>
<p>桌面端 → 手机和设备 → 显示二维码；手机端 → 扫码。扫码后手机会保存这台电脑，并在后台保持连接。</p>
<h3>更新</h3>
<p>应用内提示有新版本时，会从这个服务器的 <code>/update.json</code> 读取版本、SHA-256 和 APK 地址。也可以手动重新下载 APK 覆盖安装。</p></div>`)}

${section("cloud", "云电脑", `<p>云电脑是一台跑在 Luna Bot Cloud 上的 Luna Bot，关掉自己的电脑也能继续用。</p>
<ul>
<li>首次登录后自动创建 <strong>My Cloud</strong>；创建过程通常需要 1–3 分钟，状态会显示“正在创建”并给出进度。</li>
<li>就绪后地址形如 <code>https://c-1234abcd.cloud.dexai.vip</code>，在桌面端“服务器”列表里直接打开。</li>
<li>睡眠的云电脑会在打开或配对时自动唤醒。</li>
<li>云电脑里的数据保存在独立卷中，重启容器不会丢失。</li>
</ul>
<p class="note">测试阶段计划与配额由管理员控制，不接入真实支付；一台账号默认一台云电脑。</p>`)}

${section("permissions", "权限与审批级别", `<p>每个机器人有自己的审批级别，决定它在动手前要不要问你：</p>
<dl>
<dt>Ask（逐次询问）</dt><dd>每次运行命令、改文件或访问网络前都先征求同意。默认最安全。</dd>
<dt>Edits（只审文件）</dt><dd>读写文件前询问，其他只读操作直接执行。</dd>
<dt>Auto（自动）</dt><dd>常规操作直接执行，只有高风险动作才停下来问你。</dd>
<dt>Full（完全放开）</dt><dd>不再逐次询问，机器人自主执行。只在你信任的任务上使用。</dd>
<dt>Custom（自定义）</dt><dd>按工具类别单独设置，例如允许读文件、禁止删文件。</dd>
</dl>
<p>在机器人资料页或设置里修改；修改立即生效，不需要重启会话。</p>`)}

${section("self-hosting", "自建服务器与自定义域名", `<p>Luna Bot 的服务器可以跑在你自己控制的机器上：</p>
<ol>
<li>准备一台能运行 Docker 的 Linux 服务器，以及一个指向它的域名。</li>
<li>按 <code>dex-cloud/README.md</code> 用 compose 启动服务，配置 <code>DEXCLOUD_ORIGIN</code>、邮件和中继密钥。</li>
<li>在反向代理（Caddy / Nginx）上终止 TLS，把 <code>https://你的域名</code> 转发到服务的 HTTP 端口。</li>
<li>在桌面端 <strong>设置 → 服务器 → 自定义域名</strong> 填入这个地址；应用会校验证书和健康检查后再保存。</li>
</ol>
<p class="note">自定义域名只接受 <code>https://</code>。回环地址或只在本机可用的地址会被拒绝。</p>`)}

${section("linux", "Linux 桌面", `<p>Linux 版以 AppImage 和 deb 分发。安装后从应用菜单启动，或在终端运行 <code>dexbot</code>。</p>
<ul>
<li><strong>本地控制</strong>：允许机器人操作当前桌面需要授予辅助功能/输入权限；首次开启时应用会提示需要的权限。</li>
<li><strong>Omarchy / Hyprland</strong>：实验性支持。需要先安装对应的桌面环境和 CUA 驱动，再在设置里启用本地控制。</li>
<li><strong>Wayland</strong>：部分合成器限制全局输入注入；如果控制不生效，改用 X11 会话或云电脑。</li>
</ul>
<p class="note">Linux 构建没有签名，首次运行可能提示未知发布者；请从本站下载页获取安装包。</p>`)}

${section("analytics", "使用统计", `<p>桌面端有一项可选的使用统计，默认关闭，可在 <strong>设置 → 隐私</strong> 打开或关闭。</p>
<ul>
<li>只记录功能是否被使用（例如“打开了云电脑”），不记录对话内容、文件和密钥。</li>
<li>统计发往 Luna Bot Cloud；关闭后立即停止发送，不需要重启。</li>
<li>反馈里附带的诊断信息不算统计，只有你主动发送反馈时才会包含。</li>
</ul>`)}

${section("troubleshooting", "疑难解答", `<dl>
<dt>扫码没有反应</dt><dd>确认手机和电脑在同一网络（或都加入了 Tailscale）；确认相机权限已允许；也可以手动输入地址。云电脑地址必须带 <code>https://</code>。</dd>
<dt>登录页一直显示“等待批准”</dt><dd>浏览器里的批准页还没有完成。回到批准页输入邮箱和登录码；设备码 15 分钟内有效，过期后从桌面端重新发起登录。</dd>
<dt>收不到登录码</dt><dd>检查垃圾邮件；确认邮箱拼写。测试阶段的邮件通道可能延迟，必要时由管理员从服务器日志取码。</dd>
<dt>云电脑一直“正在创建”</dt><dd>首次创建要拉取镜像并初始化数据，1–3 分钟属正常。超过 5 分钟仍在创建，点“唤醒”重试；仍然失败就发反馈。</dd>
<dt>云电脑离线</dt><dd>在服务器列表里打开它或点“唤醒”，服务会在几十秒内重启容器。</dd>
<dt>手机连不上家里电脑</dt><dd>电脑可能睡眠、换了 Wi-Fi，或防火墙拦住了端口。改用 Tailscale 或云电脑最稳。</dd>
<dt>更新失败</dt><dd>桌面端从本服务器的 <code>/desktop/</code> 读取更新源；网络受限时直接重新下载安装包覆盖安装。</dd>
<dt>数据在哪里</dt><dd>桌面端的数据在 <code>~/.dexbot</code>（Windows：<code>%USERPROFILE%\\.dexbot</code>）。云电脑的数据在服务器上的独立 Docker 卷里。</dd>
</dl>`)}

${section("privacy", "数据与隐私", `<ul>
<li>账号只保存邮箱、设备名称、平台和版本，用于登录与设备列表。</li>
<li>对话和文件默认留在你自己的电脑或云电脑里，不会上传到 Luna Bot Cloud。</li>
<li>只有你主动发送反馈时，才会把反馈正文、版本、平台和诊断信息发送到服务器；发送前应用会做密钥与 URL 参数脱敏。</li>
<li>反馈可以附上联系邮箱，仅用于回复这一条反馈。</li>
<li>退出登录后，本机保存的会话令牌失效；云电脑里的数据仍然保留。</li>
</ul>`)}

<p class="note">没有找到答案？<a href="/feedback">发一条反馈</a>，附上版本号和复现步骤。</p>`;
  return layout("文档", body, "", "/docs");
}

export function feedbackPage(_config) {
  const body = `<h1>反馈</h1>
<p class="lead">报告一个问题或提一个建议。反馈会直接进入 Luna Bot 的服务器，不需要 GitHub 账号。</p>
<div class="card">
  <label for="kind">类型</label>
  <select id="kind">
    <option value="bug">问题 / 崩溃</option>
    <option value="account">登录或账号</option>
    <option value="cloud">云电脑</option>
    <option value="phone">手机端或配对</option>
    <option value="idea">建议</option>
  </select>
  <label for="email">联系邮箱（可选）</label>
  <input id="email" type="email" autocomplete="email" placeholder="you@example.com">
  <label for="description">发生了什么</label>
  <textarea id="description" maxlength="10000" placeholder="你做了什么、期待什么、实际发生了什么。有错误提示请原文附上。"></textarea>
  <label for="version">版本（可选）</label>
  <input id="version" maxlength="40" placeholder="例如 2.0.0">
  <div hidden><label for="website">网站</label><input id="website" tabindex="-1" autocomplete="off"></div>
  <button id="send">发送反馈</button>
  <div id="status" class="status"></div>
</div>
<p class="note">不要把密码、令牌或私密文件贴进反馈。应用内 <code>@devs</code> 反馈会自动附带脱敏后的诊断信息。</p>`;
  const script = `${APPLY_SCRIPT}
const installKey = "dexbot.web.install";
let installId = "";
try { installId = localStorage.getItem(installKey) || ""; } catch {}
if (!installId) {
  const bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
  installId = "web-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem(installKey, installId); } catch {}
}
$("send").onclick = async () => {
  const description = $("description").value.trim();
  if (description.length < 10) { $("status").textContent = "请至少写 10 个字，说明发生了什么。"; $("status").className = "status bad"; return; }
  if ($("website").value) { $("status").textContent = "已收到，谢谢。"; return; }
  $("status").textContent = "正在发送…"; $("status").className = "status";
  const kind = $("kind").value;
  const email = $("email").value.trim();
  try {
    const data = await post("/api/bug-reports", {
      installId,
      source: "web",
      description: "[" + kind + "] " + description,
      appVersion: $("version").value.trim() || "web",
      platform: "web",
      diagnostics: JSON.stringify({ kind, page: location.href, userAgent: navigator.userAgent, language: navigator.language }),
      ...(email ? { contactEmail: email } : {}),
    });
    $("status").textContent = "已收到，编号 " + data.id + "。谢谢！"; $("status").className = "status ok";
    $("send").disabled = true;
  } catch (error) { $("status").textContent = error.message === "limited" ? "发送太频繁，请稍后再试。" : "发送失败：" + error.message; $("status").className = "status bad"; }
};`;
  return layout("反馈", body, script, "/feedback");
}

export function provisionPage(cloud) {
  const status = cloud.status === "ready" ? "已经就绪" : cloud.status === "offline" ? "暂时离线" : "正在创建";
  const body = `<h1>${escapeHtml(cloud.name)}</h1>
<p class="lead">Luna Bot Cloud 正在为你准备这台云电脑。当前状态：<strong>${escapeHtml(status)}</strong>。</p>
<div class="card">
  <h3>接下来</h3>
  <p class="note">回到 Luna Bot 的“服务器”列表，云电脑就绪后会自动出现。首次打开时用同一账号登录即可。</p>
  <p class="note">地址：<code>${escapeHtml(cloud.origin || cloud.hostname || "")}</code></p>
</div>
<p><a href="/cloud">返回 Luna Bot Cloud</a></p>`;
  return layout("创建云电脑", body, "", "/cloud");
}

export function errorPage(message) {
  return layout("出错了", `<h1>出错了</h1><p class="lead">${escapeHtml(message)}</p><p><a href="/docs">看看文档</a> 或 <a href="/feedback">发一条反馈</a>。</p>`);
}
