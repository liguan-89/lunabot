import assert from "node:assert/strict";
import { test } from "node:test";

import { createDesktopPool } from "../src/desktop-pool.js";
import { desktopPoolConfigured, loadConfig } from "../src/config.js";

const desktopConfig = () => ({
  desktop: {
    host: "desktop.example.test",
    sshPort: 2222,
    provisionUser: "dexcloud-desktop",
    provisionKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n",
    hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost",
    alias: "dexcloud-desktop",
  },
});

test("the desktop pool client pins the host key, uses batch mode, and sends only the key body", async () => {
  const calls = [];
  const pool = createDesktopPool(desktopConfig(), { run: async (command, args) => { calls.push([command, args]); return '{"user":"dxd3"}\n'; } });
  const answer = await pool.allocate({ cloudId: "c-0123456789ab", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITenant tenant comment" });
  assert.deepEqual(answer, { host: "desktop.example.test", port: 2222, user: "dxd3" });
  const [command, args] = calls[0];
  assert.equal(command, "ssh");
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.equal(args.at(-2), "dexcloud-desktop@desktop.example.test");
  assert.equal(args.at(-1), "/usr/local/sbin/dexcloud-desktop-slot allocate c-0123456789ab ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITenant");
});

test("managed desktop configuration is all-or-nothing and validates the host public key shape", () => {
  const base = {
    LUNABOT_CLOUD_DB: ":memory:",
    LUNABOT_CLOUD_ORIGIN: "https://cloud.dexai.vip",
  };
  assert.equal(desktopPoolConfigured(loadConfig(base)), false);
  assert.throws(() => desktopPoolConfigured(loadConfig({ ...base, LUNABOT_CLOUD_DESKTOP_HOST: "desktop.example.test" })), /together/);
  const cfg = loadConfig({ ...base,
    LUNABOT_CLOUD_DESKTOP_HOST: "desktop.example.test",
    LUNABOT_CLOUD_DESKTOP_PROVISION_KEY: "key",
    LUNABOT_CLOUD_DESKTOP_HOST_PUBLIC_KEY: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost" });
  assert.equal(desktopPoolConfigured(cfg), true);
  cfg.desktop.hostPublicKey = "desktop.example.test ssh-ed25519 AAAA";
  assert.throws(() => desktopPoolConfigured(cfg), /without a host or comment/);
});
