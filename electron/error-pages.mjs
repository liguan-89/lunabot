import path from "node:path";
import { pathToFileURL } from "node:url";
import nativeText from "./native-text.cjs";

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const escapeText = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

function around(template, name) {
  const at = template.indexOf(`{${name}}`);
  return at < 0 ? [template, ""] : [template.slice(0, at), template.slice(at + name.length + 2)];
}

/** The page the main window shows when the background server never came up, in `text`'s language. */
export function buildErrorPage({ allPortsOccupied, logDir }, text = nativeText.englishText) {
  const serverLogPath = path.join(logDir, "server.log");
  const serverLogHref = pathToFileURL(serverLogPath).href;
  const reason = text.t(allPortsOccupied ? "native.dialog.serverFailed.portsTaken" : "native.dialog.serverFailed.slow");
  const [before, after] = around(text.t("native.dialog.serverFailed.keepsHappening"), "log");
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#121212;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><svg width="40" height="40" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="23" fill="#F7F3ED"/><rect x="14.5" y="16.5" width="8" height="15" rx="4" fill="#1C1C1E" transform="rotate(-17 18.5 24)"/><rect x="27.5" y="16.5" width="8" height="15" rx="4" fill="#1C1C1E" transform="rotate(-17 31.5 24)"/></svg><h2 style="font-weight:600;margin:12px 0 6px">${escapeText(text.t("native.dialog.serverFailed.title"))}</h2><p style="color:#fcfcfc99;line-height:1.5">${escapeHtml(reason)} ${escapeText(before)}<a target="_blank" rel="noopener" href="${serverLogHref}" style="color:#fcfcfc">${escapeHtml(serverLogPath)}</a>${escapeText(after)}</p></div></body>`,
    )
  );
}

/** The page the live-desktop viewer shows when it cannot open, in `text`'s language. */
export function desktopViewerErrorPage(message, retryUrl, text = nativeText.englishText) {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><html lang="${escapeText(text.intlTag())}"><meta name="color-scheme" content="dark"><title>${escapeText(text.t("native.viewer.title"))}</title>
      <body style="margin:0;display:grid;place-items:center;height:100vh;background:#121212;color:#f5f5f5;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
        <main style="max-width:420px;padding:32px;text-align:center"><h2 style="margin:0 0 10px;font-size:18px">${escapeText(text.t("native.viewer.heading"))}</h2>
        <p style="margin:0 0 20px;color:#a1a1aa;line-height:1.5">${escapeText(message)}</p>
        <a href="${escapeText(retryUrl)}" target="_blank" rel="noreferrer" style="display:inline-block;border-radius:9px;background:#fff;color:#111;padding:9px 14px;text-decoration:none;font-weight:600">${escapeText(text.t("native.viewer.open"))}</a></main>
      </body></html>`)
  );
}
