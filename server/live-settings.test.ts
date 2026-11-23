import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.ts";
import { nestedKeyStatus } from "./key-hint.ts";
import { LIVE_NEEDS_AZURE, LIVE_NEEDS_KEY, LIVE_NEEDS_QWEN, LIVE_NEEDS_VOLC } from "./live-call.ts";
import { LIVE_KEY_NEEDS_ENDPOINT, liveConfigWithEnv, liveKeyTarget, liveSavePatch, usableLiveKey, type LiveConfig } from "./live-config.ts";
import { LIVE_IDLE_MINUTES_DEFAULT, liveCallEndpoint, liveCallKey, liveCallSettings, liveSettingsFor, liveSettingsForClient, liveSetupProblem } from "./live-settings.ts";

describe("live settings", () => {
  it("defaults to a 5 minute idle hang-up and reading typed replies, with no key", () => {
    expect(LIVE_IDLE_MINUTES_DEFAULT).toBe(5);
    expect(liveSettingsFor({} as AppConfig)).toEqual({ configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 });
  });

  it("reports saved values and where the key comes from, never the key", () => {
    const settings = liveSettingsFor({ live: { key: "sk-test", voice: "sol", readTypedReplies: false, idleMinutes: 12 } } as AppConfig);
    expect(settings).toEqual({ configured: true, keySource: "live", voice: "sol", readTypedReplies: false, idleMinutes: 12 });
    expect(JSON.stringify(settings)).not.toContain("sk-test");
  });
});

describe("the key a Live call uses", () => {
  it("is the OpenAI API key from Settings → API keys when there is no separate Live key", () => {
    const cfg = { openai: { key: " sk-openai " } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "sk-openai", source: "openai" });
    for (const live of [{}, { key: "" }, { key: "  " }]) expect(liveCallKey({ ...cfg, live }), JSON.stringify(live)).toEqual({ key: "sk-openai", source: "openai" });
    const settings = liveSettingsFor(cfg);
    expect(settings).toMatchObject({ configured: true, keySource: "openai" });
    expect(JSON.stringify(settings)).not.toContain("sk-openai");
  });

  it("is the separate Live key whenever one is saved", () => {
    expect(liveCallKey({ live: { key: "sk-live" }, openai: { key: "sk-openai" } } as AppConfig)).toEqual({ key: "sk-live", source: "live" });
    expect(liveSettingsFor({ live: { key: "sk-live" }, openai: { key: "sk-openai" } } as AppConfig)).toMatchObject({ keySource: "live" });
  });

  it("is nothing without either key; never an image, compatible-server or other provider's key", () => {
    const others = { imageGen: { key: "sk-image" }, openaiCompat: { key: "sk-compat" }, openrouter: { key: "sk-or" }, xai: { key: "xai-key" } } as AppConfig;
    expect(liveCallKey(others)).toBeNull();
    expect(liveCallKey({ ...others, openai: { key: " " } })).toBeNull();
    expect(liveSettingsFor(others)).toEqual({ configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 });
  });
});

describe("Live calls through Azure OpenAI", () => {
  const azure = { provider: "azure" as const, azureEndpoint: "https://my-res.openai.azure.com", azureDeployment: "live-prod" };
  const keyFor = "azure:my-res.openai.azure.com";

  it("never use the OpenAI API key as the Azure resource key", () => {
    const cfg = { live: azure, openai: { key: "sk-openai" } } as AppConfig;
    expect(liveCallKey(cfg)).toBeNull();
    expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_AZURE);
    expect(liveSettingsFor(cfg)).toMatchObject({ configured: false, provider: "azure", azureEndpoint: azure.azureEndpoint, azureDeployment: "live-prod" });
  });

  it("are ready with the Live key, a valid endpoint and a deployment, and report none of the key", () => {
    const cfg = { live: { ...azure, key: "azure-secret", keyFor } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "azure-secret", source: "live" });
    expect(liveCallEndpoint(cfg)).toEqual({ provider: "azure", apiBase: "https://my-res.openai.azure.com/openai/v1", model: "live-prod" });
    expect(liveSetupProblem(cfg)).toBeNull();
    const settings = liveSettingsFor(cfg);
    expect(settings).toMatchObject({ configured: true, keySource: "live", provider: "azure" });
    expect(JSON.stringify(settings)).not.toContain("azure-secret");
  });

  it("are not ready with an endpoint that is not an Azure host", () => {
    const cfg = { live: { ...azure, key: "k", azureEndpoint: "https://evil.example" } } as AppConfig;
    expect(liveCallEndpoint(cfg)).toBeNull();
    expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_AZURE);
    expect(liveSettingsFor(cfg).configured).toBe(false);
  });

  it("name the provider in what a call start reads, so the limit on Azure sees it even before setup is done", () => {
    expect(liveCallSettings({ live: { provider: "azure" } } as AppConfig)).toMatchObject({ provider: "azure", endpoint: null, key: "", setupProblem: LIVE_NEEDS_AZURE });
    expect(liveCallSettings({ live: { ...azure, key: "k", keyFor } } as AppConfig)).toMatchObject({ provider: "azure", key: "k", setupProblem: null, endpoint: { provider: "azure" } });
    expect(liveCallSettings({ openai: { key: "sk" } } as AppConfig).provider).toBeUndefined();
  });

  it("tell a caller without the admin scope the service, not which resource", () => {
    const client = liveSettingsForClient(liveSettingsFor({ live: { ...azure, key: "azure-secret", keyFor } } as AppConfig));
    expect(client).toEqual({ configured: true, keySource: "live", provider: "azure", voice: "", readTypedReplies: true, idleMinutes: 5 });
    expect(JSON.stringify(client)).not.toContain("my-res");
    expect(JSON.stringify(client)).not.toContain("live-prod");
  });

  it("default to gpt-live-1 as the deployment name", () => {
    expect(liveCallEndpoint({ live: { ...azure, azureDeployment: "" } } as AppConfig)?.model).toBe("gpt-live-1");
  });

  it("leave OpenAI the default provider", () => {
    expect(liveCallEndpoint({ openai: { key: "sk" } } as AppConfig, {})).toEqual({ provider: "openai", apiBase: "https://api.openai.com/v1", model: "gpt-live-1" });
    expect(liveSetupProblem({} as AppConfig)).toBe(LIVE_NEEDS_KEY);
  });
});

describe("Live calls through a Qwen realtime gateway", () => {
  const qwen = { provider: "qwen" as const, qwenEndpoint: "https://maas.qianwenaiapi.com/compatible-mode/v1", qwenModel: "qwen3.5-omni-flash-realtime" };
  const keyFor = "qwen:maas.qianwenaiapi.com";

  it("never use the OpenAI API key as the gateway's key", () => {
    const cfg = { live: qwen, openai: { key: "sk-openai" } } as AppConfig;
    expect(liveCallKey(cfg)).toBeNull();
    expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_QWEN);
  });

  it("are ready with the Live key and a valid endpoint, and report the provider without the key", () => {
    const cfg = { live: { ...qwen, key: "qwen-secret", keyFor } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "qwen-secret", source: "live" });
    expect(liveCallEndpoint(cfg)).toEqual({ provider: "qwen", apiBase: "wss://maas.qianwenaiapi.com/api-ws/v1", model: "qwen3.5-omni-flash-realtime" });
    expect(liveSetupProblem(cfg)).toBeNull();
    const settings = liveSettingsFor(cfg);
    expect(settings).toMatchObject({ configured: true, keySource: "live", provider: "qwen", qwenEndpoint: qwen.qwenEndpoint, qwenModel: qwen.qwenModel });
    expect(JSON.stringify(settings)).not.toContain("qwen-secret");
  });

  it("are not ready with an endpoint that is not https", () => {
    const cfg = { live: { ...qwen, key: "k", qwenEndpoint: "wss://evil.example/realtime" } } as AppConfig;
    expect(liveCallEndpoint(cfg)).toBeNull();
    expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_QWEN);
    expect(liveSettingsFor(cfg).configured).toBe(false);
  });

  it("name the provider in what a call start reads, so the own-provider limit sees it even before setup is done", () => {
    expect(liveCallSettings({ live: { provider: "qwen" } } as AppConfig)).toMatchObject({ provider: "qwen", endpoint: null, key: "", setupProblem: LIVE_NEEDS_QWEN });
    expect(liveCallSettings({ live: { ...qwen, key: "k", keyFor } } as AppConfig)).toMatchObject({ provider: "qwen", key: "k", setupProblem: null, endpoint: { provider: "qwen" } });
  });

  it("tell a caller without the admin scope the service, not which gateway", () => {
    const client = liveSettingsForClient(liveSettingsFor({ live: { ...qwen, key: "qwen-secret", keyFor } } as AppConfig));
    expect(client).toEqual({ configured: true, keySource: "live", provider: "qwen", voice: "", readTypedReplies: true, idleMinutes: 5 });
    expect(JSON.stringify(client)).not.toContain("qianwenaiapi");
  });

  it("default to the omni realtime model", () => {
    expect(liveCallEndpoint({ live: { ...qwen, qwenModel: "" } } as AppConfig)?.model).toBe("qwen3.5-omni-flash-realtime");
  });

  it("tie the saved key to the gateway's host, never its path", () => {
    expect(liveKeyTarget({ provider: "qwen", qwenEndpoint: "https://maas.qianwenaiapi.com/compatible-mode/v1" })).toBe("qwen:maas.qianwenaiapi.com");
    expect(liveKeyTarget({ provider: "qwen", qwenEndpoint: "https://MAAS.Qianwenaiapi.com:8443/x" })).toBe("qwen:maas.qianwenaiapi.com:8443");
    for (const qwenEndpoint of [undefined, "", "maas.qianwenaiapi.com"]) expect(liveKeyTarget({ provider: "qwen", qwenEndpoint }), String(qwenEndpoint)).toBeNull();
  });

  it("send the key only where it was saved for", () => {
    const onA: LiveConfig = { provider: "qwen", qwenEndpoint: "https://a.example.com", key: "k", keyFor: "qwen:a.example.com" };
    expect(usableLiveKey(onA)).toBe("k");
    expect(usableLiveKey({ ...onA, qwenEndpoint: "https://a.example.com/other/path" })).toBe("k");
    expect(usableLiveKey({ ...onA, qwenEndpoint: "https://b.example.com" })).toBeUndefined();
    expect(usableLiveKey({ ...onA, provider: "openai" })).toBeUndefined();
  });

  it("save a new key tied to the gateway, forget it when the provider or host moves", () => {
    const onA: LiveConfig = { provider: "qwen", qwenEndpoint: "https://a.example.com", key: "k", keyFor: "qwen:a.example.com" };
    expect(liveSavePatch(undefined, { key: "new", provider: "qwen", qwenEndpoint: "https://a.example.com" })).toEqual({ key: "new", provider: "qwen", qwenEndpoint: "https://a.example.com", keyFor: "qwen:a.example.com" });
    expect(() => liveSavePatch({ provider: "qwen" }, { key: "new" })).toThrow(LIVE_KEY_NEEDS_ENDPOINT);
    expect(liveSavePatch(onA, { provider: "openai" })).toEqual({ provider: "openai", key: "", keyFor: "nowhere" });
    expect(liveSavePatch(onA, { qwenEndpoint: "https://b.example.com" })).toEqual({ qwenEndpoint: "https://b.example.com", key: "", keyFor: "nowhere" });
    expect(liveSavePatch(onA, { qwenModel: "other-model" })).toEqual({ qwenModel: "other-model" });
  });

  it("pair a key and a gateway set together in the environment, as an operator does", () => {
    const env = { LUNABOT_OPENAI_LIVE_KEY: "operators", LUNABOT_LIVE_PROVIDER: "qwen", LUNABOT_LIVE_QWEN_ENDPOINT: "https://a.example.com", LUNABOT_LIVE_QWEN_MODEL: "qwen3-s2s-flash-realtime" };
    const merged = liveConfigWithEnv(undefined, env);
    expect(usableLiveKey(merged)).toBe("operators");
    expect(merged).toMatchObject({ provider: "qwen", qwenModel: "qwen3-s2s-flash-realtime", keyFor: "qwen:a.example.com" });
    expect(usableLiveKey(liveConfigWithEnv({ provider: "qwen" }, { LUNABOT_OPENAI_LIVE_KEY: "operators" }))).toBeUndefined();
  });
});

describe("a saved Live key", () => {
  const A = "https://a.openai.azure.com", B = "https://b.openai.azure.com";
  const onA: LiveConfig = { provider: "azure", azureEndpoint: A, key: "k", keyFor: "azure:a.openai.azure.com" };

  it("is tied to the service and the endpoint's host, not its path", () => {
    expect(liveKeyTarget(undefined)).toBe("openai");
    expect(liveKeyTarget({ provider: "openai", azureEndpoint: A })).toBe("openai");
    expect(liveKeyTarget({ provider: "azure", azureEndpoint: A })).toBe("azure:a.openai.azure.com");
    expect(liveKeyTarget({ provider: "azure", azureEndpoint: " https://A.OpenAI.Azure.com/openai/v1?x=1 " })).toBe("azure:a.openai.azure.com");
    expect(liveKeyTarget({ provider: "azure", azureEndpoint: "https://gw.azure-api.net/team-a" })).toBe("azure:gw.azure-api.net");
    expect(liveKeyTarget({ provider: "azure", azureEndpoint: `${A}:8443` })).toBe("azure:a.openai.azure.com:8443");
    for (const azureEndpoint of [undefined, "", "a.openai.azure.com"]) expect(liveKeyTarget({ provider: "azure", azureEndpoint }), String(azureEndpoint)).toBeNull();
  });

  it("goes only where it was saved for", () => {
    expect(usableLiveKey(onA)).toBe("k");
    expect(usableLiveKey({ ...onA, azureEndpoint: `${A}/openai/v1` })).toBe("k");
    expect(usableLiveKey({ ...onA, azureEndpoint: B })).toBeUndefined();
    expect(usableLiveKey({ ...onA, azureEndpoint: `${A}:8443` })).toBeUndefined();
    expect(usableLiveKey({ ...onA, provider: "openai" })).toBeUndefined();
    expect(usableLiveKey({ key: "k", keyFor: "openai" })).toBe("k");
    expect(usableLiveKey({ key: "k", keyFor: "openai", provider: "azure", azureEndpoint: A })).toBeUndefined();
    expect(usableLiveKey({ key: "k", keyFor: "nowhere" })).toBeUndefined();
    expect(usableLiveKey({ key: "k", keyFor: "nowhere", provider: "azure", azureEndpoint: A })).toBeUndefined();
    expect(usableLiveKey({ ...onA, key: "  " })).toBeUndefined();
  });

  it("from before Azure was offered is OpenAI's", () => {
    expect(usableLiveKey({ key: "old" })).toBe("old");
    expect(usableLiveKey({ key: "old", provider: "azure", azureEndpoint: A })).toBeUndefined();
  });

  it("never reaches the wrong provider through liveCallKey, whatever else is saved", () => {
    const openai = { key: "sk-openai" };
    expect(liveCallKey({ live: onA, openai } as AppConfig)).toEqual({ key: "k", source: "live" });
    expect(liveCallKey({ live: { ...onA, azureEndpoint: B }, openai } as AppConfig)).toBeNull();
    // Back on OpenAI the Azure key stays behind, and OpenAI's own key is OpenAI's to use.
    expect(liveCallKey({ live: { ...onA, provider: "openai" }, openai } as AppConfig)).toEqual({ key: "sk-openai", source: "openai" });
    expect(liveCallKey({ live: { ...onA, provider: "openai" } } as AppConfig)).toBeNull();
  });

  it("counts as saved only while it can be used", () => {
    expect(nestedKeyStatus({ live: onA } as AppConfig).openaiLiveKey.configured).toBe(true);
    expect(nestedKeyStatus({ live: { ...onA, azureEndpoint: B } } as AppConfig).openaiLiveKey.configured).toBe(false);
    expect(nestedKeyStatus({ live: { ...onA, keyFor: "nowhere" } } as AppConfig).openaiLiveKey.configured).toBe(false);
  });

  describe("saving", () => {
    const forgotten = { key: "", keyFor: "nowhere" };

    it("ties a new key to where calls go after this same save", () => {
      expect(liveSavePatch(undefined, { key: "new" })).toEqual({ key: "new", keyFor: "openai" });
      expect(liveSavePatch(onA, { key: "new" })).toEqual({ key: "new", keyFor: "azure:a.openai.azure.com" });
      expect(liveSavePatch(onA, { key: "new", azureEndpoint: B })).toEqual({ key: "new", azureEndpoint: B, keyFor: "azure:b.openai.azure.com" });
      expect(liveSavePatch(undefined, { key: "new", provider: "azure", azureEndpoint: B })).toEqual({ key: "new", provider: "azure", azureEndpoint: B, keyFor: "azure:b.openai.azure.com" });
    });

    it("refuses a key with Azure chosen and no endpoint to tie it to", () => {
      expect(() => liveSavePatch({ provider: "azure" }, { key: "new" })).toThrow(LIVE_KEY_NEEDS_ENDPOINT);
      expect(() => liveSavePatch(undefined, { provider: "azure", key: "new" })).toThrow(expect.objectContaining({ status: 400 }));
    });

    it("forgets the key when the service or the endpoint's host changes", () => {
      expect(liveSavePatch(onA, { azureEndpoint: B })).toEqual({ azureEndpoint: B, ...forgotten });
      expect(liveSavePatch(onA, { provider: "openai" })).toEqual({ provider: "openai", ...forgotten });
      expect(liveSavePatch(onA, { azureEndpoint: "" })).toEqual({ azureEndpoint: "", ...forgotten });
      expect(liveSavePatch(onA, { azureEndpoint: `${A}:8443` })).toEqual({ azureEndpoint: `${A}:8443`, ...forgotten });
      expect(liveSavePatch({ key: "old" }, { provider: "azure", azureEndpoint: A })).toEqual({ provider: "azure", azureEndpoint: A, ...forgotten });
    });

    it("keeps the key for anything else, including a new path or deployment on the same host", () => {
      for (const patch of [{ voice: "cedar" }, { idleMinutes: 9 }, { azureDeployment: "other" }, { provider: "azure" as const }, { azureEndpoint: `${A}/openai/v1` }]) {
        expect(liveSavePatch(onA, patch), JSON.stringify(patch)).toEqual(patch);
      }
      expect(liveSavePatch({ key: "old" }, { voice: "cedar" })).toEqual({ voice: "cedar" });
    });

    it("forgets it when asked to, so a copy in the desktop's store stays unusable", () => {
      expect(liveSavePatch(onA, { key: "" })).toEqual(forgotten);
    });

    it("never takes keyFor from a request", () => {
      expect(liveSavePatch(onA, { keyFor: "azure:evil.azure-api.net", voice: "cedar" })).toEqual({ voice: "cedar" });
      expect(liveSavePatch(onA, { keyFor: "azure:b.openai.azure.com", azureEndpoint: B })).toEqual({ azureEndpoint: B, ...forgotten });
      expect(liveSavePatch(onA, { keyFor: "azure:evil.azure-api.net", key: "new" })).toEqual({ key: "new", keyFor: "azure:a.openai.azure.com" });
    });
  });

  describe("from the environment", () => {
    const usable = (live: LiveConfig | undefined, env: NodeJS.ProcessEnv) => usableLiveKey(liveConfigWithEnv(live, env));

    it("is the desktop's copy from its store, usable where it was saved for and nowhere else", () => {
      const env = { LUNABOT_OPENAI_LIVE_KEY: "from-the-store" };
      expect(usable({ ...onA, key: "" }, env)).toBe("from-the-store");
      expect(usable({ ...onA, key: "", azureEndpoint: B }, env)).toBeUndefined();
      expect(usable({ provider: "openai", key: "", keyFor: "nowhere" }, env)).toBeUndefined();
      expect(usable({ provider: "azure", azureEndpoint: A, key: "", keyFor: "nowhere" }, env)).toBeUndefined();
    });

    it("pairs a key and an Azure endpoint set together there, as an operator does", () => {
      const env = { LUNABOT_OPENAI_LIVE_KEY: "operators", LUNABOT_LIVE_PROVIDER: "azure", LUNABOT_AZURE_OPENAI_LIVE_ENDPOINT: A };
      expect(usable(undefined, env)).toBe("operators");
      expect(liveConfigWithEnv(undefined, env).keyFor).toBe("azure:a.openai.azure.com");
    });

    it("cannot be paired by settings saved later: a save mirrors them into the environment", () => {
      // Repoint the endpoint (the key is forgotten), wait for a restart (the desktop's copy returns as LUNABOT_OPENAI_LIVE_KEY),
      // then save the same service and endpoint again, which puts both in the environment beside that copy.
      const evil = "https://evil.azure-api.net";
      const afterMove: LiveConfig = { provider: "azure", azureEndpoint: evil, key: "", keyFor: "nowhere" };
      const mirrored = { LUNABOT_OPENAI_LIVE_KEY: "from-the-store", LUNABOT_LIVE_PROVIDER: "azure", LUNABOT_AZURE_OPENAI_LIVE_ENDPOINT: evil };
      expect(liveSavePatch(liveConfigWithEnv(afterMove, { LUNABOT_OPENAI_LIVE_KEY: "from-the-store" }), { provider: "azure" })).toEqual({ provider: "azure" });
      expect(usable(afterMove, mirrored)).toBeUndefined();
    });

    it("re-pairs an operator's different key with the endpoint set beside it", () => {
      expect(usable(onA, { LUNABOT_OPENAI_LIVE_KEY: "operators", LUNABOT_LIVE_PROVIDER: "azure", LUNABOT_AZURE_OPENAI_LIVE_ENDPOINT: B })).toBe("operators");
    });

    it("does not pair a key there with an endpoint or service only the file names", () => {
      expect(usable({ provider: "azure", azureEndpoint: A }, { LUNABOT_OPENAI_LIVE_KEY: "operators" })).toBeUndefined();
      expect(usable({ azureEndpoint: A }, { LUNABOT_OPENAI_LIVE_KEY: "operators", LUNABOT_LIVE_PROVIDER: "azure" })).toBeUndefined();
      expect(usable({ provider: "azure" }, { LUNABOT_OPENAI_LIVE_KEY: "operators", LUNABOT_AZURE_OPENAI_LIVE_ENDPOINT: A })).toBeUndefined();
      expect(usable(onA, { LUNABOT_LIVE_PROVIDER: "azure", LUNABOT_AZURE_OPENAI_LIVE_ENDPOINT: B })).toBeUndefined();
    });

    it("takes no binding from the file when it is a different key from the one saved there", () => {
      expect(usable(onA, { LUNABOT_OPENAI_LIVE_KEY: "another" })).toBeUndefined();
      expect(usable({ ...onA, provider: "openai", keyFor: "openai" }, { LUNABOT_OPENAI_LIVE_KEY: "another" })).toBe("another");
      expect(usable(onA, { LUNABOT_OPENAI_LIVE_KEY: "k" })).toBe("k");
    });

    it("keeps OpenAI working as it did with only a key set", () => {
      expect(usable(undefined, { LUNABOT_OPENAI_LIVE_KEY: "sk-env" })).toBe("sk-env");
      expect(usable({ voice: "cedar" }, { LUNABOT_OPENAI_LIVE_KEY: "sk-env", LUNABOT_LIVE_PROVIDER: "openai" })).toBe("sk-env");
    });
  });
});

describe("Live calls through Doubao realtime speech", () => {
  const volc = { provider: "volc" as const, volcAppId: "6255978659", volcModel: "1.2.1.1" };
  const keyFor = "volc";

  it("never falls back to the OpenAI API key: the speech app's own token is required", () => {
    const cfg = { live: volc, openai: { key: "sk-openai" } } as AppConfig;
    expect(liveCallKey(cfg)).toBeNull();
    expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_VOLC);
  });

  it("is ready with the App ID, the token and a valid model version", () => {
    const cfg = { live: { ...volc, key: "volc-token", keyFor } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "volc-token", source: "live" });
    expect(liveCallEndpoint(cfg)).toEqual({ provider: "volc", apiBase: "wss://openspeech.bytedance.com", model: "1.2.1.1" });
    const settings = liveSettingsFor(cfg);
    expect(settings).toMatchObject({ configured: true, keySource: "live", provider: "volc", volcAppId: "6255978659", volcModel: "1.2.1.1" });
    expect(JSON.stringify(settings)).not.toContain("volc-token");
  });

  it("reports its own setup problem until the App ID is there, key or not", () => {
    const cfg = { live: { provider: "volc" as const, key: "k", keyFor } } as AppConfig;
    expect(liveCallKey(cfg)).toEqual({ key: "k", source: "live" });
    expect(liveCallEndpoint(cfg)).toBeNull();
    expect(liveSetupProblem(cfg)).toBe(LIVE_NEEDS_VOLC);
    expect(liveCallSettings({ live: { provider: "volc" } } as AppConfig)).toMatchObject({ provider: "volc", endpoint: null, key: "", setupProblem: LIVE_NEEDS_VOLC });
    expect(liveCallSettings({ live: { ...volc, key: "k", keyFor } } as AppConfig)).toMatchObject({ provider: "volc", key: "k", setupProblem: null, endpoint: { provider: "volc" } });
  });

  it("a caller without the admin scope learns the provider, not the app", () => {
    const client = liveSettingsForClient(liveSettingsFor({ live: { ...volc, key: "volc-token", keyFor } } as AppConfig));
    expect(client).toEqual({ configured: true, keySource: "live", provider: "volc", voice: "", readTypedReplies: true, idleMinutes: 5 });
  });

  it("an empty model means the O2.0 default", () => {
    expect(liveCallEndpoint({ live: { ...volc, volcModel: "" } } as AppConfig)?.model).toBe("1.2.1.1");
  });

  it("the key is tied to the service itself: the host is fixed, so saving pairs them by provider", () => {
    expect(liveKeyTarget({ provider: "volc" })).toBe("volc");
    expect(liveSavePatch(undefined, { key: "tok", provider: "volc", volcAppId: "6255978659" })).toEqual({ key: "tok", provider: "volc", volcAppId: "6255978659", keyFor: "volc" });
    const onVolc: LiveConfig = { provider: "volc", volcAppId: "6255978659", key: "tok", keyFor: "volc" };
    expect(usableLiveKey(onVolc)).toBe("tok");
    expect(usableLiveKey({ ...onVolc, volcAppId: "9999999999" })).toBe("tok");
    expect(liveSavePatch(onVolc, { provider: "openai" })).toEqual({ provider: "openai", key: "", keyFor: "nowhere" });
    expect(liveSavePatch(onVolc, { volcModel: "2.2.0.0" })).toEqual({ volcModel: "2.2.0.0" });
  });

  it("pairs a token and an App ID set together in the environment", () => {
    const env = { LUNABOT_OPENAI_LIVE_KEY: "operators", LUNABOT_LIVE_PROVIDER: "volc", LUNABOT_LIVE_VOLC_APP_ID: "6255978659", LUNABOT_LIVE_VOLC_MODEL: "2.2.0.0" };
    const merged = liveConfigWithEnv(undefined, env);
    expect(usableLiveKey(merged)).toBe("operators");
    expect(merged).toMatchObject({ provider: "volc", volcAppId: "6255978659", volcModel: "2.2.0.0", keyFor: "volc" });
    expect(usableLiveKey(liveConfigWithEnv({ provider: "volc" }, { LUNABOT_OPENAI_LIVE_KEY: "operators" }))).toBeUndefined();
  });
});
