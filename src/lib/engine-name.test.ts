import { afterEach, describe, expect, it } from "vitest";

import { engineDisplayName } from "./engine-name";
import { setLocale } from "./i18n";

afterEach(() => setLocale("en"));

describe("engineDisplayName", () => {
  it("translates only the server's own default names", () => {
    setLocale("pt-br");
    expect(engineDisplayName({ instanceId: "claudeApi", displayName: "Claude (API key)" })).toBe("Claude (chave de API)");
    expect(engineDisplayName({ instanceId: "chatgpt", displayName: "ChatGPT plan" })).toBe("Plano do ChatGPT");
    expect(engineDisplayName({ instanceId: "openaiCompat", displayName: "Other (OpenAI-compatible)" })).toBe("Outro (compatível com OpenAI)");
    expect(engineDisplayName({ instanceId: "claudeApi", displayName: "Work key" })).toBe("Work key");
    expect(engineDisplayName({ instanceId: "codex", displayName: "ChatGPT plan" })).toBe("ChatGPT plan");
    setLocale("en");
    expect(engineDisplayName({ instanceId: "claudeApi", displayName: "Claude (API key)" })).toBe("Claude (API key)");
  });

  it("names the only engine by the provider it uses, never by pi", () => {
    setLocale("en");
    expect(engineDisplayName({ instanceId: "pi", displayName: "pi", driverKind: "piAgent" })).toBe("Custom model provider");
    expect(engineDisplayName({ instanceId: "pi-work", displayName: "pi", driverKind: "piAgent" })).toBe("Custom model provider");
    expect(engineDisplayName({ instanceId: "pi-work", displayName: "Work account", driverKind: "piAgent" })).toBe("Work account");
  });
});
