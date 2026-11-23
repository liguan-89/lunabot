// Credential env names and the strippers that keep them out of child processes. Lives apart from
// config.ts so the lists can grow (one name per engine) without that file growing with them.

/** Workspace credential env names; spawned engine CLIs must never inherit them. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "LUNABOT_GROQ_API_KEY",
  "LUNABOT_GREENFERENCE_API_KEY",
  "LUNABOT_MODELGO_API_KEY",
  "LUNABOT_META_API_KEY",
  "LUNABOT_DEEPSEEK_API_KEY",
  "LUNABOT_ANTHROPIC_API_KEY",
  "LUNABOT_ANTHROPIC_API_URL",
  "LUNABOT_HOSTED_MODEL_TOKEN",
  "LUNABOT_HOSTED_MODELS",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "LUNABOT_OPENAI_API_KEY",
  "LUNABOT_OPENROUTER_API_KEY",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "LUNABOT_TTS_KEY",
  "LUNABOT_FISH_AUDIO_API_KEY",
  "LUNABOT_GEMINI_API_KEY",
  "LUNABOT_JEV_API_KEY",
  "LUNABOT_OPENROUTER_DECIDER_KEY",
  "LUNABOT_WORKERS_AI_TOKEN",
  "LUNABOT_OPENAI_IMAGE_KEY",
  "LUNABOT_CUSTOM_IMAGE_KEY",
  "LUNABOT_GEMINI_IMAGE_KEY",
  "LUNABOT_OPENAI_LIVE_KEY", "LUNABOT_TREG_KEY", "LUNABOT_POSTIZ_API_KEY",
  "COMPOSIO_API_KEY",
  "LUNABOT_COMPOSIO_BROKER_TOKEN",
  "LUNABOT_CLOUD_BOAT_TOKEN",
  "LUNABOT_CLOUD_VOICE_TOKEN",
  "LUNABOT_CLOUD_DECIDER_TOKEN",
  "LUNABOT_CLOUD_AI_TOKEN", "LUNABOT_CLOUD_X_TOKEN", "LUNABOT_CLOUD_CONNECTED_APPS_GRANT",
  // Not credentials, but they point a shell-capable agent at app-owned state.
  "LUNABOT_BROWSER_CONNECTION", "LUNABOT_USER_DATA", "LUNABOT_BOAT_API",
] as const;

/** Operator secrets only this process reads, plus every `LUNABOT_CLOUD_` var (the underscore leaves out LUNABOT_CLOUDFLARED_PATH). */
export const CONTROL_PLANE_ENV = ["LUNABOT_LICENSE_KEY", "LUNABOT_INSTALLATION_CREDENTIAL"] as const;
export const CONTROL_PLANE_ENV_PREFIX = "LUNABOT_CLOUD_";

/** Names compare case-insensitively because Windows environments do. */
export function stripControlPlaneEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name.startsWith(CONTROL_PLANE_ENV_PREFIX) || (CONTROL_PLANE_ENV as readonly string[]).includes(name)) delete env[key];
  }
}

export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
  stripControlPlaneEnv(env);
}

const DESKTOP_STORE_KEY_ENV: ReadonlySet<string> = new Set(["MISTRAL_API_KEY", "CEREBRAS_API_KEY", "OPENAI_COMPAT_API_KEY", "LUNABOT_OPENAI_API_KEY", "LUNABOT_OPENROUTER_API_KEY"]);

/** A key an operator set on the server. Security: under the desktop app these variables hold workspace keys from its
 * encrypted store, which reach only the instances the workspace routes, never one with a URL of its own. */
export function operatorEnvKey(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LUNABOT_DESKTOP_PARENT === "1" && DESKTOP_STORE_KEY_ENV.has(name) ? undefined : env[name];
}

/** Env a provider CLI may read as its billing identity; a foreign key must never move a subscription CLI onto API billing. */
export const PROVIDER_CREDENTIAL_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "GREENFERENCE_API_KEY",
  "MODELGO_API_KEY",
  "META_API_KEY",
  "DEEPSEEK_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Provider keys OpenCode reads from its environment (with ANTHROPIC_API_KEY set it lists Anthropic's models). */
export const OPENCODE_PROVIDER_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;
