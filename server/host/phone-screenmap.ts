// The per-owner screenmap store and the observer that learns from the screens
// phone answers already carry. Pages live in
// DATA_DIR/phone-screenmaps/<owner>/<package>.json — folders 0700, files 0600,
// written atomically, bounded per owner (apps) and per app (pages) — the same
// shape the phone routes folder keeps its per-owner files in.
//
// Learning happens where the host ledger records an answered call: the screen
// the call read (or left) folds in as a page, and the step from the previous
// screen to this one becomes an edge. A repeat of the screen already learned
// for that phone is skipped, so rereads cost nothing; every other write is
// small and atomic.

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import {
  MAP_LIMITS, learnStep, mergeNode, nodeFor, renderMap, screenId, skeletonSignature,
  type MapScreen, type ScreenGraph,
} from "../phone-screenmap.ts";
import type { ScreenSnapshot } from "../../shared/route-replay.ts";

const MAX_LAST_LEARNED = 64;

export interface PhoneScreenmaps {
  /** Learn from one answered call's screen; never throws. */
  observe(owner: string, phoneKey: string, tool: string, target: string | null, before: ScreenSnapshot | null, screen: ScreenSnapshot): void;
  /** The map text a turn's prompt carries, capped; empty when nothing is learned yet. */
  reference(owner: string): string;
  /** The graph one owner has for one app, for tests and later consumers. */
  graph(owner: string, app: string): ScreenGraph | null;
}

interface StoreDeps {
  dataDir: string;
  now: () => number;
  /** The most apps and pages kept, for tests to shrink. */
  limits?: { appsPerOwner?: number; nodesPerApp?: number };
}

const toMapScreen = (screen: ScreenSnapshot): MapScreen => ({
  app: screen.packageName ?? "",
  elements: screen.elements,
});

const PAGE_CHARS = 500;
const REFERENCE_CHARS = 1500;

export function createPhoneScreenmaps(deps: StoreDeps): PhoneScreenmaps {
  const { dataDir } = deps;
  const root = join(dataDir, "phone-screenmaps");
  const appsPerOwner = deps.limits?.appsPerOwner ?? MAP_LIMITS.appsPerOwner;
  const nodesPerApp = deps.limits?.nodesPerApp ?? MAP_LIMITS.nodesPerApp;
  /** The last screen each phone taught the map, so a reread of the same page learns nothing. */
  const lastLearned = new Map<string, MapScreen>();
  /** Graphs in memory, written through on every learn: the files are small and the calls are slow. */
  const cache = new Map<string, ScreenGraph>();

  const appFile = (owner: string, app: string) => join(root, owner, `${encodeURIComponent(app)}.json`);

  const load = (owner: string, app: string): ScreenGraph => {
    const key = `${owner}\u0000${app}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let graph: ScreenGraph = { app, nodes: {} };
    try {
      const raw = JSON.parse(readFileSync(appFile(owner, app), "utf8")) as ScreenGraph;
      if (raw?.app === app && raw.nodes && typeof raw.nodes === "object") graph = raw;
    } catch {
      // No file yet, or one that cannot be read: the map starts empty.
    }
    cache.set(key, graph);
    return graph;
  };

  const save = (owner: string, graph: ScreenGraph): void => {
    try {
      mkdirSync(join(root, owner), { recursive: true, mode: 0o700 });
      const trimmed = trimGraph(graph, nodesPerApp);
      cache.set(`${owner}\u0000${graph.app}`, trimmed);
      writeFileAtomic(appFile(owner, graph.app), JSON.stringify(trimmed), { mode: 0o600 });
      trimOwner(root, owner, appsPerOwner);
    } catch {
      // A map that cannot be saved must not affect the call that taught it.
    }
  };

  const observe: PhoneScreenmaps["observe"] = (owner, phoneKey, tool, target, before, screen) => {
    try {
      if (owner === "" || !screen.packageName) return;
      const current = toMapScreen(screen);
      const signature = skeletonSignature(flat(current));
      const previousLearned = lastLearned.get(phoneKey);
      if (previousLearned !== undefined && previousLearned.app === current.app &&
        skeletonSignature(flat(previousLearned)) === signature) {
        lastLearned.set(phoneKey, current);
        return;
      }
      const graph = load(owner, current.app);
      // The step starts from the last screen this phone taught the map, or,
      // before any, from the screen the call was read against.
      const previous = previousLearned ?? (before?.packageName ? toMapScreen(before) : null);
      const next = previous === null || previous.app !== current.app
        ? mergeNode(graph, nodeFor(current))
        : learnStep(graph, previous, { tool, target: target ?? null }, current);
      save(owner, next);
      lastLearned.set(phoneKey, current);
      evictLastLearned();
    } catch {
      // Learning must never affect the call that taught it.
    }
  };

  const reference: PhoneScreenmaps["reference"] = (owner) => {
    try {
      const folder = join(root, owner);
      let names: string[] = [];
      try {
        names = readdirSync(folder).filter((name) => name.endsWith(".json"));
      } catch {
        return "";
      }
      const ranked = names
        .map((name) => {
          try {
            const graph = JSON.parse(readFileSync(join(folder, name), "utf8")) as ScreenGraph;
            const visits = Object.values(graph.nodes ?? {}).reduce((sum, node) => sum + (node?.visits ?? 0), 0);
            return { graph, visits };
          } catch {
            return null;
          }
        })
        .filter((entry): entry is { graph: ScreenGraph; visits: number } => entry !== null)
        .sort((left, right) => right.visits - left.visits);
      const sections: string[] = [];
      let total = 0;
      for (const { graph } of ranked) {
        const nodes = Object.keys(graph.nodes ?? {}).length;
        if (nodes === 0) continue;
        const text = renderMap(graph, null);
        if (total + text.length > REFERENCE_CHARS || sections.length >= 3) break;
        sections.push(`App ${graph.app}:\n${text.slice(0, PAGE_CHARS)}`);
        total += text.length;
      }
      return sections.length === 0 ? "" : `Screens this phone has seen before (a reference, not a promise):\n${sections.join("\n")}`;
    } catch {
      return "";
    }
  };

  function evictLastLearned(): void {
    while (lastLearned.size > MAX_LAST_LEARNED) {
      const oldest = lastLearned.keys().next().value;
      if (oldest === undefined) break;
      lastLearned.delete(oldest);
    }
  }

  return {
    observe,
    reference,
    graph: (owner, app) => {
      const graph = load(owner, app);
      return Object.keys(graph.nodes).length === 0 ? null : graph;
    },
  };
}

function flat(screen: MapScreen): string[] {
  return screen.elements.flatMap((element) => [element.text ?? "", element.description ?? ""]).filter(Boolean);
}

function trimGraph(graph: ScreenGraph, nodesPerApp: number): ScreenGraph {
  const entries = Object.entries(graph.nodes);
  if (entries.length <= nodesPerApp) return graph;
  const kept = entries
    .sort((left, right) => right[1].visits - left[1].visits)
    .slice(0, nodesPerApp);
  return { app: graph.app, nodes: Object.fromEntries(kept) };
}

function trimOwner(root: string, owner: string, appsPerOwner: number): void {
  const folder = join(root, owner);
  let names: string[] = [];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= appsPerOwner) return;
  const ranked = names
    .map((name) => {
      const path = join(folder, name);
      try {
        const graph = JSON.parse(readFileSync(path, "utf8")) as ScreenGraph;
        const visits = Object.values(graph.nodes ?? {}).reduce((sum, node) => sum + (node?.visits ?? 0), 0);
        return { name, path, visits, at: statSync(path).mtimeMs };
      } catch {
        return { name, path, visits: 0, at: 0 };
      }
    })
    .sort((left, right) => right.visits - left.visits || right.at - left.at);
  for (const entry of ranked.slice(appsPerOwner)) {
    try {
      unlinkSync(entry.path);
    } catch {}
  }
}

/** The id the store would give a screen, exported for tests through the store's own maths. */
export const pageIdFor = (app: string, elements: readonly { text?: string | null; description?: string | null }[]): string =>
  screenId(app, skeletonSignature(elements.flatMap((element) => [element.text ?? "", element.description ?? ""]).filter(Boolean)));
