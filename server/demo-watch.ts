// watch_me's capture: a page-side listener script records the person's clicks, typing, key presses and
// submits while they hold the browser, and DemoWatch turns the harvested entries into the step
// transcript the bot saves as a skill. Password and card fields record the field, never the value.

export type DemoEntry =
  | { k: "click"; t: string; url: string }
  | { k: "fill"; t: string; v?: string; s?: 1; url: string }
  | { k: "press"; key: string; t: string; url: string }
  | { k: "submit"; t: string; url: string };

export type DemoHarvest = { entries: DemoEntry[]; href?: string; title?: string };

/**
 * Idempotent: installs the listeners once per page and drains `sessionStorage.__ombDemo`, so the
 * entries a person left before navigating are read on the next page of the same site.
 */
export const DEMO_HARVEST = `(function () {
  var KEY = "__ombDemo";
  try {
    if (!window.__ombDemoTapped) {
      window.__ombDemoTapped = true;
      var push = function (entry) {
        try {
          var list = JSON.parse(sessionStorage.getItem(KEY) || "[]");
          entry.url = location.href;
          list.push(entry);
          sessionStorage.setItem(KEY, JSON.stringify(list.slice(-400)));
        } catch (e) {}
      };
      var describe = function (el) {
        if (!el || !el.tagName) return "the page";
        var tag = String(el.tagName).toLowerCase();
        var bits = tag + (el.id ? "#" + el.id : "");
        var label = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name"))) || "";
        var text = tag === "input" || tag === "select" || tag === "textarea" ? "" : String(el.innerText || "").trim().slice(0, 60);
        var name = label || text;
        return name ? bits + ' "' + String(name).replace(/"/g, "").slice(0, 80) + '"' : bits;
      };
      var secretField = function (el) {
        if (!el || !el.getAttribute) return false;
        if (String(el.type || "").toLowerCase() === "password") return true;
        var ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
        return /cc-|password|one-time-code/.test(ac);
      };
      document.addEventListener("click", function (e) { push({ k: "click", t: describe(e.target) }); }, true);
      document.addEventListener("input", function (e) {
        var el = e.target;
        var entry = { k: "fill", t: describe(el) };
        if (secretField(el)) entry.s = 1;
        else entry.v = String(el.value == null ? "" : el.value).slice(0, 200);
        push(entry);
      }, true);
      document.addEventListener("change", function (e) {
        var el = e.target;
        if (el && String(el.tagName).toLowerCase() === "select") push({ k: "fill", t: describe(el), v: String(el.value == null ? "" : el.value).slice(0, 60) });
      }, true);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === "Tab" || e.key === "Escape") push({ k: "press", key: e.key, t: describe(e.target) });
      }, true);
      document.addEventListener("submit", function (e) { push({ k: "submit", t: describe(e.target) }); }, true);
    }
    var entries = [];
    try { entries = JSON.parse(sessionStorage.getItem(KEY) || "[]"); sessionStorage.setItem(KEY, "[]"); } catch (e) {}
    return { entries: entries, href: location.href, title: document.title };
  } catch (e) { return { entries: [], error: String(e) }; }
})()`;

export type DemoOutcome = { ok: true; text: string } | { ok: false; text: string };

/** Coalesce the input event storm into the steps a person would read back: navigation, clicks, one
 * fill per field per stretch, discrete keys and submits. */
export function demoTranscript(entries: DemoEntry[]): DemoOutcome {
  const kept: DemoEntry[] = [];
  for (const entry of entries) {
    const prev = kept[kept.length - 1];
    if (entry.k === "fill" && prev?.k === "fill" && prev.t === entry.t && prev.url === entry.url && (prev.s ?? 0) === (entry.s ?? 0)) {
      kept[kept.length - 1] = entry;
      continue;
    }
    kept.push(entry);
  }
  const steps: string[] = [];
  let lastUrl: string | undefined;
  const open = (url: string | undefined) => {
    if (url && url !== lastUrl && url !== "about:blank") { steps.push(`Opened ${url}`); lastUrl = url; }
  };
  for (const entry of kept.slice(0, 60)) {
    open(entry.url);
    if (entry.k === "click") steps.push(`Clicked ${entry.t}`);
    else if (entry.k === "fill") steps.push(entry.s === 1 ? `Typed into ${entry.t} (the value was theirs and was not recorded)` : `Typed ${JSON.stringify(entry.v ?? "")} into ${entry.t}`);
    else if (entry.k === "press") steps.push(`Pressed ${entry.key} on ${entry.t}`);
    else if (entry.k === "submit") steps.push(`Submitted ${entry.t}`);
  }
  if (!steps.length) {
    return { ok: false, text: "The person took the browser but showed nothing before handing it back. Ask them to show the steps again, slower." };
  }
  const shown = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return {
    ok: true,
    text: `The person showed you these steps in the browser:\n${shown}\nThey then handed the browser back. You can repeat the steps with your own browser tools now, or save them as a skill when the person asks you to remember this.`,
  };
}

interface Watch {
  entries: DemoEntry[];
  lastHarvest: number;
  handedBack: Array<() => void>;
}

/** Which browser sessions are recording a person demo right now; entries accumulate across pages. */
export class DemoWatch {
  private readonly watches = new Map<string, Watch>();
  private readonly harvestEveryMs: number;

  constructor(harvestEveryMs = 300) {
    this.harvestEveryMs = harvestEveryMs;
  }

  begin(session: string): boolean {
    if (this.watches.has(session)) return false;
    this.watches.set(session, { entries: [], lastHarvest: 0, handedBack: [] });
    return true;
  }

  watching(session: string): boolean {
    return this.watches.has(session);
  }

  /** Resolves when the person's hold on this session ends — their hand-back, a dropped view's grace expiring, or a close. */
  waitForHandBack(session: string): Promise<void> {
    const watch = this.watches.get(session);
    if (!watch) return Promise.resolve();
    return new Promise((resolve) => { watch.handedBack.push(resolve); });
  }

  /** The live view reports the person's hold on this session over. */
  notifyHandedBack(session: string): void {
    const watch = this.watches.get(session);
    if (!watch) return;
    for (const resolve of watch.handedBack.splice(0)) resolve();
  }

  /** A harvest is due when a watch is open and the throttle window passed; the closing harvest always runs. */
  due(session: string): boolean {
    const watch = this.watches.get(session);
    if (!watch) return false;
    const now = Date.now();
    if (now - watch.lastHarvest < this.harvestEveryMs) return false;
    watch.lastHarvest = now;
    return true;
  }

  append(session: string, harvested: unknown): void {
    const watch = this.watches.get(session);
    const data = harvested as Partial<DemoHarvest> | null;
    if (!watch || !data) return;
    for (const raw of Array.isArray(data.entries) ? data.entries : []) {
      const entry = raw as DemoEntry;
      if (!entry || typeof entry !== "object") continue;
      const shaped = (entry.k === "click" || entry.k === "fill" || entry.k === "submit") && typeof entry.t === "string"
        || entry.k === "press" && typeof entry.key === "string";
      if (shaped) watch.entries.push(entry);
    }
  }

  /** Ends the watch and renders what was captured; a null harvest means the browser never answered. */
  finish(session: string, harvested?: unknown): DemoOutcome {
    if (harvested !== undefined) this.append(session, harvested);
    const watch = this.watches.get(session);
    this.watches.delete(session);
    if (!watch) return { ok: false, text: "The demo recording was not open." };
    return demoTranscript(watch.entries);
  }
}
