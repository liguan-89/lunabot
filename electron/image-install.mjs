// An adhoc-signed macOS app swaps in its own update: the new bundle is copied out of the release's disk image, then a
// detached shell script moves it into place once this process has quit — the disk image never opens for the person.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The detached half of the install, carried entirely by the environment it is spawned with. Waits for the app's pid
 * to die, moves the old bundle aside, copies the staged one into place, and reopens it. On any failure the previous
 * copy is restored and reopened, so the worst outcome is the version already running. */
export const SWAP_SCRIPT = `\
set -u
log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] image-swap: $*" >> "$LUNABOT_SWAP_LOG"; }
n=0
while kill -0 "$LUNABOT_SWAP_PID" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 600 ]; then log "gave up waiting for pid $LUNABOT_SWAP_PID"; exit 1; fi
  sleep 1
done
sleep 1
old="$LUNABOT_SWAP_TARGET.lunabot-swap-old"
rm -rf "$old"
if mv "$LUNABOT_SWAP_TARGET" "$old"; then
  if ditto "$LUNABOT_SWAP_STAGED" "$LUNABOT_SWAP_TARGET"; then
    xattr -dr com.apple.quarantine "$LUNABOT_SWAP_TARGET" 2>/dev/null
    rm -rf "$old" "$LUNABOT_SWAP_STAGED"
    log "installed \${LUNABOT_SWAP_VERSION:-the update}; reopening"
    open "$LUNABOT_SWAP_TARGET"
    exit 0
  fi
  rm -rf "$LUNABOT_SWAP_TARGET"
  mv "$old" "$LUNABOT_SWAP_TARGET"
  log "copy failed; restored the previous copy"
else
  log "could not move $LUNABOT_SWAP_TARGET aside"
fi
open "$LUNABOT_SWAP_TARGET" 2>/dev/null
exit 1
`;

/**
 * @param {{
 *   run?(cmd: string, args: string[]): Promise<{stdout: string | Buffer}>,
 *   spawnImpl?: typeof spawn,
 *   logFile?: string | null,
 *   log?(line: string): void,
 * }} deps `run` executes hdiutil/ditto; `spawnImpl` starts the detached swap script.
 */
export function createImageInstall({ run = (cmd, args) => execFileAsync(cmd, args), spawnImpl = spawn, logFile = null, log = () => {} } = {}) {
  async function mount(dmg) {
    const { stdout } = await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-plist", dmg]);
    const point = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(String(stdout))?.[1];
    if (!point) throw new Error("the disk image did not mount");
    return point;
  }

  /** The bundle copied out of the mounted image; the image is always detached before this returns. */
  async function stage(dmg, stagingDir) {
    const point = await mount(dmg);
    try {
      const name = readdirSync(point).find((entry) => entry.endsWith(".app"));
      if (!name) throw new Error("the disk image holds no app");
      rmSync(stagingDir, { recursive: true, force: true });
      mkdirSync(stagingDir, { recursive: true });
      const staged = join(stagingDir, name);
      await run("ditto", [join(point, name), staged]);
      return staged;
    } finally {
      await run("hdiutil", ["detach", point, "-quiet"]).catch(() => {});
    }
  }

  /** Copies the bundle out of `dmg` and arms the swap: a detached script that installs it over `targetApp` once `pid`
   * exits. Resolves once the swap is armed; throws when the image cannot be staged, before anything is armed. */
  async function install(dmg, { stagingDir, targetApp, pid, version = null }) {
    const staged = await stage(dmg, stagingDir);
    spawnImpl("sh", ["-c", SWAP_SCRIPT, "lunabot-image-swap"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        LUNABOT_SWAP_PID: String(pid),
        LUNABOT_SWAP_TARGET: targetApp,
        LUNABOT_SWAP_STAGED: staged,
        LUNABOT_SWAP_LOG: logFile ?? "/dev/null",
        ...(version ? { LUNABOT_SWAP_VERSION: version } : {}),
      },
    }).unref();
    log(`armed the ${version ?? "update"} swap over ${targetApp}`);
    return staged;
  }

  return { install };
}
