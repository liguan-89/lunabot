import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { CHROME_RAIL_PATH, createChromeRail } from "./chrome-rail.mjs";

const RAIL = "http://127.0.0.1:8799/rail";

/** The app's window: its page (the rail's state once it asked) and the views laid over it. */
function appWindow() {
  const page = Object.assign(new EventEmitter(), { mainFrame: { id: "page-frame" }, states: [], destroyed: false,
    send(channel, value) { if (channel === "rail:state") this.states.push(value); }, isDestroyed() { return this.destroyed; } });
  const children = [];
  const win = Object.assign(new EventEmitter(), { webContents: page, size: [1440, 900], destroyed: false,
    getContentSize() { return this.size; }, isDestroyed() { return this.destroyed; },
    contentView: { addChildView: (view) => children.push(view), removeChildView: (view) => children.splice(children.indexOf(view), 1) } });
  return { win, page, children };
}

function viewMaker() {
  const made = [];
  const createView = (options) => {
    const contents = Object.assign(new EventEmitter(), { mainFrame: { id: "rail-frame" }, loaded: [], sent: [], focused: 0, closed: false, opener: null,
      loadURL(url) { this.loaded.push(url); return Promise.resolve(); }, setWindowOpenHandler(handler) { this.opener = handler; },
      send(channel, ...values) { this.sent.push([channel, ...values]); }, focus() { this.focused++; }, isDestroyed() { return this.closed; }, close() { this.closed = true; } });
    const view = { options, webContents: contents, bounds: null, background: null, setBounds(bounds) { this.bounds = bounds; }, setBackgroundColor(color) { this.background = color; } };
    made.push(view);
    return view;
  };
  return { made, createView };
}

function world({ wanted = true } = {}) {
  const { win, page, children } = appWindow();
  const { made, createView } = viewMaker();
  const state = { wanted };
  const rail = createChromeRail({ createView, preload: "/app/preload.cjs", args: () => ["--omb-local-origin=http://127.0.0.1:8799", "--omb-company-desktop=1"], url: () => RAIL,
    wanted: () => state.wanted });
  const handlers = new Map();
  rail.install({ handle: (channel, handler) => handlers.set(channel, handler) });
  /** The page beside the rail asks, from its main frame. */
  const ask = (channel, ...values) => handlers.get(channel)({ sender: page, senderFrame: page.mainFrame }, ...values);
  return { rail, win, page, children, made, state, handlers, ask, settle: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("the rail's page stays out of the window until the places popover is asked for; then it covers the window", async () => {
  const w = world();
  w.rail.attach(w.win);
  await w.settle();
  assert.deepEqual([w.made.length, w.children.length], [0, 0], "nothing beside or over the page while the popover is closed");
  const opened = w.ask("rail:open-popover", { x: 96, y: 56 });
  assert.deepEqual(opened, { available: true, popoverOpen: true });
  assert.equal(w.made.length, 1);
  const [view] = w.made;
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1440, height: 900 }, "the overlay covers the window for click-outside dismissal");
  assert.equal(view.background, "#00000000", "transparent where the rail draws nothing");
  assert.deepEqual(view.webContents.loaded, [RAIL]);
  assert.deepEqual(view.options.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: "/app/preload.cjs",
    additionalArguments: ["--omb-local-origin=http://127.0.0.1:8799", "--omb-company-desktop=1"] });
  assert.deepEqual(view.webContents.sent.at(-1), ["rail:popover", { open: true, x: 96, y: 56 }]);
  w.win.size = [1000, 700];
  w.win.emit("resize");
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1000, height: 700 }, "it follows the window");
  w.handlers.get("rail:close-popover")({ sender: view.webContents, senderFrame: view.webContents.mainFrame });
  assert.deepEqual([w.rail.shown(), w.rail.popoverOpen(), w.children], [false, false, []]);
});

test("a sheet of the rail's covers the window while open, with the keyboard, and only the rail's page may say so", async () => {
  const w = world();
  const handlers = w.handlers;
  w.rail.attach(w.win);
  w.ask("rail:open-popover");
  const [view] = w.made;
  const fromRail = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
  handlers.get("rail:expand")(fromRail, true);
  assert.equal(view.webContents.focused, 2, "the popover took the keyboard, and the sheet takes it again");
  handlers.get("rail:expand")(fromRail, false);
  assert.equal(w.rail.expanded(), false);
  for (const event of [{ sender: w.page, senderFrame: w.page.mainFrame }, { sender: view.webContents, senderFrame: { id: "an-iframe" } }, {}]) {
    assert.throws(() => handlers.get("rail:expand")(event, true), /only available to the window's rail/);
  }
  assert.throws(() => handlers.get("rail:close-popover")({ sender: w.page, senderFrame: w.page.mainFrame }), /only available to the window's rail/);
  assert.equal(w.rail.owns(fromRail), true);
  assert.equal(w.rail.owns({ sender: w.page, senderFrame: w.page.mainFrame }), false, "a place's page is never the rail");
});

test("fewer than two places: no view is made, the popover can't open, and an open one closes", () => {
  const w = world({ wanted: false });
  w.rail.attach(w.win);
  w.ask("rail:open-popover");
  assert.deepEqual([w.made.length, w.children.length], [0, 0]);
  w.state.wanted = true;
  w.rail.refresh();
  w.ask("rail:open-popover");
  assert.equal(w.children.length, 1);
  w.state.wanted = false;
  w.rail.refresh();
  assert.deepEqual([w.children, w.rail.popoverOpen()], [[], false], "the popover goes with the second place");
});

test("the rail's page stays this app's rail: no other page, no new window; the window closing closes it", () => {
  const w = world();
  w.rail.attach(w.win);
  w.ask("rail:open-popover");
  const contents = w.made[0].webContents;
  for (const [target, kept] of [[RAIL, true], ["https://evil.example.test/", false], ["http://127.0.0.1:8799/", false]]) {
    let prevented = false;
    contents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, target);
    assert.equal(prevented, !kept, target);
  }
  assert.deepEqual(contents.opener({ url: "https://evil.example.test/" }), { action: "deny" });
  w.win.emit("closed");
  assert.equal(contents.closed, true);
  assert.equal(w.rail.shown(), false);
});

test("only the page beside the rail, in its main frame, asks for its state or opens the popover: never the rail's own page, a frame inside it or another window", () => {
  const w = world();
  w.rail.attach(w.win);
  w.ask("rail:open-popover");
  const [view] = w.made, other = appWindow().page;
  for (const event of [{ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { sender: w.page, senderFrame: { id: "an-iframe" } },
    { sender: other, senderFrame: other.mainFrame }, {}]) {
    assert.throws(() => w.handlers.get("rail:offer")(event), /only available to the page beside the window's rail/);
    assert.throws(() => w.handlers.get("rail:open-popover")(event), /only available to the page beside the window's rail/);
  }
});

test("the document beside the rail hears state pushes after it offered; a new document closes the popover and asks again", () => {
  const w = world();
  w.rail.attach(w.win);
  w.ask("rail:offer");
  assert.equal(w.page.states.length, 0, "what the offer answered isn't pushed again");
  w.ask("rail:open-popover", { x: 90, y: 50 });
  assert.deepEqual(w.page.states, [{ available: true, popoverOpen: true }], "the popover opening is pushed once, not twice");
  w.page.emit("did-navigate");
  assert.equal(w.rail.popoverOpen(), false);
  assert.equal(w.page.states.length, 1, "a page that never offered hears nothing");
  w.ask("rail:offer");
  assert.equal(w.page.states.length, 1, "nothing pushed while nothing changed");
});

test("an anchor that isn't coordinates opens the popover where it opens anyway", () => {
  const w = world();
  w.rail.attach(w.win);
  w.ask("rail:open-popover", "garbage");
  assert.deepEqual(w.made[0].webContents.sent.at(-1), ["rail:popover", { open: true, x: 88, y: 52 }]);
});

test("the accounts sheet holds the rail's page up, even with one place, and letting go puts it away", () => {
  const w = world({ wanted: false });
  w.rail.attach(w.win);
  assert.equal(w.rail.shown(), false);
  w.rail.holdOpen(true);
  assert.equal(w.rail.shown(), true);
  w.rail.expand(true);
  assert.equal(w.made[0].bounds.width, 1440, "the sheet has the whole window");
  w.rail.expand(false);
  w.rail.holdOpen(false);
  assert.equal(w.rail.shown(), false);
  w.state.wanted = true;
  w.ask("rail:open-popover");
  w.rail.holdOpen(true);
  w.rail.holdOpen(false);
  assert.equal(w.rail.shown(), true, "a rail there for the popover stays for it");
});

test("the rail's page that couldn't load (this app's server was restarting) loads again at the next refresh", () => {
  const w = world();
  w.rail.attach(w.win);
  w.ask("rail:open-popover");
  const contents = w.made[0].webContents, loads = () => contents.loaded.length;
  assert.equal(loads(), 1);
  w.rail.refresh();
  assert.equal(loads(), 1, "loaded or on its way: not loaded again");
  contents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:8799/rail", true);
  assert.equal(loads(), 1, "nothing retries until the server says it is ready");
  w.rail.refresh();
  assert.equal(loads(), 2, "the next refresh loads it");
  w.rail.refresh();
  assert.equal(loads(), 2, "once");
  contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://127.0.0.1:8799/rail", true);
  w.rail.refresh();
  assert.equal(loads(), 2, "a load cut short by another isn't a failure");
  contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://cdn.example.test/", false);
  w.rail.refresh();
  assert.equal(loads(), 2, "nor a frame inside it");
  contents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:8799/rail", true);
  contents.emit("did-finish-load");
  w.rail.refresh();
  assert.equal(loads(), 3, "the error page that replaced it finishing loading isn't the rail's page loading (seen in the real app)");
  contents.emit("did-finish-load");
  w.rail.refresh();
  assert.equal(loads(), 3, "and the load that worked stays");
});

test("main's own wiring: the window's rail is this app's page at /rail, wanted with two places or more", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = main.indexOf("const chromeRail = createChromeRail("), end = main.indexOf("chromeRail.install(ipcMain);", start);
  assert.ok(start >= 0 && end > start, "main makes the window's rail");
  const { made, createView } = viewMaker();
  const handlers = new Map();
  const context = vm.createContext({ createChromeRail, CHROME_RAIL_PATH, WebContentsView: function WebContentsView(options) { return createView(options); },
    path: { join: (...parts) => parts.join("/") }, __dirname: "/app", slog: () => {}, desktopCompanionRendererArguments: () => [],
    app: { isPackaged: true, getVersion: () => "0.1.133" }, desktopRemoteAccess: null, rendererOrigin: () => "http://127.0.0.1:8799", serverReady: true,
    placeSwitch: { target: () => null }, railList: () => [{ id: "local" }, { id: "home" }], ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } });
  const chromeRail = vm.runInContext(`${main.slice(start, end)}chromeRail.install(ipcMain); chromeRail`, context);
  const { win, page } = appWindow();
  chromeRail.attach(win);
  handlers.get("rail:open-popover")({ sender: page, senderFrame: page.mainFrame });
  assert.deepEqual(made.map((view) => view.webContents.loaded), [["http://127.0.0.1:8799/rail"]]);
});

/** The app's preload in a page of the window, with what the bridge needs of it. */
function pageWithPreload(origin = "https://bots.example.test", pathname = "/", answer = () => undefined) {
  const listeners = new Map(), handlers = new Map(), invoked = [];
  const head = { children: [], append(node) { this.children.push(node); node.isConnected = true; } };
  const document = { documentElement: { style: { zoom: "" } }, head, createElement: () => ({ textContent: "", isConnected: false, remove() { head.children.splice(head.children.indexOf(this), 1); this.isConnected = false; } }) };
  const frame = { zoom: 1 }, navigator = { userActivation: { isActive: false } };
  let bridge = null;
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: ["--omb-local-origin=http://127.0.0.1:8799", "--omb-company-desktop=1"] },
    location: { origin, pathname }, navigator, TextEncoder, localStorage: { getItem: () => null }, queueMicrotask, document,
    window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    require: () => ({ webUtils: {}, webFrame: { getZoomFactor: () => frame.zoom }, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on: (channel, handler) => handlers.set(channel, handler), removeListener: (channel, handler) => { if (handlers.get(channel) === handler) handlers.delete(channel); },
        send() {}, sendSync: () => null, invoke: (channel, ...values) => { invoked.push([channel, ...values]); return Promise.resolve(answer(channel, ...values)); } } }),
  });
  return { head, frame, root: document.documentElement, bridge, invoked, navigator, resize: () => listeners.get("resize")(),
    hear: (channel, ...values) => handlers.get(channel)?.({}, ...values) };
}

test("the rail's own page keeps its size at any zoom of this app's page (Chromium shares a host's zoom); no other page is touched", () => {
  const rail = pageWithPreload("http://127.0.0.1:8799", "/rail");
  rail.frame.zoom = 1.25;
  rail.resize();
  assert.equal(rail.root.style.zoom, "0.8", "zoomed in, the rail takes the zoom back out");
  rail.frame.zoom = 1;
  rail.resize();
  assert.equal(rail.root.style.zoom, "");
  for (const [origin, pathname] of [["http://127.0.0.1:8799", "/"], ["https://bots.example.test", "/rail"]]) {
    const page = pageWithPreload(origin, pathname);
    page.frame.zoom = 1.25;
    page.resize();
    assert.equal(page.root.style.zoom, "", `${origin}${pathname} keeps its zoom`);
  }
});

test("every page beside the rail, from any server, gets the button's bridge and learns only whether there is a rail; the rail's own channels stay this app's", async () => {
  const remote = pageWithPreload("https://bots.example.test", "/", (channel) => (channel === "rail:offer" ? { available: "yes", places: [{ id: "home" }] } : { available: true, popoverOpen: channel === "rail:open-popover" }));
  assert.deepEqual(Object.keys(remote.bridge.rail), ["state", "drawsFrame", "setHidden", "openPopover", "onState"]);
  /** A value made in the page's own context, as this one sees it. */
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(await remote.bridge.rail.state()), { available: false, popoverOpen: false }, "plain boolean answers only, nothing else main might send");
  await assert.rejects(remote.bridge.rail.openPopover({ x: 88, y: 52 }), /Choose to open your computers/, "a server's page opens the popover only from the person's click");
  remote.navigator.userActivation.isActive = true;
  assert.deepEqual(plain(await remote.bridge.rail.openPopover({ x: 88, y: 52 })), { available: true, popoverOpen: true });
  // Gone features keep stubs for a page of the last two releases (bridge-contract.json): answers, never channels.
  assert.deepEqual(plain(await remote.bridge.rail.setHidden(true)), { available: false, popoverOpen: false }, "the rail's state, unchanged");
  await remote.bridge.rail.drawsFrame();
  assert.deepEqual(plain(remote.invoked), [["rail:offer"], ["rail:open-popover", { x: 88, y: 52 }], ["rail:offer"]], "stubs never reach main");
  const heard = [];
  const stop = remote.bridge.rail.onState((state) => heard.push(state));
  remote.hear("rail:state", { available: true, places: ["home"] });
  stop();
  remote.hear("rail:state", { available: true, popoverOpen: true });
  assert.deepEqual(plain(heard), [{ available: true, popoverOpen: false }]);
  const local = pageWithPreload("http://127.0.0.1:8799", "/");
  assert.deepEqual(Object.keys(local.bridge.rail), ["state", "drawsFrame", "setHidden", "openPopover", "onState", "expand", "closePopover", "onPopover", "onSkin"]);
});
