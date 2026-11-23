// The rail of places as the window's own chrome: this app's small page in a view of its own that covers the window
// while a sheet of it is open (the places popover, ＋, the person's accounts), transparent but for the sheet, and goes
// away when it closes. Every place gets it, whatever that server runs, and no place's page ever reads the list of
// places: the rail's page is this app's own, and only main switches places.
//
// The page beside it offers the button that opens the places popover; asking for the rail's state is the offer, made
// again by each document.

export const CHROME_RAIL_PATH = "/rail";

/** Chromium's net::ERR_ABORTED: a load replaced by another, not a page that failed. */
const ABORTED = -3;

/**
 * @param {{
 *   createView: (options: object) => any,
 *   preload: string,
 *   args: () => string[],
 *   url: () => string,
 *   wanted: () => boolean,
 *   log?: (line: string) => void,
 * }} deps `url()`: the rail's page on this app's own server; `wanted()`: whether the window has two places or more to
 * show it for (railPlaces); `args()`: the preload's arguments, as the window's own page gets them.
 */
export function createChromeRail({ createView, preload, args, url, wanted, log = () => {} }) {
  let view = null, win = null, shown = false, expanded = false, held = false;
  /** Anchor coordinates when the places popover is open over the window (null when closed). */
  let popover = null;
  // The rail's page didn't load (this app's server was restarting): it loads again at the next refresh, or it stays blank.
  let unloaded = false;
  // The document beside the rail offered its button; it hears `rail:state` once it differs from the last it was told.
  let offered = false, told = "";
  const alive = () => Boolean(win && !win.isDestroyed());
  const sanitizeAnchor = (anchor) => {
    if (!anchor || typeof anchor !== "object") return { x: 88, y: 52 };
    const x = Number.isFinite(Number(anchor.x)) ? Math.max(0, Math.min(4000, Math.round(Number(anchor.x)))) : 88;
    const y = Number.isFinite(Number(anchor.y)) ? Math.max(0, Math.min(4000, Math.round(Number(anchor.y)))) : 52;
    return { x, y };
  };
  const layout = () => {
    if (!view || !shown || !alive()) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  const page = () => (alive() && !win.webContents.isDestroyed() ? win.webContents : null);
  const pageState = () => ({ available: alive() && wanted(), popoverOpen: popover !== null });
  /** The document that offered the button hears when it would change. */
  const tellState = () => {
    const state = pageState(), key = JSON.stringify(state);
    if (!offered || key === told) return;
    told = key;
    page()?.send("rail:state", state);
  };
  const sendPopover = () => {
    rail.send("rail:popover", popover ? { open: true, x: popover.x, y: popover.y } : { open: false, x: 0, y: 0 });
  };
  /** The page beside the rail has another document, or lost the one it had. */
  const nextDocument = () => {
    offered = false; told = ""; popover = null;
    rail.refresh();
  };
  /** The page beside the rail asks: the window's own page, in its main frame (never a frame inside it). */
  const pageBeside = (event) => Boolean(page() && event?.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  const load = (contents) => { void contents.loadURL(url()).catch((error) => log(`chrome rail: ${error?.message ?? error}`)); };
  const ensureView = () => {
    if (view) return view;
    view = createView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload, additionalArguments: args() } });
    view.setBackgroundColor?.("#00000000");
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const stay = (event, target) => { if (target !== url()) event.preventDefault(); };
    contents.on("will-navigate", stay);
    contents.on("will-redirect", stay);
    contents.on("render-process-gone", () => { log("chrome rail: its page went away; loading it again"); void contents.loadURL(url()).catch(() => {}); });
    contents.on("did-finish-load", () => {
      if (popover) contents.send("rail:popover", { open: true, x: popover.x, y: popover.y });
    });
    // Only a load's failing says so: the error page that replaces it finishes loading too.
    contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== ABORTED) unloaded = true; });
    load(contents);
    return view;
  };
  const rail = {
    /** The window the rail stands beside: its size moves the rail. */
    attach(next) {
      win = next;
      shown = false; expanded = false; held = false; popover = null; offered = false; told = "";
      win.on("resize", layout);
      const contents = win.webContents;
      contents.on("did-navigate", nextDocument);
      contents.on("render-process-gone", nextDocument);
      // Electron 43 reports an error page that replaced the document here, not as did-navigate.
      contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== ABORTED) nextDocument(); });
      win.once("closed", () => {
        if (view && !view.webContents.isDestroyed()) view.webContents.close?.({ waitForBeforeUnload: false });
        view = null; win = null; shown = false; expanded = false; popover = null; offered = false;
      });
      rail.refresh();
    },
    /** Shown while the places popover or a sheet it holds open is up, and there are two places or more to show it for. */
    refresh() {
      const hasPlaces = alive() && wanted();
      if (!hasPlaces) popover = null;
      const on = (hasPlaces && popover !== null) || (alive() && held);
      if (view && unloaded && on) { unloaded = false; load(view.webContents); }
      if (on === shown) {
        layout();
      } else {
        shown = on;
        if (on) {
          win.contentView.addChildView(ensureView());
          layout();
        } else {
          expanded = false;
          if (view) win.contentView.removeChildView(view);
        }
      }
      tellState();
    },
    /** A sheet the rail's page shows for the page beside it (the person's accounts): the rail's page is up meanwhile. */
    holdOpen(on) {
      held = on === true;
      rail.refresh();
    },
    /** A sheet of the rail's is open: the keyboard goes with it, and back to the page once it closes. */
    expand(on) {
      const was = expanded;
      expanded = on === true && shown;
      // The keyboard goes with the sheet, and back to the page once it closes.
      if (expanded) view?.webContents.focus();
      else if (was) page()?.focus?.();
    },
    /** Opens or toggles the isolated places popover anchored to the top capsule switcher. */
    openPopover(anchor) {
      if (!alive() || !wanted()) return;
      if (popover !== null) {
        rail.closePopover();
        return;
      }
      popover = sanitizeAnchor(anchor);
      rail.refresh();
      sendPopover();
      view?.webContents.focus();
    },
    closePopover() {
      if (popover === null) return;
      popover = null;
      sendPopover();
      rail.refresh();
      page()?.focus?.();
    },
    /** The rail's own page asks (never a place's page). */
    owns: (event) => Boolean(view && event?.sender === view.webContents && event.senderFrame === view.webContents.mainFrame),
    shown: () => shown,
    expanded: () => expanded,
    popoverOpen: () => popover !== null,
    /** The page beside it offers the button that opens the places popover; asking is the offer, made again by each
     * document. */
    install(ipcMain) {
      ipcMain.handle("rail:expand", (event, on) => {
        if (!rail.owns(event)) throw new Error("rail:expand is only available to the window's rail");
        rail.expand(on === true);
      });
      ipcMain.handle("rail:close-popover", (event) => {
        if (!rail.owns(event)) throw new Error("rail:close-popover is only available to the window's rail");
        rail.closePopover();
      });
      // Security: the page beside the rail learns only whether there is one to open, never the places on it.
      const fromPage = (channel, act) => ipcMain.handle(channel, (event, ...values) => {
        if (!pageBeside(event)) throw new Error(`${channel} is only available to the page beside the window's rail`);
        offered = true;
        act(...values);
        const state = pageState();
        told = JSON.stringify(state);
        rail.refresh();
        return state;
      });
      fromPage("rail:offer", () => {});
      fromPage("rail:open-popover", (anchor) => rail.openPopover(anchor));
    },
    /** Tells the rail's page something (the places changed, the skin of the page beside it). */
    send(channel, ...values) {
      if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, ...values);
    },
  };
  return rail;
}
