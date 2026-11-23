// macOS gives an adhoc-signed app a designated requirement of that one build's cdhash: Squirrel.Mac can never install a
// newer build over it, and every update dies in code-signature validation. This reads what codesign says about the
// running app so the updater can step aside instead of failing four times an hour.
import { spawnSync } from "node:child_process";

/** codesign writes its report to stderr; a missing binary leaves both empty. */
function codesignReport(execPath) {
  const result = spawnSync("codesign", ["-dv", "--verbose=2", execPath], { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/**
 * "adhoc" when the running app carries no signing identity, "signed" when it carries one, "unknown" when this cannot
 * tell (other platforms, a missing codesign, output this does not understand). Only "adhoc" changes the update path;
 * everything else keeps the native updater and behaves exactly as it does today.
 */
export function appSignatureKind({ platform = process.platform, execPath = process.execPath, report = codesignReport } = {}) {
  if (platform !== "darwin") return "unknown";
  const text = String(report(execPath) ?? "");
  // `CodeDirectory … flags=0x10002(adhoc,runtime)` and the `Signature=adhoc` line both say it; hardened runtime is
  // orthogonal and does not imply an identity.
  if (/^Signature=adhoc\s*$/m.test(text) || /flags=[^\n(]*\([^)\n]*\badhoc\b/.test(text)) return "adhoc";
  if (/^(?:Authority|Signature)=\S/m.test(text)) return "signed";
  return "unknown";
}
