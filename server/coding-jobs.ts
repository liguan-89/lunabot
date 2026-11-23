// Delegated coding jobs: a self-opened thread works an isolated git worktree (never the person's
// live checkout), commits on its own branch, and the job registry survives a restart so a later turn
// can read back what changed. The thread runs through the normal report-back path; this module owns
// the worktree, the record and the diff harvest.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { parseJson } from "./schema.ts";

export interface CodingJob {
  id: string;
  repo: string;
  worktree: string;
  branch: string;
  base: string;
  title: string;
  instruction: string;
  /** Set once the self thread is opened. */
  threadId?: string;
  createdAt: number;
}

export type GitRun = (args: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const realRun: GitRun = (args, cwd) => new Promise((resolve) => {
  // LUNABOT_GIT_PATH: sealed test environments keep git off PATH.
  execFile(process.env.LUNABOT_GIT_PATH || "git", args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
  });
});

const shape = z.object({ jobs: z.record(z.string(), z.object({
  id: z.string(), repo: z.string(), worktree: z.string(), branch: z.string(), base: z.string(),
  title: z.string(), instruction: z.string(), threadId: z.string().optional(), createdAt: z.number(),
})) }).catch({ jobs: {} });

export interface CodingJobs {
  all(): CodingJob[];
  get(id: string): CodingJob | undefined;
  put(job: CodingJob): void;
}

export function createCodingJobs(file: string): CodingJobs {
  const read = (): Record<string, CodingJob> => {
    try { return existsSync(file) ? shape.parse(parseJson(readFileSync(file, "utf8"))).jobs : {}; }
    catch { return {}; }
  };
  return {
    all: () => Object.values(read()),
    get: (id) => read()[id],
    put: (job) => writeFileSync(file, JSON.stringify({ jobs: { ...read(), [job.id]: job } })),
  };
}

export interface PreparedJob {
  repo: string;
  worktree: string;
  branch: string;
  base: string;
}

/** Resolve the repo root, then check out a fresh `lunabot/job-*` branch in a worktree under the data dir. */
export async function prepareCodingJob(repo: string, jobId: string, worktreesDir: string, run: GitRun = realRun): Promise<PreparedJob | { error: string }> {
  const top = await run(["-C", repo, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) return { error: `${repo} is not a git repository${top.stderr.trim() ? `: ${top.stderr.trim()}` : ""}` };
  const root = top.stdout.trim();
  const base = await run(["-C", root, "rev-parse", "HEAD"]);
  if (base.code !== 0 || !base.stdout.trim()) return { error: `${root} has no commits yet` };
  const worktree = join(worktreesDir, jobId);
  mkdirSync(worktreesDir, { recursive: true });
  const branch = `lunabot/job-${jobId}`;
  const added = await run(["-C", root, "worktree", "add", worktree, "-b", branch]);
  if (added.code !== 0) return { error: `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}` };
  return { repo: root, worktree, branch, base: base.stdout.trim() };
}

export interface CodingHarvest {
  commits: string[];
  diffStat: string;
  dirty: string[];
  error?: string;
}

/** Read what the job's branch did so far: committed subjects, a `diff --stat`, and any uncommitted files. */
export async function harvestCodingJob(job: CodingJob, run: GitRun = realRun): Promise<CodingHarvest> {
  const commits = await run(["-C", job.worktree, "log", "--format=%s", `${job.base}..HEAD`]);
  const stat = await run(["-C", job.worktree, "diff", "--stat", `${job.base}...HEAD`]);
  const dirty = await run(["-C", job.worktree, "status", "--short"]);
  if (commits.code !== 0 || stat.code !== 0 || dirty.code !== 0) {
    return { commits: [], diffStat: "", dirty: [], error: (commits.stderr || stat.stderr || dirty.stderr).trim() || "worktree is gone" };
  }
  return {
    commits: commits.stdout.split("\n").filter(Boolean),
    diffStat: stat.stdout.trim(),
    dirty: dirty.stdout.split("\n").filter(Boolean),
  };
}

/** The first message of the job's own thread: pins the worktree so pi edits it and only it. */
export function codingJobBrief(job: CodingJob, parentTitle: string): string {
  return [
    `[Coding job ${job.id}${parentTitle ? ` delegated from #${parentTitle}` : ""}. Work only inside the worktree at ${job.worktree} on branch ${job.branch} — never touch ${job.repo} directly or the person's working tree. Commit your changes on ${job.branch} and leave the tree clean (everything committed) when you finish.]`,
    "",
    job.instruction,
  ].join("\n");
}
