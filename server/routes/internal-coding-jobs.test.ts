import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCodingJobs, type GitRun } from "../coding-jobs.ts";
import { createInternalCodingJobRoutes } from "./internal-coding-jobs.ts";
import type { BotRecord } from "../store.ts";

const bot = { id: "b1" } as BotRecord;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const run: GitRun = async (args) => {
  const key = args.join(" ");
  if (key.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n", stderr: "" };
  if (key.includes("rev-parse")) return { code: 0, stdout: "abc123\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

const setup = (over: { ownsThread?: boolean } = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "coding-route-"));
  dirs.push(dataDir);
  const jobs = createCodingJobs(join(dataDir, "coding-jobs.json"));
  const handler = createInternalCodingJobRoutes({
    from: bot, fromThreadId: "t1",
    ownsThread: () => over.ownsThread !== false,
    jobs, dataDir, parentTitle: () => "parent chat", run,
  });
  return { handler, jobs };
};

const call = async (handler: ReturnType<typeof setup>["handler"], method: string, path: string, body?: unknown) => {
  let status = 0, payload: unknown = null;
  await handler({
    req: {} as never, res: {} as never, path, method,
    auth: {} as never, url: {} as never,
    json: (_res: unknown, s: number, p: unknown) => { status = s; payload = p; return undefined as never; },
    readBody: async () => body,
  } as never);
  return { status, payload } as { status: number; payload: Record<string, unknown> };
};

describe("internal coding-jobs route", () => {
  it("rejects a caller that does not own the thread", async () => {
    const { handler } = setup({ ownsThread: false });
    expect((await call(handler, "POST", "/api/internal/coding-jobs", { repo: "/r", instruction: "i" })).status).toBe(403);
    expect((await call(handler, "GET", "/api/internal/coding-jobs")).status).toBe(403);
  });

  it("prepares a worktree and returns the thread brief", async () => {
    const { handler, jobs } = setup();
    const answer = await call(handler, "POST", "/api/internal/coding-jobs", { repo: "/repo", instruction: "fix the login timeout", title: "PR: login" });
    expect(answer.status).toBe(201);
    expect(answer.payload).toMatchObject({ branch: expect.stringMatching(/^lunabot\/job-/), repo: "/repo" });
    expect(String(answer.payload.brief)).toContain("fix the login timeout");
    expect(String(answer.payload.brief)).toContain("#parent chat");
    expect(jobs.get(String(answer.payload.jobId))?.title).toBe("PR: login");
  });

  it("rejects a bad repo and attaches the opened thread", async () => {
    const { handler, jobs } = setup();
    const fail = await call(handler, "POST", "/api/internal/coding-jobs", { repo: "", instruction: "i" });
    expect(fail.status).toBe(400);
    const created = await call(handler, "POST", "/api/internal/coding-jobs", { repo: "/repo", instruction: "i" });
    const jobId = String(created.payload.jobId);
    expect((await call(handler, "PATCH", `/api/internal/coding-jobs/${jobId}`, { threadId: "th9" })).status).toBe(200);
    expect(jobs.get(jobId)?.threadId).toBe("th9");
    expect((await call(handler, "PATCH", "/api/internal/coding-jobs/unknown", { threadId: "t" })).status).toBe(404);
  });

  it("lists jobs with a live harvest", async () => {
    const { handler } = setup();
    await call(handler, "POST", "/api/internal/coding-jobs", { repo: "/repo", instruction: "i" });
    const listed = await call(handler, "GET", "/api/internal/coding-jobs");
    expect(listed.status).toBe(200);
    const rows = listed.payload.jobs as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("harvest");
  });
});
