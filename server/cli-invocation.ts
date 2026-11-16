import { basename } from "node:path";

/** How this CLI was started, so every command it prints can be pasted as is: `npx lunabot`, `npx dexbot`,
 * `pnpm omb` in a checkout, the Docker image's `docker compose exec omb dexbot` (OMB_CLI_PREFIX), or plain
 * `lunabot`/`dexbot`. `openmausbot` remains an alias, and a shell that started the old bin keeps seeing the old name. */
export function cliPrefix(env: NodeJS.ProcessEnv = process.env, script = process.argv[1] ?? ""): string {
  const fixed = env.OMB_CLI_PREFIX?.trim();
  if (fixed) return fixed;
  if (env.npm_lifecycle_event === "omb") return "pnpm omb";
  // The source entry keeps its upstream filename; it is not the installed bin's name.
  const sourceEntry = /[\\/]server[\\/]openmausbot\.ts$/i.test(script);
  const legacy = !sourceEntry && (/(^|[\\/])openmausbot[\\/]/i.test(script)
    || (!/[\\/]dist-server[\\/]/.test(script) && basename(script).toLowerCase().startsWith("openmausbot")));
  const lunabot = !sourceEntry && !legacy && (/(^|[\\/])lunabot[\\/]/i.test(script)
    || (!/[\\/]dist-server[\\/]/.test(script) && basename(script).toLowerCase().startsWith("lunabot")));
  // npm 7+ runs an `npx` package from its cache's `_npx` folder (npm_command=exec alone also marks `npx vitest`).
  if (/[\\/]_npx[\\/]/.test(script)) return legacy ? "npx openmausbot" : lunabot ? "npx lunabot" : "npx dexbot";
  return legacy ? "openmausbot" : lunabot ? "lunabot" : "dexbot";
}

/** `dexbot <rest>` the way this CLI was started. */
export function cliCommand(rest: string, env?: NodeJS.ProcessEnv, script?: string): string {
  return `${cliPrefix(env, script)} ${rest}`;
}
