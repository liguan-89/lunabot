import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 20_000 }, (error, stdout, stderr) => {
    if (error) return reject(Object.assign(error, { stderr }));
    resolve(String(stdout));
  });
});

const CLOUD_ID = /^c-[0-9a-f]{12}$/;
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/=]+/;

/** Makes a throwaway tenant key with the OpenSSH tools already pinned into the dex-cloud image. */
export async function generateDesktopKey(run = execFileAsync) {
  const dir = mkdtempSync(join(tmpdir(), "dexcloud-desktop-key-"));
  try {
    const path = join(dir, "id_ed25519");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]);
    return { privateKey: readFileSync(path, "utf8"), publicKey: readFileSync(`${path}.pub`, "utf8").trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * SSH client for the desktop host's allocation helper. The helper owns the host-side
 * user/rootless-Docker lifecycle; dex-cloud only passes a cloud id and tenant public key.
 */
export function createDesktopPool(config, { run = execFileAsync } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dexcloud-desktop-provision-"));
  const keyPath = join(dir, "provision-key");
  const hostsPath = join(dir, "known-hosts");
  writeFileSync(keyPath, config.desktop.provisionKey.endsWith("\n") ? config.desktop.provisionKey : `${config.desktop.provisionKey}\n`, { mode: 0o600 });
  writeFileSync(hostsPath, `${config.desktop.sshPort === 22 ? config.desktop.host : `[${config.desktop.host}]:${config.desktop.sshPort}`} ${config.desktop.hostPublicKey}\n`, { mode: 0o600 });

  async function helper(args) {
    if (!CLOUD_ID.test(args[1] ?? "")) throw new Error(`invalid cloud id for desktop allocation: ${args[1]}`);
    const output = await run("ssh", [
      "-i", keyPath,
      "-p", String(config.desktop.sshPort),
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${hostsPath}`,
      `${config.desktop.provisionUser}@${config.desktop.host}`,
      ["/usr/local/sbin/dexcloud-desktop-slot", ...args].join(" "),
    ]);
    let parsed = null;
    try { parsed = JSON.parse(output.trim()); } catch {}
    if (!parsed || typeof parsed.user !== "string" && args[0] !== "release") throw new Error("desktop host helper returned an invalid answer");
    return parsed;
  }

  return {
    async allocate({ cloudId, publicKey }) {
      const key = publicKey.match(PUBLIC_KEY)?.[0];
      if (!key) throw new Error("desktop tenant public key must be one ssh-ed25519 key without a comment");
      const answer = await helper(["allocate", cloudId, key]);
      if (!/^dxd[0-9]{1,4}$/.test(answer.user)) throw new Error("desktop host helper returned an invalid tenant user");
      return { host: config.desktop.host, port: config.desktop.sshPort, user: answer.user };
    },
    async release({ cloudId }) {
      await helper(["release", cloudId]);
    },
  };
}
