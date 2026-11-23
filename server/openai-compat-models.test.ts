// The custom provider auto-fills its model list from the provider's own /models when a connect leaves models empty.
import { describe, expect, it, vi } from "vitest";

import { populateCompatModels, type CompatModelsConfig } from "./openai-compat-models.ts";

const catalog = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
const okFetch = vi.fn(async () => catalog(["m-1", "m-2", "m-3"]));
const connected = (models?: string[]): { openaiCompat: CompatModelsConfig } => ({
  openaiCompat: { key: "sk-test", url: "https://api.example.com/v1", models },
});
const noopPersist = () => undefined;

describe("populateCompatModels", () => {
  it("fills a fresh connect's models from the provider's /models", async () => {
    const cfg = connected();
    const persisted: string[][] = [];
    const filled = await populateCompatModels(cfg, undefined, undefined, (patch) => persisted.push(patch.openaiCompat.models), okFetch);
    expect(filled).toBe(true);
    expect(cfg.openaiCompat?.models).toEqual(["m-1", "m-2", "m-3"]);
    expect(persisted).toEqual([["m-1", "m-2", "m-3"]]);
    expect(okFetch).toHaveBeenCalledTimes(1);
  });

  it("fills when the URL save lands last and explicitly sends an empty list the provider never had models for", async () => {
    const cfg = connected([]);
    const filled = await populateCompatModels(cfg, [], undefined, noopPersist, okFetch);
    expect(filled).toBe(true);
    expect(cfg.openaiCompat?.models).toEqual(["m-1", "m-2", "m-3"]);
  });

  it("keeps a deliberate clear: an empty list over models that existed stays empty", async () => {
    const cfg = connected(["m-1"]);
    const noFetch = vi.fn();
    const filled = await populateCompatModels(cfg, [], ["m-1"], noopPersist, noFetch);
    expect(filled).toBe(false);
    expect(cfg.openaiCompat?.models).toEqual(["m-1"]);
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("does not fetch when models are already saved", async () => {
    const cfg = connected(["m-1", "m-2"]);
    const noFetch = vi.fn();
    const filled = await populateCompatModels(cfg, ["m-1", "m-2"], ["m-1", "m-2"], noopPersist, noFetch);
    expect(filled).toBe(false);
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("does not fetch without a saved key", async () => {
    const cfg: { openaiCompat: CompatModelsConfig } = { openaiCompat: { url: "https://api.example.com/v1" } };
    const noFetch = vi.fn();
    const filled = await populateCompatModels(cfg, undefined, undefined, noopPersist, noFetch);
    expect(filled).toBe(false);
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("does not fetch without a saved URL", async () => {
    const cfg: { openaiCompat: CompatModelsConfig } = { openaiCompat: { key: "sk-test" } };
    const noFetch = vi.fn();
    const filled = await populateCompatModels(cfg, undefined, undefined, noopPersist, noFetch);
    expect(filled).toBe(false);
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("stays empty when the provider refuses the key", async () => {
    const cfg = connected();
    const rejected = vi.fn(async () => new Response("{}", { status: 401 }));
    const filled = await populateCompatModels(cfg, undefined, undefined, noopPersist, rejected);
    expect(filled).toBe(false);
    expect(cfg.openaiCompat?.models).toBeUndefined();
  });

  it("stays empty when the endpoint answers without a model list", async () => {
    const cfg = connected();
    const notModels = vi.fn(async () => new Response(JSON.stringify({ hello: true }), { status: 200 }));
    const filled = await populateCompatModels(cfg, undefined, undefined, noopPersist, notModels);
    expect(filled).toBe(false);
  });

  it("stays empty when the provider lists nothing", async () => {
    const cfg = connected();
    const empty = vi.fn(async () => catalog([]));
    const filled = await populateCompatModels(cfg, undefined, undefined, noopPersist, empty);
    expect(filled).toBe(false);
  });
});
