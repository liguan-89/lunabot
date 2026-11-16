// The engine instances a fresh install starts with. Luna Bot ships one agent:
// pi. Every model it can run comes from pi's own configuration plus the one
// custom provider saved in config.json (openaiCompat).
import type { InstanceConfigMap } from "./contracts.ts";

export const OPENAI_API_INSTANCE = "openai";
export const OPENROUTER_API_INSTANCE = "openrouter";
export const XAI_API_INSTANCE = "xaiApi";
export const CLAUDE_API_INSTANCE = "claudeApi";

/** The only instance this build runs. */
export const PI_INSTANCE = "pi";
export const KEPT_INSTANCE_IDS: ReadonlySet<string> = new Set([PI_INSTANCE]);

export const API_KEY_FLEET: InstanceConfigMap = {};

export const DEFAULT_FLEET: InstanceConfigMap = {
  [PI_INSTANCE]: { driver: "piAgent", displayName: "pi", access: "custom" },
};

/** Nothing is added to an existing fleet: the other engines are gone. */
export const PRODUCT_FLEET_ADDITIONS = {};