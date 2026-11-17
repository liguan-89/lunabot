// Run with `pnpm exec electron scripts/smoke-approval-modes.cjs`.
// Exercises the real private Electron utility-process grant protocol against the one agent this build runs, pi, in a
// disposable home with the repository's fake pi. Never uses the live app, a person's own home or a real engine.
const { app, utilityProcess } = require("electron");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { createTrustedApprovalModeCoordinator } = require("../electron/approval-trusted-mode.cjs");

const root = resolve(__dirname, "..");
const home = mkdtempSync(join(tmpdir(), "omb-approval-smoke-"));
app.setPath("userData", join(home, "electron"));
let child;
let logs = "";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function until(check) {
  const deadline = Date.now() + 30_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Fixture timed out. ${logs.slice(-2000)}`);
}

app.whenReady().then(async () => {
  const port = await freePort();
  let webhookPort = await freePort();
  while (webhookPort === port) webhookPort = await freePort();
  // The fake pi's launch log: one line per child boot (argv and the MCP config it was handed) and one per prompt. A
  // launch's `mcpConfig.approvalMode` is the level that turn really ran under, and its agents env names the thread.
  const piDump = join(home, "fake-pi-dump.jsonl");
  // A prompt carrying this marker asks the person's permission, the way a gated tool call does.
  const permissionMarker = "Ask me first";
  writeFileSync(join(home, "config.json"), JSON.stringify({
    // A setup card's answers would be one more engine call at every new bot.
    features: { smartSetupChoices: false },
    instances: {
      pi: {
        driver: "piAgent",
        displayName: "Verification pi",
        config: { cli: join(root, "server/testing/fake-pi-cli.ts") },
        environment: { FAKE_PI_DUMP: piDump, FAKE_PI_PERMISSION_ON: permissionMarker },
      },
    },
  }));
  const testCapabilityKey = randomUUID();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
  child = utilityProcess.fork(join(root, "server/index.ts"), [], {
    cwd: root,
    execArgv: ["--experimental-strip-types"],
    env: {
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: home, PATH: "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(webhookPort),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: testCapabilityKey,
    },
    stdio: "pipe",
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  child.on("message", (message) => coordinator.receive(child, message));
  child.on("exit", () => coordinator.rejectProcess(child));
  const api = async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  await until(() => api("/api/health").catch(() => null));

  /** Every row the fake pi appended, launches and prompts alike. */
  const piRows = () => {
    try {
      return readFileSync(piDump, "utf8").split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch {
      return [];
    }
  };
  /** The launch a thread's newest child booted from: the MCP config names the thread and the level. */
  const launchOf = (threadId) => piRows()
    .filter((row) => Array.isArray(row.argv) && row.mcpConfig?.mcpServers?.agents?.env?.OMB_THREAD_ID === threadId)
    .at(-1);
  /** The approval level that thread's newest turn really ran under, from the fake pi's own launch record. */
  const levelOf = (threadId) => launchOf(threadId)?.mcpConfig?.approvalMode ?? null;
  const bots = async () => (await api("/api/bots")).body.bots;
  const readBot = async (id) => (await bots()).find((bot) => bot.id === id);
  const taskOf = async (id, threadId) => (await readBot(id))?.tasks.find((task) => task.threadId === threadId);
  /** The card a thread waits on. A non-selected thread's rows are not on the bot, so read that thread's own messages. */
  const pendingCard = async (threadId) => ((await api(`/api/threads/${threadId}/messages`)).body.messages ?? [])
    .find((message) => message.card?.requestId && !message.card.answered && !message.card.dismissed)?.card;
  const piModel = (await api("/api/instances")).body.instances.find((instance) => instance.instanceId === "pi")?.models?.default;
  assert.ok(piModel, "the fixture's pi instance lists no default model");
  const newBot = async (name) => (await api("/api/bots", "POST", { name, modelSelection: { instanceId: "pi", model: piModel } })).body.bot;
  const newTask = async (botId, title, options = {}) => (await api(`/api/bots/${botId}/tasks`, "POST", { title, ...options })).body.task;
  const send = async (botId, text, threadId) => (await api(`/api/bots/${botId}/messages`, "POST", { text, ...(threadId ? { threadId } : {}) })).status;
  const idle = async (botId, threadId) => until(async () => !(await taskOf(botId, threadId))?.busy);

  const verifyUi = () => require("./testing/approval-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until,
    grant: (botId, mode, options) => coordinator.request(child, botId, mode, options),
  });
  if (process.argv.includes("--skill-ui-only")) {
    await require("./testing/skill-approval-ui-smoke.cjs")({ root, home, url: `http://127.0.0.1:${port}`, api, until,
      capability: (botId, threadId) => api("/api/testing/internal-capability", "POST", { botId, threadId, skillAuthoring: true }, { "x-openmausbot-test-capability": testCapabilityKey }),
    });
    return;
  }
  if (process.argv.includes("--sidebar-attention-only")) {
    await require("./testing/sidebar-attention-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until });
    return;
  }
  if (process.argv.includes("--ui-only")) { await verifyUi(); return; }
  if (process.argv.includes("--model-ui-only")) {
    await require("./testing/model-switch-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until,
      grant: (botId, mode, options) => coordinator.request(child, botId, mode, options),
    });
    return;
  }

  // One explicit grant covers old, archived and future threads. Use the real private bridge, not fixture state edits.
  const whole = await newBot("All threads fixture");
  const untouched = (await api("/api/bots", "POST", { name: "Unrelated bot" })).body.bot;
  await coordinator.request(child, whole.id, "ask");
  const threads = [];
  for (const title of ["Existing conversation one", "Existing conversation two", "Existing conversation three"]) {
    threads.push((await newTask(whole.id, title)).threadId);
  }
  assert.equal((await api(`/api/bots/${whole.id}/tasks/${threads[0]}`, "PATCH", { archivedAt: Date.now() })).status, 200);
  const allGranted = await coordinator.request(child, whole.id, "full", { allThreads: true });
  assert.equal(allGranted.approvalMode, "full");
  assert.ok(allGranted.tasks.every(task => task.approvalMode === "full"));
  const future = await newTask(whole.id, "Future thread");
  assert.equal(future.approvalMode, "full");
  assert.equal((await api("/api/bots?messages=0")).body.bots.find(bot => bot.id === untouched.id).approvalMode, untouched.approvalMode);
  const persisted = JSON.parse(readFileSync(join(home, "bots.json"), "utf8")).find(bot => bot.id === whole.id);
  assert.ok(persisted.tasks.every(task => task.approvalMode === "full"));
  assert.equal(persisted.approvalGrant, undefined);
  const revoked = await coordinator.request(child, whole.id, "ask", { allThreads: true });
  assert.equal(revoked.approvalMode, "ask");
  assert.ok(revoked.tasks.every(task => task.approvalMode === "ask"));
  // Auto reaches every thread the same way, in one write.
  const autoEverywhere = await coordinator.request(child, whole.id, "auto", { allThreads: true });
  assert.equal(autoEverywhere.approvalMode, "auto");
  assert.ok(autoEverywhere.tasks.every(task => task.approvalMode === "auto"));
  assert.ok((await coordinator.request(child, whole.id, "ask", { allThreads: true })).tasks.every(task => task.approvalMode === "ask"));
  console.log(JSON.stringify({ allThreads: true, archivedIncluded: true, futureInherits: true, unrelatedBotUnchanged: true, persisted: true }));
  if (process.argv.includes("--all-threads-only")) { await verifyUi(); return; }

  // Full needs no private channel: the API applies it at once. Custom is the one level only the private channel owns,
  // and pi does not implement it, so both surfaces refuse it.
  const created = await api("/api/bots", "POST", { modelSelection: { instanceId: "pi", model: piModel } });
  assert.equal(created.status, 201);
  const id = created.body.bot.id;
  assert.equal((await api(`/api/bots/${id}`, "PATCH", { approvalMode: "full" })).status, 200);
  assert.equal((await api(`/api/bots/${id}`, "PATCH", { approvalMode: "ask" })).status, 200);
  // pi implements Ask, Auto and Full itself; Custom belongs to Codex, so it is refused here too.
  assert.ok([400, 403].includes((await api(`/api/bots/${id}`, "PATCH", { approvalMode: "custom" })).status),
    "Custom over HTTP must be refused for pi");
  await assert.rejects(coordinator.request(child, id, "custom"), /only for Codex/);
  for (const mode of ["full", "auto", "ask"]) {
    await coordinator.request(child, id, mode);
    await until(async () => (await readBot(id))?.approvalMode === mode);
    assert.equal(await send(id, `Verify ${mode}`), 202);
    await idle(id, created.body.bot.threadId);
    // The level the turn really ran under, read from the fake pi's launch record, not from the app's own state.
    assert.equal(levelOf(created.body.bot.threadId), mode);
    console.log(JSON.stringify({ mode, piLaunch: levelOf(created.body.bot.threadId), privateGrant: true, turnSettled: true }));
  }

  // Existing conversations retain their snapshot when the bot default changes. Only an explicit private desktop grant
  // may upgrade one thread.
  const scoped = await newBot("Existing thread");
  await coordinator.request(child, scoped.id, "ask");
  const old = await newTask(scoped.id, "Existing Ask thread");
  const other = await newTask(scoped.id, "Leave this thread alone");
  await assert.rejects(coordinator.request(child, scoped.id, "full", { threadId: old.threadId }), /bot settings/);
  await coordinator.request(child, scoped.id, "full");
  await until(async () => (await readBot(scoped.id))?.approvalMode === "full");
  assert.equal((await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "auto" })).status, 200);
  assert.equal((await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "ask" })).status, 200);
  assert.equal((await taskOf(scoped.id, old.threadId)).approvalMode, "ask");
  // Any client may give one thread Full over the API; the private grant below must still work on the same thread once
  // it is back on Ask.
  assert.equal((await api(`/api/bots/${scoped.id}/tasks/${old.threadId}`, "PATCH", { approvalMode: "full" })).status, 200);
  assert.equal((await api(`/api/bots/${scoped.id}/tasks/${old.threadId}`, "PATCH", { approvalMode: "ask" })).status, 200);
  await coordinator.request(child, scoped.id, "full", { threadId: old.threadId });
  await until(async () => (await taskOf(scoped.id, old.threadId))?.approvalMode === "full");
  assert.equal((await taskOf(scoped.id, other.threadId)).approvalMode, "ask");
  await assert.rejects(coordinator.request(child, scoped.id, "full", { threadId: "missing-thread" }), /bot settings/);
  assert.equal(await send(scoped.id, "Verify existing thread Full", old.threadId), 202);
  await idle(scoped.id, old.threadId);
  assert.equal(levelOf(old.threadId), "full");
  console.log(JSON.stringify({ provider: "pi", existingThread: "full", otherThread: "ask", privateGrant: true, turnSettled: true }));

  // Composer grants are independent: an Ask default is not a prerequisite trip through settings.
  const direct = await newBot("Composer scoped access");
  await coordinator.request(child, direct.id, "ask");
  const selected = await newTask(direct.id, "Select Full here");
  const sibling = await newTask(direct.id, "Keep Ask here");
  const committed = await coordinator.request(child, direct.id, "full", { threadId: selected.threadId, threadOnly: true });
  assert.equal(committed.approvalMode, "ask");
  assert.equal(committed.tasks.find(task => task.threadId === selected.threadId).approvalMode, "full");
  assert.equal(committed.tasks.find(task => task.threadId === sibling.threadId).approvalMode, "ask");
  await assert.rejects(coordinator.request(child, direct.id, "full", { threadId: "missing", threadOnly: true }), /existing thread/);
  await coordinator.request(child, direct.id, "ask", { threadId: selected.threadId, threadOnly: true });
  // Custom stays Codex-only on a thread too.
  await assert.rejects(coordinator.request(child, direct.id, "custom", { threadId: selected.threadId, threadOnly: true }),
    /does not support that approval level/);
  const downgraded = await coordinator.request(child, direct.id, "ask", { threadId: selected.threadId, threadOnly: true });
  assert.equal(downgraded.tasks.find(task => task.threadId === selected.threadId).approvalMode, "ask");
  assert.equal(downgraded.approvalMode, "ask");
  console.log(JSON.stringify({ composerGrant: true, defaultRemainsAsk: true, customRefused: true, committedReply: true }));

  const parallel = await newBot("Parallel permission fixture");
  await coordinator.request(child, parallel.id, "ask");
  const working = await newTask(parallel.id, "Already running");
  // Unselected: the card stays on the running thread, and a grant for the other one never retargets it.
  const spare = await newTask(parallel.id, "Configure independently", { select: false });
  assert.equal(await send(parallel.id, `${permissionMarker}, then hold`, working.threadId), 202);
  const held = await until(async () => pendingCard(working.threadId));
  const separate = await coordinator.request(child, parallel.id, "full", { threadId: spare.threadId, threadOnly: true });
  assert.equal(separate.tasks.find(task => task.threadId === working.threadId).busy, true);
  assert.equal(separate.tasks.find(task => task.threadId === working.threadId).approvalMode, "ask");
  assert.equal(separate.tasks.find(task => task.threadId === spare.threadId).approvalMode, "full");
  // A level picked while the bot works is saved at once; the card already open stays for the person to answer.
  const whileWorking = await coordinator.request(child, parallel.id, "full", { threadId: working.threadId, threadOnly: true });
  assert.equal(whileWorking.tasks.find(task => task.threadId === working.threadId).busy, true);
  assert.equal(whileWorking.tasks.find(task => task.threadId === working.threadId).approvalMode, "full");
  assert.equal((await pendingCard(working.threadId))?.requestId, held.requestId);
  assert.equal((await api(`/api/bots/${parallel.id}/respond`, "POST", { requestId: held.requestId, threadId: working.threadId, behavior: "deny" })).status, 200);
  await until(async () => !(await readBot(parallel.id))?.busy);
  console.log(JSON.stringify({ composerGrantWhileSiblingBusy: true, siblingNotInterrupted: true, composerGrantWhileBusy: true, openCardKept: true }));

  // pi's own permission request: Ask holds a card for the person, Auto holds the provider's own request for them, and
  // Full answers it without interrupting anybody.
  const askBot = await newBot("Ask card fixture");
  await coordinator.request(child, askBot.id, "ask");
  assert.equal(await send(askBot.id, `${permissionMarker} under Ask`), 202);
  const askCard = await until(async () => pendingCard(askBot.threadId));
  assert.equal(askCard.requestType, "permission");
  assert.equal((await api(`/api/bots/${askBot.id}/respond`, "POST", { requestId: askCard.requestId, behavior: "allow" })).status, 200);
  await until(async () => !(await readBot(askBot.id))?.busy);
  console.log(JSON.stringify({ provider: "pi", mode: "ask", permissionCard: true, humanApproved: true }));

  const autoBot = await newBot("Auto card fixture");
  await coordinator.request(child, autoBot.id, "auto");
  assert.equal(await send(autoBot.id, `${permissionMarker} under Auto`), 202);
  const autoCard = await until(async () => pendingCard(autoBot.threadId));
  assert.equal(autoCard.held, "The provider requires your approval for this action.");
  assert.equal((await api(`/api/bots/${autoBot.id}/respond`, "POST", { requestId: autoCard.requestId, behavior: "deny" })).status, 200);
  await until(async () => !(await readBot(autoBot.id))?.busy);
  console.log(JSON.stringify({ provider: "pi", mode: "auto", permissionCard: true, heldForPerson: true }));

  const fullBot = await newBot("Full answers fixture");
  await coordinator.request(child, fullBot.id, "full");
  assert.equal(await send(fullBot.id, `${permissionMarker} under Full`), 202);
  await until(async () => !(await readBot(fullBot.id))?.busy);
  assert.equal(await pendingCard(fullBot.threadId), undefined);
  const fullDecisions = (await api("/api/decisions")).body.decisions
    .filter((row) => row.botId === fullBot.id && row.source === "full-access" && row.decision === "auto-approved");
  assert.ok(fullDecisions.length > 0, "Full must answer the provider's own permission request and log it");
  console.log(JSON.stringify({ provider: "pi", mode: "full", autoApproved: true, humanInterrupted: false }));

  // A delegated turn runs at the receiving thread's own level, never the sender's.
  const sender = await newBot("Delegating fixture");
  await coordinator.request(child, sender.id, "full");
  const target = await newBot("Delegated fixture");
  await coordinator.request(child, target.id, "ask");
  const capability = await api("/api/testing/internal-capability", "POST",
    { botId: sender.id, threadId: sender.threadId }, { "x-openmausbot-test-capability": testCapabilityKey });
  assert.equal(capability.status, 201);
  const peerResponse = await api("/api/internal/coordinate-bots", "POST",
    { botIds: [target.id], message: "Peer-initiated permission fixture", consult: true },
    { authorization: `Bearer ${capability.body.token}` });
  assert.equal(peerResponse.status, 200);
  // Coordination opens its own work thread without selecting it in the UI.
  const peerThreadId = peerResponse.body.receipts[0].threadId;
  assert.ok(peerThreadId);
  assert.notEqual(peerThreadId, target.threadId);
  // Its own child boot records the receiving thread's level, never the sender's.
  await until(async () => launchOf(peerThreadId));
  assert.equal(levelOf(peerThreadId), "ask");
  await until(async () => (await taskOf(target.id, peerThreadId))?.busy === false);
  console.log(JSON.stringify({ provider: "pi", mode: "ask", senderMode: "full", peerInitiated: true, piLaunch: "ask" }));

  if (process.argv.includes("--ui")) {
    await verifyUi();
    await require("./testing/sidebar-attention-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until });
  }
  console.log("Approval smoke passed; HTTP elevation rejected, private grant and pi's own level transitions verified.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (child?.pid) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  rmSync(home, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
