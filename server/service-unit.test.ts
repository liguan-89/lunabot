import { describe, expect, it } from "vitest";

import {
  checkSentinelInstall, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  sentinelUnitCommand, serviceCommand, servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/openmausbot/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/lunabot/.lunabot", "--domain", "lunabot.example.com", "--no-pair"],
  dataDir: "/home/lunabot/.lunabot",
  user: "lunabot",
  home: "/home/lunabot",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/openmausbot/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/Luna Bot/server/lunabot.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=Luna Bot (agentada)");
    expect(unit).toContain("User=lunabot");
    expect(unit).toContain("Environment=LUNABOT_DATA_DIR=/home/lunabot/.lunabot");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/openmausbot/cli.js serve --port 8799 --data-dir /home/lunabot/.lunabot --domain lunabot.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/lunabot/.lunabot"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    expect(systemdUnit({ ...spec, dataDir: "/home/lunabot/My Data", serveArgs: ["--data-dir", "/home/lunabot/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/openmausbot/cli.js serve --data-dir "/home/lunabot/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/lunabot", dataDir: "/Users/lunabot/.lunabot" });
    expect(plist).toContain("<string>com.lunabot.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>lunabot.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/lunabot/.lunabot/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/lunabot/.npm/_npx/abc123/node_modules/openmausbot/cli.js")).toMatch(/npm install -g lunabot/);
    expect(unstableInstallWarning("/usr/lib/node_modules/openmausbot/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/lunabot/.lunabot");
    expect(linux?.installed).toBe("/etc/systemd/system/lunabot.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now lunabot");
    const mac = servicePlan("darwin", "/Users/lunabot/.lunabot", "/Users/lunabot");
    expect(mac?.installed).toBe("/Users/lunabot/Library/LaunchAgents/com.lunabot.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label, logging outside the data dir", () => {
    const out = "/Users/lunabot/Library/Application Support/lunabot-sentinel";
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", dataDir: "/Users/lunabot/.lunabot", home: "/Users/lunabot", out };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/openmausbot/cli.js", "sentinel", "--once", "--data-dir", "/Users/lunabot/.lunabot", "--out", out]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/Luna Bot/server/lunabot.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.lunabot.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>${out}/sentinel.log</string>`);
    expect(plist).not.toContain(".lunabot/logs");
    const mac = sentinelServicePlan("darwin", out, "/Users/lunabot");
    expect(mac?.files).toEqual([{ name: "com.lunabot.sentinel.plist", installed: "/Users/lunabot/Library/LaunchAgents/com.lunabot.sentinel.plist" }]);
    // a path with a space is one argument in the printed commands
    expect(mac?.activate[0]).toBe("mkdir -p /Users/lunabot/Library/LaunchAgents && cp '/Users/lunabot/Library/Application Support/lunabot-sentinel/com.lunabot.sentinel.plist' /Users/lunabot/Library/LaunchAgents/com.lunabot.sentinel.plist");
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.lunabot.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", dataDir: "/home/lunabot/My Data", home: "/home/lunabot", out: "/home/lunabot/.local/state/lunabot-sentinel" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/openmausbot/cli.js sentinel --once --data-dir "/home/lunabot/My Data" --out /home/lunabot/.local/state/lunabot-sentinel');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", sentinel.out, "/home/lunabot");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/lunabot/.config/systemd/user/lunabot-sentinel.service", "/home/lunabot/.config/systemd/user/lunabot-sentinel.timer"]);
    expect(linux?.activate[0]).toContain("cp /home/lunabot/.local/state/lunabot-sentinel/lunabot-sentinel.service");
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now lunabot-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });

  it("finds the CLI the installed desktop app ships, and runs it as Node", () => {
    const app = "/Applications/Luna Bot.app/Contents";
    const present = new Set([`${app}/MacOS/Luna Bot`, `${app}/Resources/server/lunabot.js`]);
    expect(shippedSentinelCli("darwin", "/Users/lunabot", (path) => present.has(path))).toEqual({ node: `${app}/MacOS/Luna Bot`, script: `${app}/Resources/server/lunabot.js` });
    const user = "/Users/lunabot/Applications/Luna Bot.app/Contents";
    expect(shippedSentinelCli("darwin", "/Users/lunabot", (path) => path.startsWith(user))?.script).toBe(`${user}/Resources/server/lunabot.js`);
    expect(shippedSentinelCli("linux", "/home/lunabot", (path) => path.startsWith("/opt/LunaBot/"))).toEqual({ node: "/opt/LunaBot/lunabot", script: "/opt/LunaBot/resources/server/lunabot.js" });
    // an app with its script missing, or one released before Sentinel, is no CLI for it
    expect(shippedSentinelCli("darwin", "/Users/lunabot", (path) => path.endsWith("MacOS/Luna Bot"))).toBeNull();
    expect(shippedSentinelCli("darwin", "/Users/lunabot", (path) => present.has(path), () => false)).toBeNull();
    expect(shippedSentinelCli("win32", "C:\\Users\\lunabot", () => true)).toBeNull();

    const spec = { node: `${app}/MacOS/Luna Bot`, script: `${app}/Resources/server/lunabot.js`, dataDir: "/Users/lunabot/.lunabot", home: "/Users/lunabot", out: "/tmp/s", electronRunAsNode: true };
    expect(sentinelLaunchdPlist(spec)).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
    expect(sentinelSystemdService(spec)).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(sentinelLaunchdPlist({ ...spec, electronRunAsNode: false })).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("keeps every path one quoted value in the systemd unit, and refuses one no unit can hold", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/lunabot/cli.js", dataDir: "/home/lunabot/100% $HOME\\", home: "/home/my lunabot", out: "/home/my lunabot/.local/state/lunabot-sentinel" };
    const unit = sentinelSystemdService(spec);
    expect(unit).toContain('Environment="HOME=/home/my lunabot"');
    // % is no specifier, $ no variable, and the trailing backslash no continuation
    expect(unit).toContain('"/home/lunabot/100%% $$HOME\\\\"');
    expect(sentinelUnitCommand(unit)).toEqual({ node: "/usr/bin/node", script: "/srv/lunabot/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService({ ...spec, script: "/srv/100% $x/cli.js" }))?.script).toBe("/srv/100% $x/cli.js");
    for (const bad of ["/home/lunabot\n[Service]\nExecStartPre=/bin/true", "/home/lunabot\r", "/home/\0lunabot"]) {
      expect(() => sentinelSystemdService({ ...spec, home: bad })).toThrow(/line break or NUL/);
      expect(() => sentinelLaunchdPlist({ ...spec, dataDir: bad })).toThrow(/line break or NUL/);
    }
  });

  it("reads back what an installed unit runs, and calls it stale when either path is gone", () => {
    const spec = { node: "/opt/node & co/bin/node", script: "/srv/lunabot/cli.js", dataDir: "/home/lunabot/My Data", home: "/home/lunabot", out: "/home/lunabot/.local/state/lunabot-sentinel" };
    expect(sentinelUnitCommand(sentinelLaunchdPlist(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/lunabot/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/lunabot/cli.js" });
    expect(sentinelUnitCommand("[Service]\nType=oneshot\n")).toBeNull();

    const unit = "/home/lunabot/.config/systemd/user/lunabot-sentinel.service";
    const timer = "/home/lunabot/.config/systemd/user/lunabot-sentinel.timer";
    const files = new Map([[unit, sentinelSystemdService(spec)]]);
    const fs = (present: string[]) => ({ exists: (path: string) => files.has(path) || present.includes(path), read: (path: string) => files.get(path)! });
    expect(checkSentinelInstall("linux", "/home/lunabot", fs([spec.node, spec.script, timer]))).toMatchObject({ status: "ok", unit });
    expect(checkSentinelInstall("linux", "/home/lunabot", fs([spec.node, timer]))).toMatchObject({ status: "stale", missing: ["/srv/lunabot/cli.js"] });
    // the service without its timer never runs
    expect(checkSentinelInstall("linux", "/home/lunabot", fs([spec.node, spec.script]))).toMatchObject({ status: "stale", missing: [timer] });
    expect(checkSentinelInstall("darwin", "/Users/lunabot", fs([]))).toEqual({ status: "not_installed", unit: "/Users/lunabot/Library/LaunchAgents/com.lunabot.sentinel.plist" });
    files.set(unit, "garbage");
    expect(checkSentinelInstall("linux", "/home/lunabot", fs([]))).toEqual({ status: "unreadable", unit });
    expect(checkSentinelInstall("win32", "C:\\Users\\lunabot", fs([]))).toEqual({ status: "unsupported" });
  });
});
