import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { buildErrorPage } from "./error-pages.mjs";
import nativeText from "./native-text.cjs";

const page = (url) => decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));
const logDir = path.resolve("/logs");
const logPath = path.join(logDir, "server.log");
const logLink = `<a target="_blank" rel="noopener" href="${pathToFileURL(logPath).href}" style="color:#fcfcfc">${logPath}</a>`;

test("the page for a server that never came up keeps its English, link and all", () => {
  const html = page(buildErrorPage({ allPortsOccupied: false, logDir }));
  assert.match(html, /<h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server<\/h2>/u);
  assert.ok(html.includes("The background server didn&#39;t come up in time — this is usually slow startup, not a port conflict. Quit and reopen Luna Bot. "
    + `If it keeps happening, check ${logLink}.</p>`));
  assert.ok(page(buildErrorPage({ allPortsOccupied: true, logDir })).includes("Every Luna Bot port answered health checks from another process"));
});

test("the page speaks the app's language, with the log's link where the sentence puts it", () => {
  const text = nativeText.createNativeText({ saved: "zh" });
  const html = page(buildErrorPage({ allPortsOccupied: true, logDir }, text));
  assert.ok(html.includes(">无法启动机器人服务器</h2>"));
  assert.equal(html.slice(html.indexOf("<p "), html.indexOf("</p>") + 4),
    '<p style="color:#fcfcfc99;line-height:1.5">每个 Luna Bot 端口都响应了来自其他进程的健康检查——可能是应用的另一个副本，或者是占用了 8799–28799 端口的其他程序。请退出该程序，然后退出并重新打开 Luna Bot。 '
    + `如果反复出现，请检查 ${logLink}。</p>`);
});
