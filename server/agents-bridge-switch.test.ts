import { describe, expect, it } from "vitest";

import { engineBridgeRefusal, agentsToolBridgeRefusal } from "./agents-bridge-switch.ts";

describe("the agents tool bridge with the one engine", () => {
  it("never bridges pi: its own extensions can block a tool by the name they see", () => {
    expect(engineBridgeRefusal({ driverKind: "piAgent" })).toContain("Pi loads the person's own extensions");
  });

  it("bridges the chat runtime, which reads no per-tool configuration", () => {
    expect(engineBridgeRefusal({ driverKind: "openai-compat" })).toBeNull();
  });

  it("still refuses a bot with a tool selection", () => {
    expect(agentsToolBridgeRefusal({ features: { agentsToolBridge: true } }, { toolScope: { allow: [] } }, { driverKind: "openai-compat" })).toBe("the bot has a tool selection");
  });

  it("refuses an unknown engine rather than guessing", () => {
    expect(engineBridgeRefusal({ driverKind: "someFutureDriver" })).toBe("this engine keeps its own tool permissions");
    expect(engineBridgeRefusal(null)).toBe("no engine");
  });
});