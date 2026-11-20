// The judge prompt's language name: BCP-47 tags resolve through Intl.DisplayNames,
// anything unreadable or unknown falls back to English rather than echoing the tag.
import { describe, expect, it } from "vitest";

import { languageName } from "./notice-delivery.ts";

describe("languageName", () => {
  it("resolves the UI language tag to its English name", () => {
    expect(languageName("zh")).toBe("Chinese");
    expect(languageName("en")).toBe("English");
    expect(languageName("de")).toBe("German");
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("ko")).toBe("Korean");
  });

  it("honours region and script subtags", () => {
    expect(languageName("pt-br")).toBe("Brazilian Portuguese");
    expect(languageName("zh-hans")).toBe("Simplified Chinese");
    expect(languageName("zh-hant")).toBe("Traditional Chinese");
  });

  it("falls back to English for missing, malformed or unknown tags", () => {
    expect(languageName(undefined)).toBe("English");
    expect(languageName("")).toBe("English");
    expect(languageName("not a tag!")).toBe("English");
    expect(languageName("zz")).toBe("English");
  });
});
