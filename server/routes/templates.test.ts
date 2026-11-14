import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { createBotPackageExport } from "../package-export.ts";
import type { BotRecord } from "../store.ts";
import { createTemplateRoutes } from "./templates.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function packageDocument() {
  const bot: BotRecord = {
    id: "b1", threadId: "t1", name: "Lead", title: "Researcher", description: "Researches leads",
    notifications: true, color: "green", unread: false,
    modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
    resumeCursors: {}, createdAt: 1,
  };
  return createBotPackageExport({ name: "Research Team", bots: [bot], groups: [], routines: [] });
}

async function serve(): Promise<{ base: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "omb-templates-"));
  dirs.push(dir);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([createTemplateRoutes({ templatesDir: () => dir })], {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir };
}

describe("template routes", () => {
  it("saves, lists, fetches and deletes a template; install stays the existing import route", async () => {
    const { base } = await serve();
    expect(await (await fetch(`${base}/api/templates`)).json()).toEqual({ templates: [] });

    const saved = await fetch(`${base}/api/templates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: packageDocument() }) });
    expect(saved.status).toBe(201);
    const { template } = await saved.json() as { template: { slug: string; summary: { name: string } } };
    expect(template.slug).toBe("research-team");

    const listed = await (await fetch(`${base}/api/templates`)).json() as { templates: Array<{ slug: string }> };
    expect(listed.templates.map((t) => t.slug)).toEqual(["research-team"]);

    const fetched = await fetch(`${base}/api/templates/research-team`);
    expect((await fetched.json() as { document: { format: string } }).document.format).toBe("openmaus.package");

    expect((await fetch(`${base}/api/templates/research-team`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/api/templates/research-team`)).status).toBe(404);
  });

  it("rejects a non-package body and bad slugs cleanly", async () => {
    const { base } = await serve();
    const bad = await fetch(`${base}/api/templates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: { nope: true } }) });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/templates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
    expect((await fetch(`${base}/api/templates/No.good`)).status).toBe(404);
  });
});
