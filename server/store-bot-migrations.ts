// Legacy bots.json record cleanups, one pass on load. wireBot spreads what a record
// carries, so a field no current build reads would still reach clients; deleting it
// here makes the next save drop it for good.
import type { BotRecord } from "./store.ts";

export function migrateBotRecords(bots: BotRecord[]): boolean {
  let migrated = false;
  for (const b of bots as Array<BotRecord & { peers?: unknown; approvePeerComms?: unknown; cacheKeepWarm?: unknown }>) {
    if (!("peers" in b) && !("approvePeerComms" in b) && !("cacheKeepWarm" in b)) continue;
    delete b.peers;
    delete b.approvePeerComms;
    delete b.cacheKeepWarm;
    migrated = true;
  }
  // The home capability never had an executor behind it and is gone; a grant
  // left in a saved record would fail the strict normalizePhoneApps on the
  // next patch, so it is scrubbed here instead.
  for (const b of bots) {
    if (b.phoneApps && "home" in b.phoneApps) {
      delete b.phoneApps.home;
      migrated = true;
    }
  }
  // Recover only app-issued provider-tool grants into bot defaults, never task/session grants such as shell commands.
  for (const b of bots) {
    const taskProviderGrants = (b.tasks ?? []).flatMap((task) =>
      (task.alwaysAllow ?? []).filter((key) => key.startsWith("provider-tool:")),
    );
    if (!taskProviderGrants.length) continue;
    const merged = [...new Set([...(b.alwaysAllow ?? []), ...taskProviderGrants])].slice(0, 200);
    if (JSON.stringify(merged) === JSON.stringify(b.alwaysAllow ?? [])) continue;
    b.alwaysAllow = merged;
    migrated = true;
  }
  return migrated;
}
