// Approve-for-me's helper review on pi, only in a disposable workspace: a loopback mock stands in for the decider.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { launchVerificationServer, runControlLunabot } from "./control-lunabot.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

type HelperVerdict = "approve" | "deny" | "unsure";
let helperVerdict: HelperVerdict = "approve";
const P: Record<HelperVerdict, { refuse: number; safe: number }> = {
  approve: { refuse: 0.05, safe: 0.95 },
  deny: { refuse: 0.95, safe: 0.9 },
  unsure: { refuse: 0.1, safe: 0.6 },
};

const deciderMock = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let questionIds: string[] = ["answer"];
    try {
      const parsed = JSON.parse(body) as { response_format?: { json_schema?: { schema?: { properties?: { answers?: { properties?: Record<string, unknown> } } } } } };
      const ids = parsed.response_format?.json_schema?.schema?.properties?.answers?.properties;
      if (ids && Object.keys(ids).length) questionIds = Object.keys(ids);
    } catch {}
    const p = P[helperVerdict];
    const answers = Object.fromEntries(questionIds.map((id) => [id, {
      type: "noul", noul: id === "refuse" ? p.refuse : id === "safe" ? p.safe : 0.9,
    }]));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      model: "fixture/decider",
      choices: [{ message: { role: "assistant", content: JSON.stringify({ answers }) } }],
    }));
  });
});
await new Promise<void>((resolve) => deciderMock.listen(0, "127.0.0.1", resolve));
const deciderPort = (deciderMock.address() as { port: number }).port;

const fixture = await launchVerificationServer({
  ...process.env,
  FAKE_PI_PERMISSION_ON: "perm-trigger",
  FAKE_PI_CONFIRM_TITLE: "Allow bash?",
  FAKE_PI_CONFIRM_MESSAGE: JSON.stringify({ command: "ls" }),
});
try {
  const api = fixtureApi(fixture.info.url);
  // The save-time key check reads the already-saved base URL, so the address and model land first.
  await api("PATCH", "/api/config", {
    decider: {
      provider: "openrouter",
      openrouterBaseUrl: `http://127.0.0.1:${deciderPort}/v1`,
      openrouterModel: "vendor/model",
      openrouterApi: "chat",
    },
  });
  await api("PATCH", "/api/config", { decider: { openrouterKey: "fixture" } });
  await api("PATCH", "/api/config", { decider: { enabled: true } });
  const created = await runControlLunabot(["new-bot", "--name", "Review Bot", "--url", fixture.info.url]) as { bot?: { id: string }; id?: string };
  const botId = created.bot?.id ?? created.id;
  assert.ok(botId, "new-bot returned no bot id");
  await api("PATCH", `/api/bots/${botId}`, { approvalMode: "auto" });

  const messages = async () => (await runControlLunabot(["messages", "--bot", botId, "--limit", "40", "--url", fixture.info.url]) as { messages?: unknown[] }).messages ?? [];
  const decisionRows = () => readdirSync(join(fixture.info.dataDir, "decisions")).flatMap((file) =>
    readFileSync(join(fixture.info.dataDir, "decisions", file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { decision: string; source: string; tool?: string }));
  const cardFor = async (marker: (m: unknown) => boolean, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await messages()).find(marker);
      if (found) return found as { card?: { answered?: string; dismissed?: boolean; subtitle?: string }; id: string };
      if (Date.now() > deadline) throw new Error(`card not found within ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const isPermissionCard = (m: unknown) => typeof m === "object" && m !== null &&
    (m as { card?: { subtitle?: string } }).card?.subtitle?.startsWith("Allow bash?") === true;

  helperVerdict = "approve";
  await runControlLunabot(["send", "--bot", botId, "--text", "perm-trigger", "--url", fixture.info.url]);
  const approvedCard = await cardFor((m) => isPermissionCard(m) && Boolean((m as { card?: { answered?: string } }).card?.answered));
  assert.equal(approvedCard.card?.answered, "allow", "the helper's allow must settle the card");
  assert.equal(approvedCard.card?.dismissed, true, "an auto answer dismisses the card like an engine grant");
  assert.ok((await messages()).some((m) => JSON.stringify(m).includes("Approve for me approved")), "no Approve-for-me chip after the allow");
  assert.ok(decisionRows().some((row) => row.decision === "auto-approved" && row.source === "auto-review" && row.tool === "bash"),
    `no auto-approved/auto-review row: ${JSON.stringify(decisionRows())}`);

  helperVerdict = "deny";
  await runControlLunabot(["send", "--bot", botId, "--text", "perm-trigger", "--url", fixture.info.url]);
  const deniedCard = await cardFor((m) => isPermissionCard(m) && (m as { card?: { answered?: string } }).card?.answered === "deny" &&
    (m as { id: string }).id !== approvedCard.id);
  assert.ok((await messages()).some((m) => JSON.stringify(m).includes("Approve for me denied")), "no deny chip after the refusal");
  assert.ok(decisionRows().some((row) => row.decision === "auto-denied" && row.source === "auto-review"),
    `no auto-denied/auto-review row: ${JSON.stringify(decisionRows())}`);

  helperVerdict = "unsure";
  await runControlLunabot(["send", "--bot", botId, "--text", "perm-trigger", "--url", fixture.info.url]);
  const openCard = await cardFor((m) => isPermissionCard(m) && !((m as { card?: { answered?: string } }).card?.answered) &&
    ![approvedCard.id, deniedCard.id].includes((m as { id: string }).id));
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const stillOpen = (await messages()).find((m) => (m as { id: string }).id === openCard.id) as { card?: { answered?: string } };
  assert.equal(stillOpen?.card?.answered, undefined, "an unsure helper must leave the card for the person");

  console.log("verify-approval-review: ok");
} finally {
  await fixture.close();
  deciderMock.close();
}
