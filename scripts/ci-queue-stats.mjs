#!/usr/bin/env node
// How much of a CI run is spent waiting for a runner: for each recent
// completed ci.yml run, `queue` is the gap between the run's creation and its
// first job's start, and `work` is the span from that first start to the last
// job's end (which still holds the gaps between its jobs). Prints one row per
// run and the medians. Usage:
//
//   GH_TOKEN=$(gh auth token) node scripts/ci-queue-stats.mjs [owner/repo] [count]
//
// The repo defaults to origin's; count defaults to 30.

import { execFileSync } from "node:child_process";

const count = Number(process.argv[3] ?? 30) || 30;
const repo = process.argv[2] ?? execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" })
  .trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
if (!repo) throw new Error("pass owner/repo or set an origin remote");
if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is needed to read the Actions API (gh auth token)");

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} reading ${path.split("?")[0]}`);
  return response.json();
}

const { workflow_runs: runs } = await github(`/actions/workflows/ci.yml/runs?per_page=${count}&status=completed`);
const rows = [];
for (const run of runs) {
  const { jobs } = await github(`/actions/runs/${run.id}/jobs?per_page=100`);
  const times = jobs.filter((job) => job.started_at && job.completed_at);
  if (!times.length) continue;
  const first = Math.min(...times.map((job) => Date.parse(job.started_at)));
  const last = Math.max(...times.map((job) => Date.parse(job.completed_at)));
  rows.push({
    event: run.event, run: run.id,
    queue: (first - Date.parse(run.created_at)) / 60_000,
    work: (last - first) / 60_000,
  });
}

const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const show = (list, label) => {
  if (!list.length) return;
  for (const row of list) console.log(`${label.padEnd(13)} ${String(row.queue.toFixed(1)).padStart(5)}m queue ${String(row.work.toFixed(1)).padStart(6)}m work  run ${row.run}`);
  console.log(`${label} median: ${median(list.map((row) => row.queue)).toFixed(1)}m queue, ${median(list.map((row) => row.work)).toFixed(1)}m work (${list.length} runs)\n`);
};

for (const event of new Set(rows.map((row) => row.event))) show(rows.filter((row) => row.event === event), event);
show(rows, "all");
