import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakeConnectedApps } from "./testing/fake-connected-apps.ts";
import { piDumpPath, piTurns } from "./testing/pi-dump.ts";

type Bridge = { command: string; args: string[]; env: Record<string, string> };

/** Starts a mounted connected-apps bridge the way the engine would and asks it for its tools and one call. */
async function ask(bridge: Bridge, call: { name: string; arguments: Record<string, unknown> }) {
  const child: ChildProcessWithoutNullStreams = spawn(bridge.command, [...(bridge.command === process.execPath ? ["--experimental-strip-types", "--no-warnings"] : []), ...bridge.args], {
    env: { ...process.env, ...bridge.env }, stdio: "pipe",
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (id: number, method: string, params?: unknown) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    return JSON.parse((await lines.next()).value as string);
  };
  try {
    await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine", version: "1" } });
    const listed = await request(2, "tools/list");
    if (!listed.result) throw new Error(`tools/list: ${JSON.stringify(listed).slice(0, 500)} via ${bridge.command} ${bridge.args.join(" ")}`);
    const names: string[] = listed.result.tools.map((tool: { name: string }) => tool.name);
    const answer = await request(3, "tools/call", call);
    return { names, answer };
  } finally {
    child.kill("SIGKILL");
  }
}

/** The app's HTTP API at `url`, expecting `expected` back. */
const apiOn = (url: string) => async (method: string, path: string, body?: unknown, expected = 200) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(expected);
  return result;
};

it("a bot given Gmail by its app switch reaches gmail.search_emails by name through the mounted bridge", async () => {
  const apps = await startFakeConnectedApps();
  apps.emails.push({ messageId: "m-ada", threadId: "t-ada", messageTimestamp: new Date().toISOString(), subject: "Q3 numbers", sender: "Ada <ada@example.test>", preview: { body: "Here they are" } });
  const scratch = mkdtempSync(join(tmpdir(), "omb-app-tools-"));
  const gate = join(scratch, "finish");
  // The fake pi's `slow` turn answers once the gate exists, so the turn's launch can be read while it runs. This build
  // runs one engine, so the second half of this recipe (the same tools under an ACP engine's own names) has no engine to
  // compare against; what remains is that the bridge lists the app's reads under the names a model calls.
  const fixture = await launchVerificationServer({
    ...process.env, LUNABOT_COMPOSIO_BROKER_URL: apps.url, LUNABOT_COMPOSIO_BROKER_TOKEN: apps.token,
    FAKE_PI_MODE: "slow", FAKE_PI_SLOW_FINISH_GATE: gate,
  });
  const api = apiOn(fixture.info.url);
  try {
    const bot = (await api("POST", "/api/bots", { name: "Paul" }, 201)).bot;
    // The record an Apps switch left before it also wrote the tool list: Gmail on by scope, no tool granted.
    await api("PATCH", `/api/bots/${bot.id}`, { composio: true, connectorTools: {}, connectorScopes: { apps: { gmail: "read", googlecalendar: "read" } } });
    const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).find((row: any) => row.id === bot.id);
    expect(saved.connectorTools).toEqual({ gmail: { tools: "*" }, googlecalendar: { tools: "*" } });

    const send = async (text: string, sendId: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId }, 202);
    await send("Find Ada's mail", "app-tools-e2e-send-0001");
    // The connected-apps bridge the turn mounted, from the pi launch line in the log.
    let onPi: Bridge | undefined;
    await expect.poll(() => {
      onPi = piTurns(piDumpPath(fixture.info.dataDir)).findLast((turn) => turn.prompt.includes("Find Ada's mail"))?.launch?.mcpConfig?.mcpServers?.composio as Bridge | undefined;
      return Boolean(onPi);
    }, { timeout: 20_000 }).toBe(true);
    // pi names a tool with underscores (an engine's tool names carry no dots), which is also the ACP engine's spelling.
    const onPiTools = await ask(onPi!, { name: "gmail_search_emails", arguments: { query: "from:ada@example.test" } });
    expect(onPiTools.names).toEqual(expect.arrayContaining(["gmail_search_emails", "gmail_read_email", "gmail_read_email_thread", "googlecalendar_list_events"]));
    expect(onPiTools.names, "a read-only app offers no tool that writes").not.toContain("gmail_send_email");
    expect(JSON.parse(onPiTools.answer.result.content[0].text).messages[0]).toMatchObject({ messageId: "m-ada", subject: "Q3 numbers" });
    expect(apps.calls.at(-1)).toMatchObject({ tool: "GMAIL_FETCH_EMAILS", arguments: { user_id: "me", query: "from:ada@example.test" } });
    writeFileSync(gate, "");
    await expect.poll(async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages
      .some((message: any) => message.role === "bot" && String(message.text).startsWith("reply to:")), { timeout: 20_000 }).toBe(true);

    // A later turn keeps the same bridge: the app's reads, under the same names, with its write still absent.
    await send("Find Ada's mail again", "app-tools-e2e-send-0002");
    let again: Bridge | undefined;
    await expect.poll(() => {
      again = piTurns(piDumpPath(fixture.info.dataDir)).findLast((turn) => turn.prompt.includes("Find Ada's mail again"))?.launch?.mcpConfig?.mcpServers?.composio as Bridge | undefined;
      return Boolean(again);
    }, { timeout: 20_000 }).toBe(true);
    const onAgain = await ask(again!, { name: "gmail_search_emails", arguments: { query: "from:ada@example.test" } });
    const plain = (names: string[]) => names.filter((name) => /^(gmail|googlecalendar)[._]/.test(name)).map((name) => name.replace(".", "_")).sort();
    expect(plain(onAgain.names), "the same tools under the same names").toEqual(plain(onPiTools.names));
    expect(onAgain.names).toContain("gmail_search_emails");
    // The second call goes through the same bridge: the app itself was asked again, and the tool is no refusal.
    expect(apps.calls.at(-1)).toMatchObject({ tool: "GMAIL_FETCH_EMAILS", arguments: { user_id: "me", query: "from:ada@example.test" } });
  } finally {
    await fixture.close();
    await apps.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

it("a bot with HighLevel read only runs HighLevel's reads, which name the resource before the verb, and is refused its writes", async () => {
  const apps = await startFakeConnectedApps();
  apps.connected = { highlevel_mcp: true };
  const scratch = mkdtempSync(join(tmpdir(), "omb-app-tools-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({
    ...process.env, LUNABOT_COMPOSIO_BROKER_URL: apps.url, LUNABOT_COMPOSIO_BROKER_TOKEN: apps.token, FAKE_PI_MODE: "slow", FAKE_PI_SLOW_FINISH_GATE: gate,
  });
  const api = apiOn(fixture.info.url);
  try {
    const bot = (await api("POST", "/api/bots", { name: "Boomer" }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { composio: true, connectorTools: { highlevel_mcp: { tools: "*" } }, connectorScopes: { apps: { highlevel_mcp: "read" } } });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "List the pipelines", sendId: "highlevel-read-e2e-0001" }, 202);
    let bridge: Bridge | undefined;
    await expect.poll(() => {
      bridge = piTurns(piDumpPath(fixture.info.dataDir)).findLast((turn) => turn.prompt.includes("List the pipelines"))?.launch?.mcpConfig?.mcpServers?.composio as Bridge | undefined;
      return Boolean(bridge);
    }, { timeout: 20_000 }).toBe(true);
    const run = (tool_slug: string) => ask(bridge!, { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug, arguments: {} }] } });
    for (const slug of ["HIGHLEVEL_MCP_CONTACTS_GET_CONTACTS", "HIGHLEVEL_MCP_OPPORTUNITIES_GET_PIPELINES", "HIGHLEVEL_MCP_OPPORTUNITIES_SEARCH_OPPORTUNITY"]) {
      const { answer } = await run(slug);
      expect(JSON.stringify(answer), slug).not.toContain("would write");
      expect(apps.calls.at(-1)).toMatchObject({ tool: slug });
    }
    const before = apps.calls.length;
    const { answer } = await run("HIGHLEVEL_MCP_CONTACTS_UPDATE_CONTACT");
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toContain("would write to it");
    expect(apps.calls.length, "the write never reached the app").toBe(before);
    writeFileSync(gate, "");
  } finally {
    await fixture.close();
    await apps.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
