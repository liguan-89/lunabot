import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./TeamLibraryPanel.tsx", import.meta.url), "utf8");

describe("TeamLibraryPanel", () => {
  it("dims the app behind Templates without a full-window backdrop blur", () => {
    // Without a GPU (software rendering) a full-window blur is redrawn on every frame, so the page lags while it is open.
    const overlay = source.match(/className="(fixed inset-0 [^"]*)"/)?.[1];
    expect(overlay).toContain("bg-black/55");
    expect(source).not.toMatch(/backdrop-blur|backdrop-filter|backdropFilter/);
  });

  it("leads Explore with the saved templates, installed through the same preview as the catalog", () => {
    expect(source.indexOf("<MyTemplates")).toBeGreaterThan(-1);
    expect(source.indexOf("<MyTemplates")).toBeLessThan(source.indexOf("<ReadyBotGallery"));
    expect(source).toContain('previewManifest(teamImportPreview(document), "template")');
  });
});
