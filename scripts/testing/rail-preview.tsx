import { createRoot } from "react-dom/client";
import type { CloudSwatch } from "../../electron/cloud-list.mjs";
import type { AddCloudView, RailPlace, RailState } from "../../electron/cloud-rail.mjs";
import type { PlaceLook } from "../../electron/place-look.mjs";
import App from "../../src/App";
import { ChromeRail } from "../../src/components/ChromeRail";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { NOTICES } from "../../src/lib/notices";
import { setSidebarDensity, SIDEBAR_WIDTH_KEY, SIMPLE_SIDEBAR_WIDTH_KEY } from "../../src/lib/sidebar-preferences";
import { GROK_MOVE_NOTICE } from "../../src/lib/notices";
import { markSimpleModePromptSeen } from "../../src/lib/simple-mode-prompt";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

// Served only by scripts/verify-cloud-rail.ts: the real app, as a Cloud's page in the desktop window sees it, with the
// desktop bridge a hosted Cloud's page gets (its rail and add-a-Cloud sheet answered here). ?skin= picks the skin,
// ?mode=simple Simple mode, ?sheet=add|server|cloud|name|connect opens ＋'s sheet there (?adding=setting_up: a Cloud
// being bought; connect: a signed-in server's), ?places=many the list past eight (?more opens it), ?places=servers the
// person's own servers that signed in. ?look=<colour>|none is the place's colour (its tint), ?member a team's Cloud
// its member is on, ?settings=look Settings → Appearance at the place's colour, ?menu=<id> that circle's own menu (a
// right-click: its colour). ?place=computer is this computer's own page instead, on a desktop with no Cloud: no rail,
// or with ?rail one listed for it (this computer and a server connected by hand). ?density=icons collapses the sidebar
// to avatars; ?settings=general opens Settings at its first page. ?chrome opens the window's own rail over the page, as
// the desktop window does: this page behind the rail's own page in a view of its own, its places popover open at the
// top's anchor (?railpage renders that rail's page by itself, for pictures of it alone). ?update=downloading|downloaded
// an update on its way; ?team a team's Cloud its admin is on, ?teamname= the team's name. Each page starts with the
// sidebar at its own width.
const params = new URLSearchParams(location.search);
setAnalyticsEnabled(false);
setEmailGateDone("skipped");
markSimpleModePromptSeen();
localStorage.setItem(GROK_MOVE_NOTICE, "1");
try {
  for (const notice of NOTICES) localStorage.setItem(notice, "1");
  for (const width of [SIDEBAR_WIDTH_KEY, SIMPLE_SIDEBAR_WIDTH_KEY]) localStorage.removeItem(width);
} catch {}
setAdvancedMode(params.get("mode") !== "simple");
setSidebarDensity(params.get("density") === "icons" ? "icons" : "comfortable");
applySkin((params.get("skin") ?? "midnight") as SkinId);

const team = params.has("team");
const teamName = params.get("teamname") ?? "Acme team";
const place = (id: string, name: string, extra: Partial<RailPlace> = {}): RailPlace => ({ id, name, color: null, kind: "cloud", opens: true, ...extra });
const FEW: RailPlace[] = [
  place("home", "My Cloud", { color: "blue", active: true }),
  place("a", "Client A", { color: "teal" }),
  place("b", "Bakery", { color: "orange", attention: true }),
  place("acme", teamName, { kind: "team", color: "purple" }),
  place("pending:c", "Client C", { color: "red", opens: false, progress: 0.55 }),
  place("mini", "Mac mini", { kind: "server" }),
];
const SERVERS: RailPlace[] = [
  place("home", "My Cloud", { color: "blue", active: true }),
  place("a", "Client A", { color: "teal" }),
  place("acme", teamName, { kind: "team", color: "purple" }),
  place("vps", "Office", { kind: "server", server: true }),
  place("signed-in:s-mini", "Mac mini", { kind: "server", opens: false, ownNetwork: true, server: true, offline: true, lastSeenAt: Date.now() - 2 * 3_600_000 }),
  place("signed-in:s-render", "Render VPS", { kind: "server", color: "red", opens: false, pairs: true, server: true }),
];
const MANY = [...FEW, ...["Delta", "Echo Studio", "Fable", "Gamma Ltd", "Harbor"].map((name, n) => place(`x${n}`, name, { color: (["teal", "yellow", "red", "purple", "blue"] as const)[n] }))];
const member = params.has("member");
const onTeam = team || member;
const computer = params.get("place") === "computer";
const COMPUTER: RailPlace[] = [place("local", "This computer", { kind: "computer" }), place("vps", "Office", { kind: "server" })];
const SWATCH: Record<string, CloudSwatch> = { blue: "blue", teal: "green", yellow: "amber", red: "rose", purple: "violet" };
const COLOR: Record<CloudSwatch, PlaceLook["color"]> = { blue: "blue", green: "teal", amber: "yellow", rose: "red", violet: "purple", slate: null };
const tint = params.get("look") ?? (computer ? "none" : onTeam ? "purple" : "blue");
const color = tint === "none" ? null : (tint as PlaceLook["color"]);
const listed = computer ? (params.has("rail") ? COMPUTER : []) : params.get("places") === "many" ? MANY : params.get("places") === "servers" ? SERVERS : FEW;
const onScreen = computer ? "local" : onTeam ? "acme" : "home";
// The place on screen wears the colour its tint is drawn in.
// Every place but one still being made has its colour changed from its circle; a team's member only sees it.
const painted = (entry: RailPlace): RailPlace => (entry.opens || entry.server ? { ...entry, paint: { swatch: entry.color ? SWATCH[entry.color] ?? null : null,
  ...(member && entry.id === "acme" ? { locked: "member" as const } : {}) } } : entry);
const rail: RailState = { places: listed.map(({ active: _active, ...entry }) => painted(entry.id === onScreen ? { ...entry, color, active: true as const } : entry)),
  add: { cloud: true, link: true, address: computer } };
let look: PlaceLook = { name: computer ? "This computer" : onTeam ? teamName : "My Cloud", color, swatch: color ? SWATCH[color] ?? null : null,
  change: computer ? "local" : member ? null : "admin", ...(member ? { reason: "member" as const } : {}) };
let openSettings: ((section?: string) => void) | null = null;
const offer = { recommended: "pro", refundDays: 14, plans: [
  { tier: "starter", label: "Starter", amount: 1500, allowances: { cpus: 2, cpuKind: "shared" as const, memoryMb: 2048, diskGb: 10, maxDiskGb: 20, computers: 15, computerHours: 100, voiceCharacters: 30_000, sleeps: true as const } },
  { tier: "pro", label: "Pro", amount: 4900, allowances: { cpus: 4, cpuKind: "shared" as const, memoryMb: 4096, diskGb: 10, maxDiskGb: 100, computers: 15, computerHours: 300, voiceCharacters: 60_000 } },
  { tier: "max", label: "Max", amount: 9900, allowances: { cpus: 8, cpuKind: "shared" as const, memoryMb: 8192, diskGb: 10, maxDiskGb: 100, computers: 15, computerHours: 800, voiceCharacters: 180_000 } },
] };
const adding = params.get("adding") === "setting_up"
  ? { adding: { name: "Client C", color: "rose" as const, tier: "pro", startedAt: Date.now(), status: "setting_up" as const, progress: 0.55, link: true as const } } : {};
const addView: AddCloudView = { signedIn: true, hasCloud: true, supported: true, canAdd: true, offer, count: 3, home: { name: "My Cloud", color: "blue" }, ...adding };
const ok = async () => {};
const chrome = params.has("chrome");
const capabilities = async () => ({
  host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true },
  windowChrome: "mac-inset",
  screenPreview: { available: false, interaction: "none" }, dictation: { available: false, engine: "none", onDevice: false },
  localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
});
const recolor = async (id: string, swatch: CloudSwatch) => {
  rail.places = rail.places.map((entry) => (entry.id === id ? { ...entry, color: COLOR[swatch], paint: { swatch: COLOR[swatch] ? swatch : null } } : entry));
  return { outcome: "saved", look: null };
};
const cloudAdd = { state: async () => addView, start: async () => ({ outcome: "opened" }), reopen: async () => true, copyLink: async () => true, open: ok, interest: ok, sheet: ok };

const click = (selector: string) => new Promise<void>((resolve) => {
  const tick = () => { const target = document.querySelector<HTMLElement>(selector); if (target) { target.click(); resolve(); } else setTimeout(tick, 100); };
  tick();
});
/** The rail's own page, opened as asked: its ＋ or Connect sheet, the list past eight, a circle's menu. */
function driveRail() {
  const sheet = params.get("sheet");
  if (sheet === "connect") void click('[data-rail-place="signed-in:s-render"]');
  else if (sheet) void click("[data-rail-add]").then(() => (sheet === "server" ? click('[data-place-add-choice="server"]') : sheet === "add" ? undefined : click('[data-place-add-choice="cloud"]')))
    .then(() => (sheet === "name" ? click("[data-plan-buy='pro']") : undefined));
  if (params.has("more")) void click("[data-rail-more-button]");
  const menu = params.get("menu");
  if (menu) {
    const opened = () => { const circle = document.querySelector(`[data-rail-place="${menu}"]`); if (circle) circle.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); else setTimeout(opened, 100); };
    opened();
  }
}

if (params.has("railpage")) {
  // The window's own rail page: see-through but for the rail, as main.tsx draws it. ?popover=<x>,<y>: the places
  // popover open, as main told the page where its capsule sits.
  document.documentElement.style.background = document.body.style.background = "transparent";
  const at = params.get("popover")?.split(",").map(Number);
  const anchor = at?.length === 2 && at.every(Number.isFinite) ? { open: true, x: at[0]!, y: at[1]! } : { open: false, x: 0, y: 0 };
  Object.assign(window, { ogb: {
    platform: "darwin", getCapabilities: capabilities, onCapabilitiesChanged: () => () => {}, applySkin: ok,
    workspaces: { places: async () => rail, open: ok, add: ok, recolor, onChanged: () => () => {} },
    cloudAdd, rail: { expand: ok, closePopover: ok, onSkin: () => () => {}, onPopover: (heard: (info: typeof anchor) => void) => { heard(anchor); return () => {}; } },
  } });
  createRoot(document.getElementById("root")!).render(<ChromeRail />);
  driveRail();
} else {
  // The rail's own page as the desktop window shows it: its own page in a view over the window while the places popover
  // is open, see-through but for it. ?chrome opens it as main does for the capsule's click, at that anchor.
  const railPage = document.createElement("iframe");
  railPage.setAttribute("data-rail-page", "");
  railPage.title = "The window's rail";
  railPage.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:90;background:transparent;color-scheme:normal";
  let popover: { x: number; y: number } | null = null;
  const state = () => ({ available: listed.length > 1, popoverOpen: popover !== null });
  const stateHeard = new Set<(next: ReturnType<typeof state>) => void>();
  const told = () => { const next = state(); for (const heard of stateHeard) heard(next); return next; };
  const popoverAt = (anchor?: { x: number; y: number }) => ({ x: Math.round(anchor?.x ?? 64), y: Math.round(anchor?.y ?? 48) });
  const openRailPage = (anchor?: { x: number; y: number }) => {
    popover = popoverAt(anchor);
    railPage.src = `${location.pathname}?${new URLSearchParams([...params, ["railpage", "1"], ["popover", `${popover.x},${popover.y}`]])}`;
    document.body.append(railPage);
  };
  const closeRailPage = () => { popover = null; railPage.remove(); };
  const update = params.get("update");
  Object.assign(window, { ogb: {
    platform: "darwin",
    app: { version: "0.1.130", ownPage: computer },
    getCapabilities: capabilities,
    onCapabilitiesChanged: () => () => {},
    onOpenAppSettings: (callback: (section?: string) => void) => { openSettings = callback; return () => {}; },
    applySkin: ok, setUnreadCount: () => {}, permStatus: async () => ({}),
    workspaces: {
      state: async () => (computer ? { local: true, name: "This computer" }
        : onTeam ? { local: false, name: teamName, origin: "https://acme.example", color: "purple", role: "Admin" }
          : { local: false, name: "My Cloud", origin: "https://omb-u-1.fly.dev", color: "blue" }),
      menu: ok, line: async () => null, open: ok, add: ok,
      places: async () => rail,
      onChanged: () => () => {},
      look: async () => look,
      recolor,
      color: async (swatch: CloudSwatch) => { look = { ...look, swatch: COLOR[swatch] ? swatch : null, color: COLOR[swatch] }; return { outcome: "saved", look }; },
    },
    cloudAdd,
    rail: {
      state: async () => state(),
      openPopover: async (anchor?: { x: number; y: number }) => {
        if (popover !== null) closeRailPage(); else openRailPage(anchor);
        return told();
      },
      onState: (heard: (next: ReturnType<typeof state>) => void) => { stateHeard.add(heard); return () => { stateHeard.delete(heard); }; },
    },
    ...(update ? { updater: { check: ok, install: ok, onState: (heard: (state: object) => void) => {
      heard(update === "downloaded" ? { status: "downloaded", version: "0.1.136" } : { status: "downloading", percent: 45 });
      return () => {};
    } } } : {}),
  } });
  if (chrome) openRailPage();

  // The fixture server takes this browser for its owner: a team's member is signed in without the admin scope, and a
  // team's Cloud answers its people here.
  const fixtureFetch = window.fetch.bind(window);
  const answers: Record<string, () => Promise<Response>> = {
    ...(member ? { "/api/auth/session": async () => Response.json({ kind: "session", id: "member", label: "Bob's Mac", scopes: ["client"], expiresAt: Date.now() + 3_600_000 }) } : {}),
    ...(team ? {
      "/api/config": async () => Response.json({ ...await (await fixtureFetch("/api/config")).json(), team: { id: "team-acme", name: teamName } }),
      "/api/team/people": async () => Response.json({ people: [
        { email: "sam@example.com", name: "Sam", role: "owner", you: true }, { email: "ada@example.com", name: "Ada", role: "member" }, { email: "lee@example.com", name: "Lee", role: "member" },
      ] }),
    } : {}),
  };
  window.fetch = (input, init) => {
    const answer = (init?.method ?? "GET") === "GET" ? answers[new URL(input instanceof Request ? input.url : String(input), location.href).pathname] : undefined;
    return answer ? answer() : fixtureFetch(input, init);
  };

  createRoot(document.getElementById("root")!).render(<App />);

  // The macOS window's traffic lights, drawn where the system draws them (electron/window-chrome.mjs), so the picture
  // shows what sits beside them.
  {
    const lights = document.createElement("div");
    lights.setAttribute("aria-hidden", "true");
    lights.style.cssText = "position:fixed;left:16px;top:16px;display:flex;gap:9px;z-index:100;pointer-events:none";
    for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
      const dot = document.createElement("span");
      dot.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color};display:block`;
      lights.append(dot);
    }
    document.body.append(lights);
  }

  const openedSettings = () => new Promise<void>((resolve) => { const tick = () => { if (openSettings) { openSettings(); resolve(); } else setTimeout(tick, 100); }; tick(); });
  const settings = params.get("settings");
  if (settings) {
    void openedSettings().then(() => (params.get("mode") === "simple" || settings === "general" ? undefined : click('[data-settings-section="appearance"]')))
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 300)))
      .then(() => {
        if (settings === "general") return document.querySelector("[data-settings-block='appearance']")?.scrollIntoView({ block: "start" });
        const shown = document.querySelector("[data-place-look]");
        (shown?.closest("[data-sidebar-look]") ?? shown)?.scrollIntoView({ block: "center" });
      });
  }
}
