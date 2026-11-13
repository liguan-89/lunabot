import type { AnyProviderDriver } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";

/** The engines this build runs: pi as the agent, and the OpenAI-compatible HTTP client that serves
 * the custom provider (and the server's own helper calls). */
export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  PiDriver,
  OpenAICompatDriver,
];