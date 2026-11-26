// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PackageSummary } from "../../shared/package-format";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; init?: { method?: string; body?: string } }>,
  templates: [] as Array<{ slug: string; savedAt: string; summary: PackageSummary }>,
  document: { format: "openmaus.package", version: 2 } as unknown,
  failures: {} as Record<string, string>,
}));

vi.mock("@/state/store", () => ({
  api: async (path: string, init?: { method?: string; body?: string }) => {
    fixture.calls.push({ path, init });
    const failure = fixture.failures[`${init?.method ?? "GET"} ${path}`] ?? fixture.failures[path];
    if (failure) throw new Error(failure);
    if (path === "/api/templates") return { templates: fixture.templates };
    if (path.startsWith("/api/templates/") && !init?.method) return { document: fixture.document };
    return { ok: true };
  },
}));

import { intlLocale, setLocale } from "@/lib/i18n";
import { MyTemplates, type TemplateEntry } from "./TeamLibraryPanelMine";

const summary = (name: string, bots: number, botNames: string[], tagline = ""): PackageSummary => ({
  kind: "team",
  name,
  tagline,
  counts: { bots, skills: 0, presets: 0, rooms: 0, routines: 0, connections: 0, playbooks: 0 },
  botNames,
  skillNames: [],
  presetNames: [],
  connectionLabels: [],
  apps: [],
});

const entries: TemplateEntry[] = [
  { slug: "sales-desk", savedAt: "2026-11-20T10:00:00.000Z", summary: summary("Sales desk", 3, ["Morgan", "Scout", "Quill"], "Answers inbound leads") },
  { slug: "support", savedAt: "", summary: summary("Support", 1, ["Riley"]) },
];

let container: HTMLDivElement, root: Root;
const onPreview = vi.fn();
const onDialog = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.calls = [];
  fixture.templates = entries.map((entry) => ({ ...entry }));
  fixture.failures = {};
  onPreview.mockClear();
  onDialog.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(MyTemplates, { onPreview, onDialog })));
}

function button(label: string, rootNode: ParentNode = document.body) {
  return [...rootNode.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label,
  );
}

describe("MyTemplates", () => {
  it("renders every saved template with its name, bot count, saved date and actions", async () => {
    await render();
    const text = container.textContent!;
    expect(text).toContain("My templates");
    expect(text).toContain("Sales desk");
    expect(text).toContain("Answers inbound leads");
    expect(text).toContain("3 bot(s)");
    expect(text).toContain(`Saved ${new Date("2026-11-20T10:00:00.000Z").toLocaleDateString(intlLocale())}`);
    expect(text).toContain("Support");
    expect(text).toContain("Riley");
    expect(text).not.toContain("Morgan, Scout, Quill");
    expect(button("Install Sales desk")).toBeTruthy();
    expect(button("Delete template Sales desk")).toBeTruthy();
    expect(fixture.calls).toEqual([{ path: "/api/templates", init: undefined }]);
  });

  it("shows nothing when the library is empty", async () => {
    fixture.templates = [];
    await render();
    expect(container.textContent).toBe("");
  });

  it("offers the error and a retry when the list cannot be loaded", async () => {
    fixture.failures["/api/templates"] = "The templates could not be read";
    await render();
    expect(container.textContent).toContain("The templates could not be read");
    const retry = button("Try again");
    expect(retry).toBeTruthy();
    delete fixture.failures["/api/templates"];
    await act(async () => retry!.click());
    expect(container.textContent).toContain("Sales desk");
  });

  it("installing fetches the document and hands it to the preview", async () => {
    await render();
    await act(async () => button("Install Sales desk")!.click());
    expect(fixture.calls.map((call) => `${call.init?.method ?? "GET"} ${call.path}`)).toEqual([
      "GET /api/templates",
      "GET /api/templates/sales-desk",
    ]);
    expect(onPreview).toHaveBeenCalledWith(fixture.document);
  });

  it("deleting asks first, removes the row on confirm, and reports the dialog to the panel", async () => {
    await render();
    expect(button("Delete")).toBeFalsy();
    await act(async () => button("Delete template Sales desk")!.click());
    expect(onDialog).toHaveBeenLastCalledWith(true);
    const confirm = button("Delete");
    expect(confirm).toBeTruthy();
    expect(document.body.textContent).toContain("Delete Sales desk?");
    await act(async () => confirm!.click());
    expect(fixture.calls.map((call) => `${call.init?.method ?? "GET"} ${call.path}`)).toContain("DELETE /api/templates/sales-desk");
    expect(container.textContent).not.toContain("Sales desk");
    expect(container.textContent).toContain("Support");
    expect(onDialog).toHaveBeenLastCalledWith(false);
  });

  it("cancelling the deletion keeps the template and sends nothing", async () => {
    await render();
    await act(async () => button("Delete template Support")!.click());
    await act(async () => button("Cancel")!.click());
    expect(fixture.calls.some((call) => call.init?.method === "DELETE")).toBe(false);
    expect(container.textContent).toContain("Support");
    expect(onDialog).toHaveBeenLastCalledWith(false);
  });

  it("keeps the row and shows the server's answer when the delete fails", async () => {
    fixture.failures["DELETE /api/templates/sales-desk"] = "That template does not exist.";
    await render();
    await act(async () => button("Delete template Sales desk")!.click());
    await act(async () => button("Delete")!.click());
    expect(container.textContent).toContain("Sales desk");
    expect(container.querySelector("[role='alert']")?.textContent).toBe("That template does not exist.");
  });
});
