// The environment a boxed process gets: an allow-list, never the server's whole environment. The drivers already strip
// the workspace credentials and every LUNABOT_CLOUD_ setting before a spawn (server/config.ts stripWorkspaceCredentialEnv);
// this is the second gate, applied at the box boundary, so a name a driver forgot never reaches a bot's shell.

/** Names a bot's engine, its tools and the proxies Luna Bot starts inside the box may read. */
export const BOX_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "HOSTNAME", "PWD",
  "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "TMPDIR", "NO_COLOR", "FORCE_COLOR", "CI", "DEBUG",
  "NODE_ENV", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  "AGENT_BROWSER_EXECUTABLE_PATH", "BROWSER", "BASH_MAX_TIMEOUT_MS", "ELECTRON_RUN_AS_NODE", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
]);

/** Luna Bot's own variables a boxed process reads: what the harness sets for a bot's engine, its hooks and the MCP
 * proxies it starts. Security: no other `LUNABOT_` name passes, whatever the operator set on the server (an SMTP URL, a
 * token); env.test.ts lists every `LUNABOT_` name the server knows, so a new one needs a decision. */
export const BOX_ENV_LUNABOT_NAMES: ReadonlySet<string> = new Set([
  "LUNABOT_HARNESS_URL", "LUNABOT_BOT_ID", "LUNABOT_THREAD_ID", "LUNABOT_APPROVAL_MODE", "LUNABOT_COMMS_TOKEN", "LUNABOT_TURN_DEPTH", "LUNABOT_EXTERNAL_RUNTIME",
  "LUNABOT_CHIEF_OF_STAFF", "LUNABOT_MAUSBOT", "LUNABOT_SKILL_AUTHORING_ENABLED", "LUNABOT_MEMORY_ENABLED", "LUNABOT_SHARED_COMPUTERS_ENABLED",
  "LUNABOT_VOICE_NOTES", "LUNABOT_X_RESEARCH", "LUNABOT_RESEARCH", "LUNABOT_TEAM_PEOPLE", "LUNABOT_COMPUTER_SELECTION", "LUNABOT_ROOM",
  "LUNABOT_IMAGE_GENERATION", "LUNABOT_VIDEO_GENERATION", "LUNABOT_MEETINGS", "LUNABOT_TOOL_SELECTION", "LUNABOT_AGENTS_TOOL_BRIDGE", "LUNABOT_TOOL_LIMIT", "LUNABOT_TOOL_SCHEMA_PROFILE",
  "LUNABOT_MCP_CONFIG", "LUNABOT_MCP_RESTART", "LUNABOT_MCP_RESULT_BUDGET",
  "LUNABOT_HOOK_URL", "LUNABOT_HOOK_TOKEN_FILE", "LUNABOT_HOOK_TIMEOUT_MS", "LUNABOT_PERMISSION_TOOL_SCOPE",
  "LUNABOT_CONNECTOR_UPSTREAM_URL", "LUNABOT_CONNECTOR_UPSTREAM_HEADERS", "LUNABOT_CONNECTOR_TOKEN", "LUNABOT_CONNECTOR_ALLOWED_TOOLS",
  "LUNABOT_CONNECTOR_SERVICE_SLUGS", "LUNABOT_CONNECTOR_APP_TOOLS", "LUNABOT_CONNECTOR_APP_TOOL_NAMES",
  "LUNABOT_GATE_NAME", "LUNABOT_GATE_UPSTREAM", "LUNABOT_GATE_BUDGET", "LUNABOT_GATE_SPILL_DIR", "LUNABOT_GATE_SPILL_HINT", "LUNABOT_GATE_TOOL_SCOPE",
  "LUNABOT_GATE_DIRECTORY", "LUNABOT_GATE_APPS", "LUNABOT_REMOTE_MCP_SERVER", "LUNABOT_REMOTE_MCP_DIRECTORY", "LUNABOT_REMOTE_MCP_APPS",
  "LUNABOT_CONTROL_URL", "LUNABOT_CONTROL_TOKEN", "LUNABOT_COMPUTER_JOURNAL", "LUNABOT_CUA_ARGS", "LUNABOT_CUA_COMMAND", "LUNABOT_CUA_PLATFORM",
  "LUNABOT_PHONE_TOKEN", "LUNABOT_ADB_PATH", "LUNABOT_RESOURCES_PATH", "LUNABOT_CODEX_AUTH_SOCKET", "LUNABOT_CODEX_AUTH_SECRET",
  "LUNABOT_COPILOT_MCP_CONFIG", "LUNABOT_BROWSER_PROFILE", "LUNABOT_BOX_PROBE", "LUNABOT_EXTRA_PATH", "LUNABOT_TEST_SEALED_PATH",
]);
/** Families of the same, one variable per server or kind: a harness MCP server's token, a gated or remote server's config. */
export const BOX_ENV_LUNABOT_PREFIXES: readonly string[] = ["LUNABOT_MCP_TOKEN_", "LUNABOT_GATE_CONFIG_", "LUNABOT_REMOTE_MCP_CONFIG_"];

/** Prefixes of the engines' own settings and keys (T0b replaces the keys with per-turn broker tokens). */
export const BOX_ENV_PREFIXES: readonly string[] = [
  "LC_", "DEXBOT_", "LUNABOT_", "NPM_CONFIG_", "npm_config_",
  "ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "OPENCODE_", "OPENROUTER_", "GEMINI_", "GOOGLE_", "GROK_", "XAI_",
  "MISTRAL_", "CEREBRAS_", "GROQ_", "GREENFERENCE_", "MODELGO_", "META_", "MINIMAX_", "KIMI_", "MOONSHOT_", "CURSOR_", "FACTORY_", "CLINE_", "HERMES_",
  "MUSE_", "PI_", "DWEB_", "UNSLOTH_", "FAKE_CLAUDE_", "MCP_", "ANTIGRAVITY_", "AGY_",
];

/** Never, whatever the allow-list says: the control plane's settings and secrets, and the server's own placement. The
 * CLI's session token and server address (server/headless/client.ts) too: nothing in a box reads them, and one an
 * operator set on the server would otherwise pass under the engines' DEXBOT_/LUNABOT_ prefixes. */
export const BOX_ENV_NEVER: ReadonlySet<string> = new Set([
  "LUNABOT_LICENSE_KEY", "LUNABOT_INSTALLATION_CREDENTIAL", "LUNABOT_LOOPBACK_TRUST", "LUNABOT_CLOUD_SECRETS_FD",
  "LUNABOT_DATA_DIR", "LUNABOT_STATIC_DIR", "LUNABOT_DUCKDB_DIR", "LUNABOT_PORT", "LUNABOT_WEBHOOK_PORT",
  "DEXBOT_TOKEN", "DEXBOT_URL", "LUNABOT_TOKEN", "LUNABOT_URL",
]);
export const BOX_ENV_NEVER_PREFIXES: readonly string[] = ["LUNABOT_CLOUD_"];

/** `allow` is what one spawn vouches for: the keys the person saved for its engine, under whatever name that engine reads
 * (NANO_GPT_API_KEY, OPENCODE_API_KEY). Security: it lifts the allow-list and `deny` for that process only, and never for
 * a name of Luna Bot's own (`LUNABOT_`) or one on the never-list. */
export function boxEnvironmentAllows(name: string, deny: ReadonlySet<string> = new Set(), allow: ReadonlySet<string> = new Set()): boolean {
  if (BOX_ENV_NEVER.has(name) || BOX_ENV_NEVER_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (allow.has(name) && !name.startsWith("LUNABOT_")) return true;
  if (deny.has(name)) return false;
  if (name.startsWith("LUNABOT_")) return BOX_ENV_LUNABOT_NAMES.has(name) || BOX_ENV_LUNABOT_PREFIXES.some((prefix) => name.startsWith(prefix));
  return BOX_ENV_NAMES.has(name) || BOX_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The box's environment: the allowed names of `env` with a value, in a fresh object. `deny` adds names (the workspace
 * credentials) that are refused even when a prefix would allow them. */
export function boxEnvironment(
  env: Record<string, string | undefined>,
  deny: ReadonlySet<string> = new Set(),
  allow: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !boxEnvironmentAllows(name, deny, allow)) continue;
    kept[name] = value;
  }
  return kept;
}

/** The names of `env` that hold the value `instance` gave them: what the environment configured for one engine instance
 * (its saved keys) put in a spawn, for that spawn's `allowEnv`. */
export function instanceEnvNames(instance: Readonly<Record<string, string>>, env: Record<string, string | undefined>): string[] {
  return Object.keys(instance).filter((name) => env[name] !== undefined && env[name] === instance[name]);
}
