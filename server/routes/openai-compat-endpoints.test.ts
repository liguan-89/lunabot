// The custom provider is one config slot (config.json's openaiCompat); the routes that added more
// OpenAI-compatible instances were removed with the other engines, so only URL handling remains here.
import { describe, expect, it } from "vitest";

import { endpointBaseUrl, endpointDisplayUrl } from "../openai-compat-endpoints.ts";

describe("base URL handling", () => {
  it("keeps origin and path only", () => {
    expect(endpointBaseUrl("")).toBeNull();
    expect(endpointBaseUrl("   ")).toBeNull();
    expect(endpointBaseUrl(" http://localhost:11434/v1/ ")).toBe("http://localhost:11434/v1");
    expect(endpointBaseUrl("https://a.example/v1#x")).toBeNull();
    expect(endpointDisplayUrl({ url: "https://user:pw@a.example/v1?key=s#f" })).toBe("https://a.example/v1");
    expect(endpointDisplayUrl({ url: "not a url" })).toBeUndefined();
    expect(endpointDisplayUrl({})).toBeUndefined();
  });
});
