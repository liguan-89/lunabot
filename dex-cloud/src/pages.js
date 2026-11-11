import { escapeHtml } from "./http.js";

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--ink:#151515;--muted:#666;--line:#e5e5e2;--accent:#1f6feb}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#191b1e;--ink:#f2f2f0;--muted:#a0a0a0;--line:#2c2f34;--accent:#6ea8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:48px 22px 80px}h1{font-size:30px;letter-spacing:-.02em;margin:0 0 8px}h2{font-size:18px;margin:32px 0 10px}p.lead{color:var(--muted);margin:0 0 28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin:14px 0}
.card h3{margin:0 0 6px;font-size:17px}.price{font-size:24px;font-weight:650;margin:8px 0}.note{color:var(--muted);font-size:14px}
label{display:block;font-size:14px;color:var(--muted);margin:14px 0 6px}input{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font:inherit}
button{margin-top:14px;padding:12px 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
code{background:rgba(127,127,127,.14);padding:2px 6px;border-radius:6px;font-size:15px}.status{min-height:22px;color:var(--muted);font-size:14px;margin-top:12px}.ok{color:#17803d}.bad{color:#c0392b}
a{color:var(--accent)}ul{padding-left:20px}
`;

function layout(title, body, script = "") {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · DEX BOT</title><style>${STYLE}</style></head>
<body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
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
  const body = `<h1>在 DEX BOT 中登录</h1>
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
<p class="note">DEX BOT 不会看到你的邮箱密码；登录码只用于这一次登录。</p>`;
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
    $("status").textContent = "已批准。回到 DEX BOT，它会自动登录。"; $("status").className = "status ok";
    $("send").disabled = true; $("approve").disabled = true;
  } catch (error) { $("status").textContent = error.message; $("status").className = "status bad"; }
};
if (!userCode) { $("status").textContent = "缺少设备代码，请从 DEX BOT 重新打开登录页。"; }`;
  return layout("登录", body, script);
}

export function plansPage(_config, plans) {
  const cards = plans.map((plan) => `<div class="card">
  <h3>${escapeHtml(plan.name)}</h3>
  <div class="price">$${plan.priceUsd}/月</div>
  <p class="note">${escapeHtml(plan.note)}</p>
  <button data-plan="${escapeHtml(plan.tier)}">选择 ${escapeHtml(plan.name)}</button>
</div>`).join("");
  const body = `<h1>DEX Cloud</h1>
<p class="lead">一个账号管理你的桌面端、手机端和云电脑。自建服务由 dexai.vip 运营。</p>
${cards}
<div id="status" class="status"></div>
<p class="note">已经有桌面端？在 DEX BOT → 设置 → DEX Cloud 里直接登录即可。</p>`;
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
  return layout("DEX Cloud", body, script);
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
    $("status").textContent = "已开通。回到 DEX BOT，它会自动刷新。"; $("status").className = "status ok";
    $("send").disabled = true; $("activate").disabled = true;
  } catch (error) { $("status").textContent = error.message; $("status").className = "status bad"; }
};`;
  return layout("开通", body, script);
}

export function downloadPage(_config) {
  const body = `<h1>下载 DEX BOT</h1>
<p class="lead">桌面端与手机端使用同一个账号。局域网、Tailscale 和配对码连接都保留。</p>
<div class="card"><h3>Android</h3><p class="note">与官方应用可同时安装，包名 <code>com.dexbot.companion</code>。</p>
<p><a href="/download/dexbot.apk">下载 APK</a></p></div>
<div class="card"><h3>桌面端</h3><p class="note">macOS / Windows / Linux 构建请从 <a href="https://github.com/liguan-89/dexbot/releases">GitHub Releases</a> 获取。</p></div>
<div class="card"><h3>手机配对</h3><p class="note">桌面端 → 手机和设备，扫二维码即可；同一 Wi-Fi 或 Tailscale 下也可直接输入地址。</p></div>`;
  return layout("下载", body);
}

export function provisionPage(cloud) {
  const status = cloud.status === "ready" ? "已经就绪" : cloud.status === "offline" ? "暂时离线" : "正在创建";
  const body = `<h1>${escapeHtml(cloud.name)}</h1>
<p class="lead">DEX Cloud 正在为你准备这台云电脑。当前状态：<strong>${escapeHtml(status)}</strong>。</p>
<div class="card">
  <h3>接下来</h3>
  <p class="note">回到 DEX BOT 的“服务器”列表，云电脑就绪后会自动出现。首次打开时用同一账号登录即可。</p>
  <p class="note">地址：<code>${escapeHtml(cloud.origin || cloud.hostname || "")}</code></p>
</div>
<p><a href="/cloud">返回 DEX Cloud</a></p>`;
  return layout("创建云电脑", body);
}

export function errorPage(message) {
  return layout("出错了", `<h1>出错了</h1><p class="lead">${escapeHtml(message)}</p><p><a href="/cloud">返回 DEX Cloud</a></p>`);
}
