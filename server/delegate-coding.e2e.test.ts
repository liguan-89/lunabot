// The delegate_coding path end to end: a scripted agents call prepares the worktree and record,
// opens the self thread through the normal report-back path, and the job file links them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { runControlOmb } from "../scripts/control-omb.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it("delegates coding into an isolated worktree thread", async () => {
  process.env.LUNABOT_GIT_PATH = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const repo = mkdtempSync(join(tmpdir(), "delegate-repo-"));
  dirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"], { cwd: repo });

  const server = await launchRestartableServer({ engine: "pi", scripted: true });
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Coder", "--url", server.url]) as { bot: { id: string } };
    writeFileSync(join(server.dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { turns: [
        { steps: [{ tool: "delegate_coding", arguments: { repo, instruction: "Rename README to README.md", title: "PR: readme" } }], reply: "Delegated the job." },
        { reply: "Renamed it." },
        { reply: "The job finished." },
      ] },
    }));
    await runControlOmb(["send", "--bot", bot.id, "--text", "Delegate the rename.", "--url", server.url]);
    const waited = await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", server.url]) as { state?: string };
    expect(waited.state).toBe("completed");

    const jobsFile = join(server.dataDir, "coding-jobs.json");
    await expect.poll(() => {
      if (!existsSync(jobsFile)) return "";
      const jobs = (JSON.parse(readFileSync(jobsFile, "utf8")) as { jobs: Record<string, { threadId?: string; worktree: string }> }).jobs;
      return Object.values(jobs).find((job) => job.threadId)?.worktree ?? "";
    }, { timeout: 30_000 }).not.toBe("");
    const job = Object.values((JSON.parse(readFileSync(jobsFile, "utf8")) as { jobs: Record<string, { worktree: string; branch: string; repo: string }> }).jobs)[0]!;
    expect(existsSync(join(job.worktree, ".git"))).toBe(true);
    expect(realpathSync(job.repo)).toBe(realpathSync(repo));
    expect(job.branch).toMatch(/^dexbot\/job-/);
    // `+ ` marks a branch checked out in a linked worktree — the isolation this test exists for.
    expect(execFileSync("git", ["-C", repo, "branch", "--list", job.branch], { encoding: "utf8" }).trim()).toBe(`+ ${job.branch}`);
  } finally {
    await server.close();
  }
}, 120_000);
