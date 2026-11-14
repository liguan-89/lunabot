// The delegate_coding tool's route: prepares the job's worktree and record (the tool then opens the
// self thread through /api/internal/threads and PATCHes its id back), and reads jobs back with a
// live diff harvest.
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { codingJobBrief, harvestCodingJob, prepareCodingJob, type CodingJobs, type GitRun } from "../coding-jobs.ts";
import type { BotRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createInternalCodingJobRoutes(deps: {
  from: BotRecord;
  fromThreadId: string;
  ownsThread(botId: string, threadId: string): boolean;
  jobs: CodingJobs;
  dataDir: string;
  parentTitle(threadId: string): string;
  run?: GitRun;
}): RouteHandler {
  const { from, fromThreadId, jobs } = deps;
  const run = deps.run;
  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/api/internal/coding-jobs")) return PASS;
    if (!deps.ownsThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    if (method === "GET" && path === "/api/internal/coding-jobs") {
      const out = [];
      for (const job of jobs.all()) {
        out.push({ ...job, harvest: await harvestCodingJob(job, run) });
      }
      return json(res, 200, { jobs: out });
    }
    const attach = method === "PATCH" ? path.match(/^\/api\/internal\/coding-jobs\/([\w-]+)$/) : null;
    if (attach) {
      const job = jobs.get(attach[1]!);
      if (!job) return json(res, 404, { error: "no such coding job" });
      const body = await readBody(req, 4_096);
      const threadId = body && typeof body === "object" ? String((body as { threadId?: unknown }).threadId ?? "").trim() : "";
      if (!threadId) return json(res, 400, { error: "threadId is required" });
      jobs.put({ ...job, threadId });
      return json(res, 200, { ok: true, jobId: job.id, threadId });
    }
    if (method !== "POST" || path !== "/api/internal/coding-jobs") return PASS;
    const body = await readBody(req, 65_536);
    const repo = body && typeof body === "object" ? String((body as { repo?: unknown }).repo ?? "").trim() : "";
    const instruction = body && typeof body === "object" ? String((body as { instruction?: unknown }).instruction ?? "").trim() : "";
    const title = body && typeof body === "object" ? String((body as { title?: unknown }).title ?? "").trim() : "";
    if (!repo || !instruction) return json(res, 400, { error: "repo and instruction are required" });
    const jobId = randomUUID().slice(0, 8);
    const prepared = await prepareCodingJob(repo, jobId, join(deps.dataDir, "coding-worktrees"), run);
    if ("error" in prepared) return json(res, 400, { error: prepared.error });
    const job = {
      id: jobId, ...prepared,
      title: title || instruction.split("\n")[0]!.slice(0, 60),
      instruction, createdAt: Date.now(),
    };
    jobs.put(job);
    return json(res, 201, { jobId, worktree: prepared.worktree, branch: prepared.branch, repo: prepared.repo, brief: codingJobBrief(job, deps.parentTitle(fromThreadId)) });
  };
}
