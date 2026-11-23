import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { codingJobBrief, createCodingJobs, harvestCodingJob, prepareCodingJob, type GitRun } from "./coding-jobs.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "coding-jobs-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const okRun = (over: Partial<Record<string, { code?: number; stdout?: string; stderr?: string }>> = {}): GitRun =>
  async (args) => {
    const key = args.join(" ");
    for (const [match, out] of Object.entries(over)) if (key.includes(match)) return { code: out?.code ?? 0, stdout: out?.stdout ?? "", stderr: out?.stderr ?? "" };
    if (key.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n", stderr: "" };
    if (key.includes("rev-parse")) return { code: 0, stdout: "abc123\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

describe("coding jobs store", () => {
  it("persists jobs across instances", () => {
    const file = join(dir(), "jobs.json");
    const jobs = createCodingJobs(file);
    jobs.put({ id: "a1", repo: "/r", worktree: "/w", branch: "lunabot/job-a1", base: "abc", title: "t", instruction: "i", createdAt: 1 });
    expect(createCodingJobs(file).get("a1")?.branch).toBe("lunabot/job-a1");
    jobs.put({ id: "a1", repo: "/r", worktree: "/w", branch: "lunabot/job-a1", base: "abc", title: "t", instruction: "i", threadId: "th1", createdAt: 1 });
    expect(createCodingJobs(file).get("a1")?.threadId).toBe("th1");
  });

  it("survives a missing or malformed file", () => {
    const file = join(dir(), "jobs.json");
    writeFileSync(file, "not json");
    expect(createCodingJobs(file).all()).toEqual([]);
  });
});

describe("prepareCodingJob", () => {
  it("creates a dexbot branch worktree off HEAD", async () => {
    const calls: string[] = [];
    const run: GitRun = async (args) => { calls.push(args.join(" ")); return okRun()(args); };
    const prepared = await prepareCodingJob("/repo", "x1", join(dir(), "wt"), run);
    expect(prepared).toMatchObject({ repo: "/repo", branch: "lunabot/job-x1", base: "abc123" });
    expect(calls.some((c) => c.includes("worktree add") && c.includes("-b lunabot/job-x1"))).toBe(true);
  });

  it("rejects a non-repo and a repo with no commits", async () => {
    expect(await prepareCodingJob("/nope", "x1", join(dir(), "wt"), okRun({ "--show-toplevel": { code: 128, stderr: "not a git repo" } }))).toMatchObject({ error: expect.stringContaining("not a git repository") });
    expect(await prepareCodingJob("/repo", "x1", join(dir(), "wt"), okRun({ "rev-parse HEAD": { code: 1 } }))).toMatchObject({ error: expect.stringContaining("no commits") });
    expect(await prepareCodingJob("/repo", "x1", join(dir(), "wt"), okRun({ "worktree add": { code: 1, stderr: "already exists" } }))).toMatchObject({ error: expect.stringContaining("already exists") });
  });
});

describe("harvestCodingJob", () => {
  const job = { id: "a1", repo: "/r", worktree: "/w", branch: "b", base: "abc", title: "t", instruction: "i", createdAt: 1 };

  it("collects commits, the diff stat and dirty files", async () => {
    const run: GitRun = async (args) => {
      const key = args.join(" ");
      if (key.includes("log")) return { code: 0, stdout: "add login fix\nadd tests\n", stderr: "" };
      if (key.includes("diff")) return { code: 0, stdout: " a.ts | 4 ++--\n 1 file changed", stderr: "" };
      return { code: 0, stdout: " M loose.ts\n", stderr: "" };
    };
    expect(await harvestCodingJob(job, run)).toEqual({ commits: ["add login fix", "add tests"], diffStat: "a.ts | 4 ++--\n 1 file changed", dirty: [" M loose.ts"] });
  });

  it("reports a missing worktree as an error, not a crash", async () => {
    const run: GitRun = async () => ({ code: 128, stdout: "", stderr: "no such worktree" });
    expect((await harvestCodingJob(job, run)).error).toBe("no such worktree");
  });
});

describe("codingJobBrief", () => {
  it("pins the worktree and names the parent", () => {
    const brief = codingJobBrief({ id: "a1", repo: "/r", worktree: "/w/x", branch: "lunabot/job-a1", base: "b", title: "t", instruction: "fix it", createdAt: 1 }, "my thread");
    expect(brief).toContain("/w/x");
    expect(brief).toContain("lunabot/job-a1");
    expect(brief).toContain("#my thread");
    expect(brief).toContain("fix it");
  });
});
