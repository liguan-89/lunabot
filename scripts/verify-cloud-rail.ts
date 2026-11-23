// The rail of Clouds and its ＋ sheet in the real app, as a Cloud's page in the desktop window shows them, against a
// disposable fake-engine server; the desktop bridge's rail and add-a-Cloud answers are the preview's own fixtures.
// Run: node --experimental-strip-types scripts/verify-cloud-rail.ts [--shots <dir> [--only <view,view>] [--size <width>x<height>]]
// With --shots it photographs each view in a light and a dark skin with a headless Chrome in a throwaway profile
// (LUNABOT_CDP_CHROME, else the installed Google Chrome) at twice the window's size (1280x800 unless --size says) and
// exits; without, it prints the preview's address and waits. With --shots it also checks that the sidebar's button for
// the window's rail lands on the same spot with its popover open and closed, and fails if it doesn't.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { openHeadlessChrome } from "./testing/headless-chrome.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const at = process.argv.indexOf("--shots");
const shots = at === -1 ? null : resolve(process.argv[at + 1] ?? "");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? null : new Set((process.argv[onlyAt + 1] ?? "").split(",").filter(Boolean));
const sizeAt = process.argv.indexOf("--size");
const size = /^(\d{3,4})x(\d{3,4})$/.exec(sizeAt === -1 ? "1280x800" : process.argv[sizeAt + 1] ?? "");
if (!size) throw new Error("--size takes the window's width and height, such as 1338x870");
const [WIDTH, HEIGHT] = [Number(size[1]), Number(size[2])];
/** Each view: its query, what must be on screen before the picture, and the window's height. Views that name the same
 * `button` spot must have the rail's button at the same place. `railpage=` pictures the window's own rail by itself. */
const VIEWS: Array<{ name: string; query: string; ready: string; height?: number; button?: string }> = [
  { name: "rail", query: "", ready: "[data-rail-toggle]", button: "advanced" },
  { name: "rail-simple", query: "mode=simple", ready: "[data-rail-toggle]", button: "simple" },
  { name: "rail-icons", query: "density=icons", ready: "[data-rail-toggle]" },
  { name: "rail-icons-simple", query: "mode=simple&density=icons", ready: "[data-rail-toggle]" },
  { name: "rail-popover", query: "chrome=1", ready: "[data-rail-page]" },
  { name: "rail-popover-simple", query: "mode=simple&chrome=1", ready: "[data-rail-page]" },
  { name: "general-settings-simple", query: "mode=simple&settings=general", ready: "[data-settings-block='appearance']" },
  { name: "rail-many", query: "railpage=1&places=many&more=1", ready: "[data-rail-more] li" },
  { name: "add-sheet", query: "railpage=1&sheet=add", ready: "[data-place-add='choose']" },
  { name: "add-own-server", query: "railpage=1&sheet=server", ready: "[data-place-add='own-server']" },
  { name: "add-buy-cloud", query: "railpage=1&sheet=cloud", ready: "[data-plan-buy]", height: 900 },
  { name: "add-name-colour", query: "railpage=1&sheet=name", ready: "[data-cloud-add='extra-name']" },
  { name: "add-setting-up", query: "railpage=1&sheet=cloud&adding=setting_up", ready: "[data-cloud-add='extra-starting']" },
  { name: "rail-servers", query: "railpage=1&places=servers&look=teal", ready: "[data-rail-server]" },
  { name: "connect-server", query: "railpage=1&places=servers&sheet=connect", ready: "[data-place-add='connect-server']" },
  { name: "look-settings", query: "look=teal&settings=look", ready: "[data-place-look='admin']" },
  { name: "look-settings-simple", query: "look=teal&mode=simple&settings=look", ready: "[data-place-look='admin']" },
  { name: "look-member", query: "member=1&settings=look", ready: "[data-place-look='locked']" },
  { name: "look-member-simple", query: "member=1&mode=simple&settings=look", ready: "[data-place-look='locked']" },
  { name: "rail-colour", query: "railpage=1&places=servers&look=teal&menu=vps", ready: "[data-rail-menu='vps']" },
  { name: "rail-colour-member", query: "railpage=1&member=1&menu=acme", ready: "[data-rail-menu-note]" },
  // This computer's own page on a desktop with no Cloud: plain, in a colour, its Settings, and the rail's own page.
  { name: "computer", query: "place=computer", ready: "[data-sidebar-top-row]" },
  { name: "computer-simple", query: "place=computer&mode=simple", ready: "[data-sidebar-top-row]" },
  { name: "computer-colour", query: "place=computer&look=teal", ready: "[data-place-tint]" },
  { name: "computer-colour-simple", query: "place=computer&look=teal&mode=simple", ready: "[data-place-tint]" },
  { name: "computer-settings", query: "place=computer&settings=look", ready: "[data-place-look='local']" },
  { name: "computer-settings-simple", query: "place=computer&mode=simple&settings=look", ready: "[data-place-look='local']" },
  { name: "computer-colour-settings", query: "place=computer&look=teal&settings=look", ready: "[data-place-look='local'] [aria-checked='true']" },
  { name: "computer-colour-settings-simple", query: "place=computer&look=teal&mode=simple&settings=look", ready: "[data-place-look='local'] [aria-checked='true']" },
  { name: "computer-rail", query: "railpage=1&place=computer&look=teal&rail=1", ready: "[data-rail-place='local']" },
  { name: "computer-rail-colour", query: "railpage=1&place=computer&look=teal&rail=1&menu=local", ready: "[data-rail-menu='local']" },
];
const SKINS = [{ id: "daylight", look: "light" }, { id: "midnight", look: "dark" }];

/** The preview in a headless Chrome: navigate, wait for a selector, photograph. */
async function openChrome(profile: string) {
  const page = await openHeadlessChrome(profile);
  return {
    /** Photographs the page once `ready` shows, and answers where the rail's button is (null without one). */
    async shoot(url: string, ready: string, file: string, height = HEIGHT): Promise<{ left: number; top: number } | null> {
      await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: 2, mobile: false });
      await page.send("Page.navigate", { url });
      await page.until(`document.querySelector(${JSON.stringify(ready)}) && document.querySelector("[data-sidebar-bot-row], [data-sidebar-hero]")`);
      await delay(900);
      writeFileSync(file, await page.capture());
      return await page.evaluate("(() => { const box = document.querySelector('[data-rail-toggle]')?.getBoundingClientRect(); return box ? { left: box.left, top: box.top } : null; })()");
    },
    close: page.close,
  };
}

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  for (const name of ["Chief of Staff", "Research", "Inbox"]) await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  ui = await mountPreview(fixture, { entry: "/scripts/testing/rail-preview.tsx", route: "/__cloud-rail.html", title: "Isolated rail of Clouds", logLevel: "warn" });
  if (!shots) {
    console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
    await parkUntilSignal();
  } else {
    mkdirSync(shots, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "omb-rail-chrome-"));
    const chrome = await openChrome(profile);
    try {
      const spots = new Map<string, Array<{ view: string; at: { left: number; top: number } | null }>>();
      for (const view of VIEWS.filter((entry) => !only || only.has(entry.name))) for (const skin of SKINS) {
        const file = join(shots, `${view.name}-${skin.look}.png`);
        const at = await chrome.shoot(`${ui.previewUrl}?skin=${skin.id}${view.query ? `&${view.query}` : ""}`, view.ready, file, view.height);
        if (view.button) spots.set(view.button, [...spots.get(view.button) ?? [], { view: `${view.name}-${skin.look}`, at }]);
        console.log(file);
      }
      for (const [spot, seen] of spots) {
        console.log(JSON.stringify({ button: spot, at: seen }));
        if (seen.some(({ at }) => !at || at.left !== seen[0]!.at?.left || at.top !== seen[0]!.at?.top)) throw new Error(`the rail's button moved (${spot})`);
      }
    } finally {
      chrome.close();
      await delay(500);
      rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  await ui?.close();
  await fixture.close();
}
