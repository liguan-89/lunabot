import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { instanceConfigs, type AppConfig } from "../config.ts";
import { ensurePiCustomProvider, ensurePiInjectModel, fetchPiModels } from "./pi.ts";
import {
  PI_CUSTOM_ENV,
  isPiCustomModel,
  mergePiCustomCatalog,
  piCustomProviderFromEnv,
  splitPiCustomModel,
  withPiDefaultOption,
} from "./pi-custom-provider.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-pi-cli.ts");

const homes: string[] = [];
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-custom-"));
  homes.push(home);
  return home;
}

const AUTH = "unit-test-secret";

function env(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    [PI_CUSTOM_ENV.baseUrl]: "https://models.example.com/v1",
    [PI_CUSTOM_ENV.auth]: AUTH,
    [PI_CUSTOM_ENV.models]: "alpha, beta",
    ...extra,
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("pi custom provider", () => {
  it("reads the endpoint, key and models from the instance environment", () => {
    const provider = piCustomProviderFromEnv(env(tempHome()));
    expect(provider).toMatchObject({
      displayName: "Custom",
      protocol: "openai",
      baseUrl: "https://models.example.com/v1",
      models: ["alpha", "beta"],
    });
    expect(provider?.apiKey).toBe(AUTH);
  });

  it("writes one provider entry pi can select, keeping other providers", () => {
    const home = tempHome();
    ensurePiCustomProvider(env(home, { [PI_CUSTOM_ENV.protocol]: "anthropic" }));
    const models = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8"));
    expect(models.providers.luna).toMatchObject({
      baseUrl: "https://models.example.com/v1",
      api: "anthropic-messages",
    });
    expect(models.providers.luna.apiKey).toBe(AUTH);
    expect(models.providers.luna.models.map((model: { id: string }) => model.id)).toEqual(["alpha", "beta"]);
  });

  it("maps model selections to the provider entry", () => {
    const home = tempHome();
    expect(ensurePiInjectModel("luna/alpha", env(home))).toEqual({ provider: "luna", modelId: "alpha" });
    expect(isPiCustomModel("luna/alpha")).toBe(true);
    expect(isPiCustomModel("openai/alpha")).toBe(false);
  });

  it("still recognizes selections saved under the legacy provider id", () => {
    const home = tempHome();
    expect(ensurePiInjectModel("dex/alpha", env(home))).toEqual({ provider: "luna", modelId: "alpha" });
    expect(isPiCustomModel("dex/alpha")).toBe(true);
    expect(splitPiCustomModel("dex/alpha")).toEqual({ modelId: "alpha" });
  });

  it("lists the custom models beside pi's own and prefers pi's default", () => {
    const catalog = mergePiCustomCatalog({ default: "openai/gpt", options: [{ id: "openai/gpt", label: "GPT" }] }, env(tempHome()));
    expect(catalog.default).toBe("openai/gpt");
    expect(catalog.options.map((option) => option.id)).toEqual(["openai/gpt", "luna/alpha", "luna/beta"]);
  });

  it("selects the first custom model when pi has no default", () => {
    const catalog = mergePiCustomCatalog({ default: "", options: [] }, env(tempHome()));
    expect(catalog.default).toBe("luna/alpha");
    expect(catalog.options.map((option) => option.id)).toEqual(["luna/alpha", "luna/beta"]);
  });

  it("keeps a selectable default when nothing is configured", () => {
    expect(withPiDefaultOption({ default: "", options: [] })).toEqual({
      default: "default",
      options: [{ id: "default", label: "Default model", custom: true }],
    });
  });

  it("keeps pi's own default selectable beside real models", () => {
    expect(withPiDefaultOption({ default: "openai/gpt", options: [{ id: "openai/gpt", label: "GPT" }] })).toEqual({
      default: "openai/gpt",
      options: [{ id: "default", label: "Default model", custom: true }, { id: "openai/gpt", label: "GPT" }],
    });
  });

  it("reaches the pi instance through the workspace config", () => {
    const config = {
      openaiCompat: {
        url: "https://models.example.com/v1",
        key: AUTH,
        protocol: "responses",
        models: ["alpha"],
      },
    } as unknown as AppConfig;
    const pi = instanceConfigs(config).pi!;
    expect(pi.environment).toMatchObject({
      [PI_CUSTOM_ENV.baseUrl]: "https://models.example.com/v1",
      [PI_CUSTOM_ENV.auth]: AUTH,
      [PI_CUSTOM_ENV.protocol]: "responses",
      [PI_CUSTOM_ENV.models]: "alpha",
    });
  });

  it("lists the custom models a live pi CLI reports beside its own", async () => {
    const home = tempHome();
    const catalog = mergePiCustomCatalog(
      await fetchPiModels(FAKE_CLI, { ...env(home), PATH: process.env.PATH ?? "" }),
      env(home),
    );
    const ids = catalog.options.map((option) => option.id);
    expect(ids).toContain("ollama-cloud/glm-5.2");
    expect(ids).toContain("luna/alpha");
    expect(ids).toContain("luna/beta");
    expect(catalog.default).toBe("ollama-cloud/glm-5.2");
  });
});