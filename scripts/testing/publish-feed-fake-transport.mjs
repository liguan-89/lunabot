// Test double for publish-feed-transport.mjs: emulates the remote host over a
// local directory (FAKE_ROOT) so publish-desktop-feed tests run in-process
// without ssh/rsync/curl or any shell. ssh() parses only the fixed command
// shapes the publish script issues; anything else throws so drift is loud.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

const root = process.env.FAKE_ROOT;

function urlPath(url) {
  const p = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
  return p.startsWith("/download/") ? `${root}/downloads/${p.slice("/download/".length)}` : `${root}/downloads${p}`;
}

export function ssh(host, command) {
  let m;
  if ((m = command.match(/^ls -1 (.+)$/))) return `${readdirSync(m[1]).join("\n")}\n`;
  if ((m = command.match(/^rm -f -- (.+)$/))) {
    rmSync(m[1], { force: true });
    return "";
  }
  if ((m = command.match(/^openssl dgst -sha512 -binary "(.+)" \| openssl base64 \| tr -d '\\n'$/))) {
    return `${createHash("sha512").update(readFileSync(m[1])).digest("base64")}\n`;
  }
  if ((m = command.match(/^openssl dgst -sha256 "(.+)"$/))) {
    return `SHA256(${m[1]})= ${createHash("sha256").update(readFileSync(m[1])).digest("hex")}\n`;
  }
  if ((m = command.match(/^cmp -s "(.+)" "(.+)"$/))) {
    if (!readFileSync(m[1]).equals(readFileSync(m[2]))) throw new Error(`files differ: ${m[1]} ${m[2]}`);
    return "";
  }
  throw new Error(`unparsed ssh command: ${command}`);
}

export function sshWrite(host, command, input) {
  const m = command.match(/^cat > (.+)$/);
  if (!m) throw new Error(`unparsed ssh command: ${command}`);
  writeFileSync(m[1], input);
}

export function rsyncPut(host, local, remote) {
  writeFileSync(remote, readFileSync(local));
}

export function fetchText(url) {
  return readFileSync(urlPath(url), "utf8");
}

export function fetchHead(url) {
  return `HTTP/1.1 200 OK\r\ncontent-length: ${statSync(urlPath(url)).size}\r\n\r\n`;
}
