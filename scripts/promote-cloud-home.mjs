// Points lunabot-cloud-home:local on the DEX Cloud host at one released
// image, then rebuilds every running Cloud container on it. That tag is what
// the provisioner's cloudImage default reads; nothing else moves it, so this
// is what keeps our own Clouds on the release track (the soak fleet
// promote-stable.yml counts on). publish-desktop-feed.mjs calls it at the
// end; it also runs on its own:
//
//   node scripts/promote-cloud-home.mjs --version 2.1.8 [--dry-run]
//     [--skip-reprovision] [--cloud c-aaa,c-bbb]
//
// The image is tagged by digest, not the moving :v* tag. The previous :local
// keeps a lunabot-cloud-home:rollback-<version> tag — to go back:
//   ssh wholesale 'docker tag lunabot-cloud-home:rollback-<v> lunabot-cloud-home:local'
//   then re-run with --version <v> --skip-pull… or just re-run this script for
//   the older version (it re-pulls the same digest).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SSH_HOST = process.env.LUNABOT_PUBLISH_HOST || "wholesale";
const REPO = process.env.LUNABOT_CLOUD_HOME_REPO || "ghcr.io/liguan-89/lunabot-cloud-home";
const LOCAL_TAG = process.env.LUNABOT_CLOUD_HOME_TAG || "lunabot-cloud-home:local";
const CONTROL = process.env.LUNABOT_DEXCLOUD_CONTAINER || "dex-cloud-cloud-1";
const CONTAINER_PREFIX = "dexcloud-c-";
const REPROVISION_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dex-cloud/src/reprovision.mjs");

function fail(message) {
  console.error(`[promote-cloud-home] ${message}`);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

const dryRun = process.argv.includes("--dry-run");
const skipReprovision = process.argv.includes("--skip-reprovision");
const version = argValue("--version")?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail("--version X.Y.Z is required");
const requestedIds = argValue("--cloud")?.split(",").map((id) => id.trim()).filter(Boolean) ?? null;

const imageRef = `${REPO}:v${version}`;

function ssh(command, { input } = {}) {
  return execFileSync("ssh", [SSH_HOST, command], { encoding: "utf8", ...(input ? { input } : {}) }).trim();
}

function docker(args) {
  return ssh(`docker ${args}`);
}

/** `docker inspect`-style label read; empty when the reference does not exist. */
function labelOf(image, label) {
  return docker(`image inspect ${image} --format '{{index .Config.Labels "${label}"}}' 2>/dev/null || true`).trim();
}

// The release tag carries the release's own revision; anything else is the
// wrong build and must not be promoted.
const targetRef = imageRef;
console.log(`[promote-cloud-home] ${targetRef} → ${SSH_HOST}:${LOCAL_TAG}${dryRun ? " (dry-run)" : ""}`);
if (!dryRun) execFileSync("ssh", [SSH_HOST, `docker pull -q ${targetRef}`], { stdio: "inherit" });
const pulledId = dryRun ? "?" : docker(`image inspect ${targetRef} --format '{{.Id}}'`);
if (!dryRun && !pulledId) fail(`image not found on ${SSH_HOST} after pull: ${targetRef}`);
const digest = dryRun ? "@sha256:…" : docker(`image inspect ${targetRef} --format '{{range .RepoDigests}}{{println .}}{{end}}'`)
  .split("\n").find((line) => line.startsWith(`${REPO}@`));
if (!dryRun && !digest) fail(`${targetRef} has no RepoDigests entry on ${SSH_HOST}`);
const rev = dryRun ? "?" : labelOf(targetRef, "org.opencontainers.image.revision");
const labeled = dryRun ? `v${version}` : labelOf(targetRef, "org.opencontainers.image.version");
if (!dryRun && labeled !== `v${version}`) fail(`${targetRef} is labelled version=${labeled}, not v${version}`);

// What :local points at today becomes the named rollback (when it is a
// release build; anything else gets a tag on its short id instead).
const currentId = dryRun ? "?" : docker(`image inspect ${LOCAL_TAG} --format '{{.Id}}' 2>/dev/null || true`).trim();
const currentVersion = dryRun ? "?" : labelOf(LOCAL_TAG, "org.opencontainers.image.version");
const rollbackTag = `lunabot-cloud-home:rollback-${currentVersion?.replace(/^v/, "") || currentId?.replace(/^sha256:/, "").slice(0, 12) || "none"}`;

const plan = [
  `pull ${targetRef} (rev ${rev})`,
  currentId ? `tag ${LOCAL_TAG} → ${rollbackTag}` : "(no current :local — first promote)",
  `tag ${digest} → ${LOCAL_TAG}`,
];
const containers = dryRun ? ["dexcloud-c-…"] : docker(`ps --filter name=^${CONTAINER_PREFIX} --format '{{.Names}}'`)
  .split("\n").filter(Boolean);
const ids = requestedIds ?? containers.map((name) => name.replace(/^dexcloud-/, ""));
if (skipReprovision) plan.push("reprovision skipped (--skip-reprovision): running clouds keep the old image");
else if (!ids.length) plan.push("no running dexcloud-* containers — nothing to rebuild");
else plan.push(`rebuild ${ids.length} cloud(s): ${ids.join(", ")}`);
for (const line of plan) console.log(`  ${line}`);
if (dryRun) {
  console.log("[promote-cloud-home] dry-run complete; nothing changed");
  process.exit(0);
}

if (currentId) docker(`tag ${LOCAL_TAG} ${rollbackTag}`);
docker(`tag ${digest} ${LOCAL_TAG}`);

let failed = 0;
if (!skipReprovision && ids.length) {
  // reprovision.mjs may not exist in the running control-plane image yet, so
  // it is streamed over stdin; -w /app/src makes its ./config.js imports land.
  const script = readFileSync(REPROVISION_SOURCE, "utf8");
  let out;
  try {
    out = ssh(
      `docker exec -i -w /app/src -e LUNABOT_REPROVISION_IDS=${ids.join(",")} ${CONTROL} ` +
      `node --experimental-sqlite --input-type=module -`,
      { input: script },
    );
  } catch (error) {
    fail(`reprovision did not run (control-plane ${CONTROL} unreachable?): ${error?.stderr ?? error?.message}`);
  }
  console.log(out);
  for (const line of out.split("\n")) {
    const match = /^(c-[0-9a-f]+) (\w+)$/.exec(line.trim());
    if (match && match[2] !== "ready") failed += 1;
  }
  // Prove the rebuilt containers run the release we tagged, not some stale image.
  for (const id of ids) {
    const containerName = `dexcloud-${id}`;
    const running = docker(`inspect ${containerName} --format '{{.Image}}' 2>/dev/null || true`);
    const health = docker(`exec ${containerName} sh -c 'curl -sf http://127.0.0.1:8799/api/health' 2>/dev/null || true`);
    const seen = /"version":"(\d+\.\d+\.\d+)"/.exec(health)?.[1] ?? "?";
    if (running !== pulledId || seen !== version) {
      console.error(`  ${containerName}: image=${running} api=${seen} — expected image ${pulledId} api ${version}`);
      failed += 1;
    } else {
      console.log(`  ${containerName} on ${version} (${running.slice(0, 19)}…)`);
    }
  }
}

console.log(`[promote-cloud-home] ${LOCAL_TAG} now ${digest} (rollback: ${rollbackTag})`);
process.exit(failed ? 1 : 0);
