// A per-app screen map learned from the screens phone answers already carry:
// each structural page becomes one node keyed by its skeleton anchors, and a
// tap that moved one page to another becomes a transition edge. At turn start
// the map renders as a compact reference the model reads before it drives.
//
// Ported from Mika's core/screenmap (ScreenNode, ScreenGraph,
// ScreenRecognizer, ScreenMapRender) and the RouteAnchors skeleton rules in
// core/replay/Route.kt (Apache-2.0; attribution in third_party/mika/README.md).
// Changes: TypeScript, and the skeleton comes from the screen snapshots the
// host ledger already records — elements with text/description/viewId/class/
// bounds/editable/scrollable — rather than Mika's ScreenSnapshot type. The
// storage glue, the run-trail plumbing and the replay hooks are ours.

/** The pieces of a screen element the skeleton and the edges read. */
export interface MapElement {
  text?: string | null;
  description?: string | null;
  viewId?: string | null;
  class?: string | null;
  bounds?: readonly number[] | null;
  editable?: boolean;
  scrollable?: boolean;
}

/** One screen an answer carried: the app in front and its elements. */
export interface MapScreen {
  app: string;
  elements: readonly MapElement[];
}

/** One tap that moved the map: the tool that ran and the element it named. */
export interface MapAction {
  tool: string;
  /** The tapped control's own label, when the step named one on the screen it was read against. */
  target?: string | null;
}

/** A click navigation edge: tapping [target] with [action] on this page reached [to]. */
export interface ScreenEdge {
  action: string;
  target: string;
  to: string;
  count: number;
}

export interface ScreenNode {
  /** The app package this page belongs to; also the storage key. */
  app: string;
  /** The page's skeleton anchors, each with the times it was seen. */
  anchors: Record<string, number>;
  /** Click edges out, keyed by `action\u0000target\u0000to`. */
  edges: Record<string, ScreenEdge>;
  /** How many learned screens folded into this page. */
  visits: number;
}

export interface ScreenGraph {
  app: string;
  nodes: Record<string, ScreenNode>;
}

/** Anchor texts are short: numbers, times and amounts change on every visit. */
const VOLATILE = /[0-9０-９¥￥$€£%]/;
const ANCHOR_MAX_LEN = 12;
const LIST_ROLES = new Set(["list", "grid", "recycler", "scroll"]);

/** Whether one label can stand for the page itself, not for content or typing. */
export function stableAnchorText(text: string | null | undefined): boolean {
  const trimmed = (text ?? "").trim();
  return trimmed.length >= 1 && trimmed.length <= ANCHOR_MAX_LEN && !VOLATILE.test(trimmed);
}

function container(element: MapElement): boolean {
  return element.scrollable === true || LIST_ROLES.has((element.class ?? "").toLowerCase());
}

function insideOf(element: MapElement, containerElement: MapElement): boolean {
  const inner = element.bounds;
  const outer = containerElement.bounds;
  return element !== containerElement && inner?.length === 4 && outer?.length === 4 &&
    inner[0]! >= outer[0]! && inner[1]! >= outer[1]! && inner[2]! <= outer[2]! && inner[3]! <= outer[3]!;
}

/**
 * The page's skeleton anchors, in screen order, anchors with a view id first:
 * fixed chrome only — a title, a tab, a bottom bar. Rows inside a list and
 * words in an editable field are content and typing, never anchors.
 */
export function skeletonTexts(elements: readonly MapElement[]): string[] {
  const boxes = elements.filter(container);
  const anchors = elements
    .filter((element) => element.editable !== true && !container(element) &&
      boxes.every((box) => !insideOf(element, box)))
    .flatMap((element) => [element.text, element.description].filter(stableAnchorText))
    .map((text) => (text as string).trim());
  return [...new Set(anchors)];
}

/** A deterministic page id: the same app and skeleton is always the same page. */
export function screenId(app: string, signature: string): string {
  return (app + "\u0000" + signature).length === 0 ? "" : sha8(app + "\u0000" + signature);
}

function sha8(text: string): string {
  // A cheap deterministic digest for a map that is rebuilt from the same
  // screens byte for byte; no secrecy is needed of it.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** The skeleton signature: anchors distinct and sorted, the identity of a page. */
export function skeletonSignature(texts: readonly string[]): string {
  return [...new Set(texts)].sort().join("\u0000");
}

/** The node a learned screen folds into, with its anchors counted. */
export function nodeFor(screen: MapScreen): ScreenNode {
  const texts = skeletonTexts(screen.elements);
  const anchors: Record<string, number> = {};
  for (const text of texts) anchors[text] = (anchors[text] ?? 0) + 1;
  return {
    app: screen.app,
    anchors,
    edges: {},
    visits: 1,
  };
}

const edgeKey = (action: string, target: string, to: string) => `${action}\u0000${target}\u0000${to}`;

/**
 * One learned step: the screen an action landed on folds in as a page, and —
 * when the previous screen was the same app and a different page — the action
 * becomes an edge from that page to this one. A page never seen before joins
 * the map with its own skeleton; recognition is only for "where am I", not
 * for whether a page exists.
 */
export function learnStep(graph: ScreenGraph, prev: MapScreen, action: MapAction, screen: MapScreen): ScreenGraph {
  const thisNode = nodeFor(screen);
  const thisId = screenId(screen.app, skeletonSignature(Object.keys(thisNode.anchors)));
  if (prev.app !== screen.app) {
    // The action left the app: no edge across maps, but the page it reached counts.
    return mergeNode(graph, thisNode);
  }
  const prevNode = nodeFor(prev);
  const prevId = screenId(prev.app, skeletonSignature(Object.keys(prevNode.anchors)));
  let out = mergeNode(mergeNode(graph, prevNode), thisNode);
  if (prevId === thisId) return out;
  const from = out.nodes[prevId]!;
  const target = (action.target ?? "").trim();
  const key = edgeKey(action.tool, target, thisId);
  const edges = {
    ...from.edges,
    [key]: { action: action.tool, target: target || action.tool, to: thisId, count: (from.edges[key]?.count ?? 0) + 1 },
  };
  return { ...out, nodes: { ...out.nodes, [prevId]: { ...from, edges } } };
}

/** Fold one node into a graph: same id adds counts, a new id joins. */
export function mergeNode(graph: ScreenGraph, node: ScreenNode): ScreenGraph {
  if (node.app !== graph.app) return graph;
  const id = screenId(node.app, skeletonSignature(Object.keys(node.anchors)));
  const existing = graph.nodes[id];
  if (existing === undefined) {
    return { ...graph, nodes: { ...graph.nodes, [id]: { ...node, edges: { ...node.edges } } } };
  }
  const anchors = { ...existing.anchors };
  for (const [text, count] of Object.entries(node.anchors)) anchors[text] = (anchors[text] ?? 0) + count;
  const edges = { ...existing.edges };
  for (const [key, edge] of Object.entries(node.edges)) {
    edges[key] = { ...edge, count: (edges[key]?.count ?? 0) + edge.count };
  }
  return { ...graph, nodes: { ...graph.nodes, [id]: { ...existing, anchors, edges, visits: existing.visits + node.visits } } };
}

export interface Recognition {
  id: string;
  confidence: number;
  matched: ReadonlySet<string>;
}

/**
 * Which learned page the current skeleton is, or null when nothing fits.
 * score = coverage × rarityMean: common chrome («确定», «返回») is on every
 * page, so its rarity pulls the score below the floor and the walk answers
 * "unknown" instead of guessing.
 */
export function recognize(texts: ReadonlySet<string>, nodes: readonly ScreenNode[], confidenceMin = 0.5): Recognition | null {
  if (nodes.length === 0 || texts.size === 0) return null;
  const documentFrequency = new Map<string, number>();
  for (const node of nodes) for (const anchor of Object.keys(node.anchors)) {
    documentFrequency.set(anchor, (documentFrequency.get(anchor) ?? 0) + 1);
  }
  let best: ScreenNode | null = null;
  let bestScore = -1;
  let bestMatched: ReadonlySet<string> = new Set();
  let bestOverlap = 0;
  for (const node of nodes) {
    const anchors = Object.keys(node.anchors);
    if (anchors.length === 0) continue;
    const matched = new Set(anchors.filter((anchor) => texts.has(anchor)));
    if (matched.size === 0) continue;
    const coverage = matched.size / anchors.length;
    let raritySum = 0;
    for (const anchor of matched) raritySum += 1 / Math.max(1, documentFrequency.get(anchor) ?? 1);
    const score = coverage * (raritySum / matched.size);
    if (score > bestScore || (score === bestScore && matched.size > bestOverlap)) {
      best = node;
      bestScore = score;
      bestMatched = matched;
      bestOverlap = matched.size;
    }
  }
  if (best === null || bestScore < confidenceMin) return null;
  return { id: screenId(best.app, skeletonSignature(Object.keys(best.anchors))), confidence: bestScore, matched: bestMatched };
}

/** The id of the page the current screen is, within one app's graph. */
export function recognizeScreen(screen: MapScreen, graph: ScreenGraph | null, confidenceMin = 0.5): Recognition | null {
  if (graph === null) return null;
  return recognize(new Set(skeletonTexts(screen.elements)), Object.values(graph.nodes), confidenceMin);
}

/** The shortest click path from one page to another, breadth first, edges that leave the graph excluded. */
export function pathBetween(graph: ScreenGraph, from: string, to: string): ScreenEdge[] | null {
  if (from === to) return [];
  if (graph.nodes[from] === undefined || graph.nodes[to] === undefined) return null;
  const visited = new Set([from]);
  const queue: Array<{ node: string; path: ScreenEdge[] }> = [{ node: from, path: [] }];
  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    for (const edge of Object.values(graph.nodes[node]?.edges ?? {})) {
      if (edge.to === node) continue;
      const next = [...path, edge];
      if (edge.to === to) return next;
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push({ node: edge.to, path: next });
      }
    }
  }
  return null;
}

const MAX_MAP_SCREENS = 12;
const MAX_MAP_CHARS = 1200;

/** The map as the model reads it: the page list, and the way out of the page it is on. */
export function renderMap(graph: ScreenGraph, currentId: string | null): string {
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return "";
  const labelOf = (node: ScreenNode) => Object.keys(node.anchors).sort().slice(0, 3).join("、") || node.app;
  const lines = [`Pages (${nodes.length}): ${nodes.slice(0, MAX_MAP_SCREENS).map(labelOf).join(" / ")}`];
  const current = currentId === null ? undefined : graph.nodes[currentId];
  if (current !== undefined) {
    const outs = Object.values(current.edges).filter((edge) => edge.to !== currentId);
    if (outs.length > 0) {
      lines.push("From here:");
      for (const edge of outs.slice(0, MAX_MAP_SCREENS)) {
        const to = graph.nodes[edge.to];
        lines.push(`  tap "${edge.target}" → ${to === undefined ? edge.to : labelOf(to)}`);
      }
    }
  }
  const out = lines.join("\n");
  return out.length <= MAX_MAP_CHARS ? out : out.slice(0, MAX_MAP_CHARS);
}

export const MAP_LIMITS = {
  /** Apps one owner keeps. */
  appsPerOwner: 20,
  /** Pages one app keeps. */
  nodesPerApp: 60,
};
