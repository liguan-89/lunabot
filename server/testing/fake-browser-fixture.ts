// A happy-dom page behind a stand-in agent-browser: nothing reaches a real browser, the user's data or port 8799.
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchVerificationServer } from "../../scripts/control-lunabot.ts";
import { removeTempDir } from "./cleanup.ts";
import { FakeLoginPage, LOGIN_FORM } from "./fake-login-page.ts";
import { freePortBlock } from "./ports.ts";

/** The bridge plays the running browser: the stand-in engine forwards each command, relay command and MCP call here. */
/** `cuaRecord`: the desktop app's driver record, handed to this server as the app hands it to its own. */
export async function browserFixture(url: string, cuaRecord?: string, html = LOGIN_FORM) {
  const page = new FakeLoginPage(url, html);
  const port = await freePortBlock([0], 19_960, 40);
  const engineArgs: string[][] = [];
  // The proxy each browser command carries (a version probe starts no browser): a bot's browser goes through its egress gate.
  const proxies = new Set<string>();
  const bridge = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const reply = (data: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      if (req.url === "/api/command") {
        const command = JSON.parse(raw) as { action?: string; subaction?: string; text?: string; key?: string; code?: string; selector?: string; type?: string; x?: number; y?: number };
        if (command.action === "keyboard" && command.subaction === "insertText" && typeof command.text === "string") await page.insertText(command.text);
        else if (command.action === "press" && typeof command.key === "string") await page.press(command.key);
        else if (command.action === "click" && typeof command.selector === "string") await page.click(command.selector);
        else if (command.action === "input_mouse") await page.mouseInput(command);
        else if (command.action === "input_keyboard") await page.keyEvent(command);
        else return reply({ success: false });
        return reply({ success: true, data: {} });
      }
      if (req.url === "/mcp") {
        const call = JSON.parse(raw) as { name: string; arguments?: { script?: string } };
        if (call.name === "agent_browser_get_url") return reply({ content: [{ type: "text", text: page.window.location.href }] });
        if (call.name === "agent_browser_eval") return reply({ content: [{ type: "text", text: JSON.stringify(page.window.eval(call.arguments?.script ?? "")) }] });
        return reply({ isError: true, content: [{ type: "text", text: `unknown tool ${call.name}` }] });
      }
      const { args, proxy } = JSON.parse(raw) as { args: string[]; proxy?: string };
      engineArgs.push(args);
      if (args[0] !== "--version") proxies.add(proxy ?? "none");
      const data = await page.engine(args);
      return reply({ success: true, data: data && "port" in data ? { ...data, port } : data });
    } catch (error) {
      return reply({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  // The live view opens a WebSocket on the stream port the stand-in advertises: accept the upgrade and stay silent,
  // as a daemon that has no new frames does. The sockets are tracked so close() can drop them — an upgraded socket
  // otherwise keeps a closing server listening forever.
  const upgraded = new Set<import("node:stream").Duplex>();
  bridge.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    upgraded.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => upgraded.delete(socket));
  });
  await new Promise<void>((ready) => bridge.listen(port, "127.0.0.1", ready));

  const tools = mkdtempSync(join(tmpdir(), "omb-saved-login-e2e-"));
  const binaryPath = join(tools, "agent-browser");
  // The stand-in agent-browser: always running, `close` and `set` do nothing, `mcp` answers get_url and eval from the
  // page, and every other command goes to the bridge.
  writeFileSync(binaryPath, `#!${process.execPath}
const args = process.argv.slice(2).filter((arg) => arg !== "--json" && arg !== "--no-webmcp");
const say = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const bridge = (path, body) => fetch("http://127.0.0.1:${port}" + path, { method: "POST", body: JSON.stringify(body) }).then((response) => response.text());
if (args[0] === "session" && args[1] === "list") say({ success: true, data: { sessions: [process.env.AGENT_BROWSER_SESSION] } });
else if (args[0] === "close" || args[0] === "set") process.exit(0);
else if (args[0] === "mcp") {
  const tool = (name) => ({ name, description: name, inputSchema: { type: "object", properties: { script: { type: "string" } } } });
  const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === "initialize") answer(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
    else if (message.method === "tools/list") answer(message.id, { tools: [tool("agent_browser_get_url"), tool("agent_browser_eval")] });
    else bridge("/mcp", message.params).then((text) => answer(message.id, JSON.parse(text)));
  });
}
else bridge("/engine", { args, proxy: process.env.AGENT_BROWSER_PROXY }).then((text) => { process.stdout.write(text); process.exit(0); }, () => process.exit(1));
`, { mode: 0o755 });

  const fixture = await launchVerificationServer(cuaRecord ? { LUNABOT_TEST_DESKTOP_CUA_CONNECTION: cuaRecord } : {}, undefined, undefined, { binaryPath, executablePath: join(tools, "chrome") }, undefined, { scripted: true });
  const base = fixture.info.url;
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json", origin: base },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  const answered = (turn: number, tool: string) => evidence()[turn].evidence.filter((entry: any) => entry.step?.tool === tool).map((entry: any) => entry.response.result);
  return {
    page, base, planPath, engineArgs, proxies, fixture, evidence, api, answered,
    close: async () => {
      page.close();
      await fixture.close();
      for (const socket of upgraded) socket.destroy();
      await new Promise((done) => bridge.close(done));
      await removeTempDir(tools);
    },
  };
}
