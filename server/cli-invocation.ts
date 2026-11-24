import { basename } from "node:path";

/** How this CLI was started, so every command it prints can be pasted as is: `npx lunabot`, `pnpm omb` in a checkout, the
 * Docker image's `docker compose exec omb lunabot` (LUNABOT_CLI_PREFIX), or plain `lunabot`. `lunabot` remains an alias,
 * and a shell that started that old bin keeps seeing the old name; anything else, such as another tool run through npx,
 * prints the current name, `lunabot`. */
export function cliPrefix(env: NodeJS.ProcessEnv = process.env, script = process.argv[1] ?? ""): string {
  const fixed = env.LUNABOT_CLI_PREFIX?.trim();
  if (fixed) return fixed;
  if (env.npm_lifecycle_event === "omb") return "pnpm omb";
  // The source entry keeps its upstream filename; it is not the installed bin's name.
  const sourceEntry = /[\\/]server[\\/]lunabot\.ts$/i.test(script);
  const legacy = !sourceEntry && (/(^|[\\/])lunabot[\\/]/i.test(script)
    || (!/[\\/]dist-server[\\/]/.test(script) && basename(script).toLowerCase().startsWith("lunabot")));
  // npm 7+ runs an `npx` package from its cache's `_npx` folder (npm_command=exec alone also marks `npx vitest`).
  const npx = /[\\/]_npx[\\/]/.test(script);
  // A `lunabot` bin path needs no branch: lunabot is what every name other than the legacy one prints.
  if (legacy) return npx ? "npx lunabot" : "lunabot";
  return npx ? "npx lunabot" : "lunabot";
}

/** `lunabot <rest>` the way this CLI was started. */
export function cliCommand(rest: string, env?: NodeJS.ProcessEnv, script?: string): string {
  return `${cliPrefix(env, script)} ${rest}`;
}
