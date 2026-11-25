// Live transport for publish-desktop-feed.mjs: ssh/rsync/curl on PATH.
// The publish script imports this module by default; LUNABOT_FEED_TRANSPORT
// can point at a compatible module instead (tests fake the remote in-process).
import { execFileSync } from "node:child_process";

const SSH_BIN = process.env.LUNABOT_FEED_SSH || "ssh";
const RSYNC_BIN = process.env.LUNABOT_FEED_RSYNC || "rsync";
const CURL_BIN = process.env.LUNABOT_FEED_CURL || "curl";

export function ssh(host, command) {
  return execFileSync(SSH_BIN, [host, command], { encoding: "utf8" });
}

export function sshWrite(host, command, input) {
  execFileSync(SSH_BIN, [host, command], { input });
}

export function rsyncPut(host, local, remote) {
  execFileSync(RSYNC_BIN, ["-az", "--", local, `${host}:${remote}`], { stdio: "inherit" });
}

export function fetchText(url) {
  return execFileSync(CURL_BIN, ["-fsS", url], { encoding: "utf8" });
}

export function fetchHead(url) {
  return execFileSync(CURL_BIN, ["-fsSI", url], { encoding: "utf8" });
}
