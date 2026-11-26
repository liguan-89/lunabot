// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { packageSummary, parsePackageDocument } from "../../shared/package-format";
import type { ShareResponse } from "@/lib/team-share";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: Record<string, unknown> }>,
  answer: null as ShareResponse | null,
  failTemplates: "",
}));

vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { bots: [] }, dispatch: () => {} }),
  api: async (path: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    fixture.calls.push({ path, body });
    if (path === "/api/templates") {
      if (fixture.failTemplates) throw new Error(fixture.failTemplates);
      return { template: { slug: "sales-desk" } };
    }
    if (path === "/api/teams/export") return fixture.answer;
    return {};
  },
}));

import { setLocale } from "@/lib/i18n";
import { ShareTeamDialog } from "./ShareTeamDialog";

const shareAnswer = (): ShareResponse => {
  const document = parsePackageDocument(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8")));
  return {
    document,
    filename: "sales-desk-1.3.0.openmaus.json",
    summary: packageSummary(document),
    choices: { skills: [] },
    redacted: [],
    skipped: [],
  };
};

let container: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.calls = [];
  fixture.answer = shareAnswer();
  fixture.failTemplates = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function render() {
  await act(async () => root.render(createElement(ShareTeamDialog, { team: "Sales desk", onClose: vi.fn() })));
  // The preview export debounces 250 ms after the picture pass settles.
  await act(async () => sleep(320));
}

function button(label: string) {
  return [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
}

describe("ShareTeamDialog store to templates", () => {
  it("offers Save to templates once the preview is ready", async () => {
    await render();
    const store = button("Save to templates");
    expect(store).toBeTruthy();
    expect((store as HTMLButtonElement).disabled).toBe(false);
    const previews = fixture.calls.filter((call) => call.path === "/api/teams/export");
    expect(previews).toHaveLength(1);
    expect(previews[0]!.body.dryRun).toBe(true);
  });

  it("stores the same export the file save would produce, release included and never a dry run", async () => {
    await render();
    fixture.calls = [];
    await act(async () => button("Save to templates")!.click());
    await act(async () => sleep(0));
    const [exported, stored] = fixture.calls;
    expect(exported?.path).toBe("/api/teams/export");
    expect(exported?.body.dryRun).toBeUndefined();
    expect(exported?.body.release).toBe("1.3.0");
    expect(stored?.path).toBe("/api/templates");
    expect(stored?.body.document).toEqual(JSON.parse(JSON.stringify(fixture.answer!.document)));
    expect(document.body.textContent).toContain("Saved to your templates");
  });

  it("shows the server's answer when the library refuses the template", async () => {
    await render();
    fixture.calls = [];
    fixture.failTemplates = "The template could not be saved.";
    await act(async () => button("Save to templates")!.click());
    await act(async () => sleep(0));
    expect(fixture.calls.some((call) => call.path === "/api/templates")).toBe(true);
    expect(document.body.querySelector("[role='alert']")?.textContent).toBe("The template could not be saved.");
    expect(document.body.textContent).not.toContain("Saved to your templates");
  });
});
