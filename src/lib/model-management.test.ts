import { describe, expect, it } from "vitest";
import type { ConfigStatus } from "@/state/config-status";
import type { InstanceInfo } from "@/state/store";
import { withoutHiddenModels } from "../../shared/model-management";
import { addCustomModels, customModelIds, managedModels, modelUsers, removeCustomModel } from "./model-management";

const instance = {
  instanceId: "pi", driverKind: "piAgent", displayName: "pi",
  snapshot: { state: "available" },
  models: {
    default: "dex/gpt-5",
    options: [
      { id: "dex/gpt-5", label: "gpt-5 (Custom)", custom: true, provider: "dex" },
      { id: "anthropic/claude-sonnet", label: "Claude Sonnet", provider: "anthropic" },
    ],
  },
} as unknown as InstanceInfo;

const config = {
  openaiCompat: { configured: true, providerId: "dex", models: ["gpt-5", "gpt-4o"] },
  defaultModelSelection: { instanceId: "pi", model: "dex/gpt-4o" },
} as ConfigStatus;

describe("managedModels", () => {
  it("marks the custom provider's models removable and names them by their raw id", () => {
    const rows = managedModels(instance, config);
    expect(rows.find((row) => row.id === "dex/gpt-5")).toMatchObject({ label: "gpt-5", removable: true, raw: "gpt-5" });
  });

  it("leaves the engine's own models alone", () => {
    expect(managedModels(instance, config).find((row) => row.id === "anthropic/claude-sonnet")).toMatchObject({
      label: "Claude Sonnet", removable: false, default: false,
    });
  });

  it("marks the new-bot default and lists a saved model the catalog has not returned yet", () => {
    const gpt4 = managedModels(instance, config).find((row) => row.id === "dex/gpt-4o");
    expect(gpt4).toMatchObject({ label: "gpt-4o", removable: true, default: true, raw: "gpt-4o" });
  });

  it("still lists saved custom models when the engine is unavailable", () => {
    const rows = managedModels(undefined, config);
    expect(rows.map((row) => row.id)).toEqual(["dex/gpt-5", "dex/gpt-4o"]);
    expect(rows.every((row) => row.removable)).toBe(true);
  });
});

describe("customModelIds", () => {
  it("reads the saved list and treats a missing config as empty", () => {
    expect(customModelIds(config)).toEqual(["gpt-5", "gpt-4o"]);
    expect(customModelIds(null)).toEqual([]);
  });
});

describe("addCustomModels", () => {
  it("splits comma or space separated ids, trims and de-duplicates them", () => {
    expect(addCustomModels(["gpt-5"], " gpt-4o, kimi-k2  gpt-4o ")).toEqual({ ids: ["gpt-5", "gpt-4o", "kimi-k2"], added: ["gpt-4o", "kimi-k2"] });
  });

  it("adds nothing when every id is already saved", () => {
    expect(addCustomModels(["gpt-5"], "gpt-5")).toEqual({ ids: ["gpt-5"], added: [] });
  });

  it("refuses empty input, oversized ids and more than 64 models", () => {
    expect(addCustomModels(["gpt-5"], " ")).toMatchObject({ problem: "empty", added: [] });
    expect(addCustomModels([], "x".repeat(201))).toMatchObject({ problem: "length", added: [] });
    expect(addCustomModels(Array.from({ length: 64 }, (_, index) => `m${index}`), "one-more")).toMatchObject({ problem: "limit", added: [] });
  });
});

describe("removeCustomModel", () => {
  it("removes only the named id", () => {
    expect(removeCustomModel(["gpt-5", "gpt-4o"], "gpt-5")).toEqual(["gpt-4o"]);
  });
});

describe("modelUsers", () => {
  const model = "dex/gpt-5";

  it("finds the bots, backups, tasks, routines and recovery entry that still point at it", () => {
    const uses = modelUsers(model, "pi", {
      bots: [{
        name: "Atlas",
        modelSelection: { instanceId: "pi", model },
        fallback: [{ instanceId: "pi", model }],
        tasks: [{ modelSelection: { instanceId: "pi", model } }],
      }],
      routines: [{ name: "Daily report", modelSelection: { instanceId: "pi", model } }],
      automaticRecovery: { enabled: true, backup: { instanceId: "pi", model } },
    });
    expect(uses).toEqual([
      { kind: "bot", name: "Atlas" },
      { kind: "fallback", name: "Atlas" },
      { kind: "task", name: "Atlas" },
      { kind: "routine", name: "Daily report" },
      { kind: "recovery", name: "" },
    ]);
  });

  it("ignores another instance, a disabled recovery, and repeated tasks of one bot", () => {
    const uses = modelUsers(model, "pi", {
      bots: [
        { name: "Atlas", modelSelection: { instanceId: "other", model } },
        { name: "Ursa", tasks: [{ modelSelection: { instanceId: "pi", model } }, { modelSelection: { instanceId: "pi", model } }] },
      ],
      routines: [{ name: "Cloud only", modelSelection: { instanceId: "other", model } }],
      automaticRecovery: { enabled: false, backup: { instanceId: "pi", model } },
    });
    expect(uses).toEqual([{ kind: "task", name: "Ursa" }]);
  });
});

describe("withoutHiddenModels", () => {
  const catalog = {
    default: "a",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
  };

  it("drops hidden ids and keeps the default when it is still there", () => {
    expect(withoutHiddenModels(catalog, new Set(["b"]))).toEqual({
      default: "a",
      options: [{ id: "a", label: "A" }, { id: "c", label: "C" }],
    });
  });

  it("moves the default to the first visible model when the default itself is hidden", () => {
    expect(withoutHiddenModels(catalog, new Set(["a"]))).toEqual({
      default: "b",
      options: [{ id: "b", label: "B" }, { id: "c", label: "C" }],
    });
  });

  it("leaves the catalog alone when nothing is hidden", () => {
    expect(withoutHiddenModels(catalog, new Set())).toBe(catalog);
  });
});