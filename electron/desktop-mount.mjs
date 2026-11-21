export const DESKTOP_MOUNT = Object.freeze({
  width: 360,
  height: 420,
  margin: 24,
  hitTestMs: 50,
  maxInteractiveRects: 16,
});

const panels = new WeakSet();

export function isDesktopMountPanel(win) {
  return panels.has(win);
}

export function desktopMountBounds(workArea) {
  const width = DESKTOP_MOUNT.width;
  const height = DESKTOP_MOUNT.height;
  return {
    x: Math.round(workArea.x + workArea.width - width - DESKTOP_MOUNT.margin),
    y: Math.round(workArea.y + workArea.height - height - DESKTOP_MOUNT.margin),
    width,
    height,
  };
}

export function normalizeInteractiveRects(raw) {
  if (!Array.isArray(raw)) return [];
  const normalized = [];
  for (const rect of raw) {
    if (!rect || typeof rect !== "object") continue;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![x, y, width, height].every(Number.isFinite)) continue;
    if (width <= 0 || height <= 0) continue;
    const clampedX = Math.max(0, Math.min(DESKTOP_MOUNT.width, x));
    const clampedY = Math.max(0, Math.min(DESKTOP_MOUNT.height, y));
    const clampedRight = Math.max(clampedX, Math.min(DESKTOP_MOUNT.width, x + width));
    const clampedBottom = Math.max(clampedY, Math.min(DESKTOP_MOUNT.height, y + height));
    if (clampedRight <= clampedX || clampedBottom <= clampedY) continue;
    normalized.push({
      x: clampedX,
      y: clampedY,
      width: clampedRight - clampedX,
      height: clampedBottom - clampedY,
    });
    if (normalized.length >= DESKTOP_MOUNT.maxInteractiveRects) break;
  }
  return normalized;
}

export function pointInInteractiveRects(cursorPoint, windowBounds, rects) {
  if (!cursorPoint || !windowBounds || !Array.isArray(rects) || rects.length === 0) return false;
  const localX = cursorPoint.x - windowBounds.x;
  const localY = cursorPoint.y - windowBounds.y;
  if (localX < 0 || localY < 0 || localX > windowBounds.width || localY > windowBounds.height) {
    return false;
  }
  return rects.some(
    (rect) =>
      localX >= rect.x &&
      localX <= rect.x + rect.width &&
      localY >= rect.y &&
      localY <= rect.y + rect.height,
  );
}

export function clampMountPosition(x, y, workArea) {
  const minX = workArea.x;
  const maxX = Math.max(minX, workArea.x + workArea.width - DESKTOP_MOUNT.width);
  const minY = workArea.y;
  const maxY = Math.max(minY, workArea.y + workArea.height - DESKTOP_MOUNT.height);
  return {
    x: Math.round(Math.max(minX, Math.min(maxX, x))),
    y: Math.round(Math.max(minY, Math.min(maxY, y))),
  };
}

export function snapMountPosition(bounds, workArea) {
  const centerX = bounds.x + bounds.width / 2;
  const workCenterX = workArea.x + workArea.width / 2;
  const side = centerX < workCenterX ? "left" : "right";
  const targetX =
    side === "left"
      ? workArea.x + DESKTOP_MOUNT.margin
      : workArea.x + workArea.width - DESKTOP_MOUNT.width - DESKTOP_MOUNT.margin;
  const clamped = clampMountPosition(targetX, bounds.y, workArea);
  return { ...clamped, side };
}

export function createDesktopMountManager({
  BrowserWindow,
  screen,
  ipcMain,
  localOnly,
  preload,
  args = () => [],
  rendererUrl,
  captureScreen = async () => ({ ok: false, error: "Screen capture unavailable" }),
  onOpenMain = () => {},
  onStartCall = () => {},
  onState = () => {},
  log = () => {},
}) {
  let win = null;
  let botId = null;
  let interactiveRects = [];
  let hitTestTimer = null;
  let ignoringMouse = true;

  const live = (target) => Boolean(target && !target.isDestroyed());
  const currentState = () => ({ mounted: Boolean(live(win) && botId), botId: live(win) ? botId : null });

  function emitState() {
    onState(currentState());
  }

  function stopHitTest() {
    if (hitTestTimer !== null) {
      clearInterval(hitTestTimer);
      hitTestTimer = null;
    }
  }

  function updateHitTest() {
    if (!live(win)) {
      stopHitTest();
      return;
    }
    try {
      const inside = pointInInteractiveRects(
        screen.getCursorScreenPoint(),
        win.getBounds(),
        interactiveRects,
      );
      const nextIgnore = !inside;
      if (nextIgnore !== ignoringMouse) {
        ignoringMouse = nextIgnore;
        win.setIgnoreMouseEvents(nextIgnore, { forward: true });
      }
    } catch {
    }
  }

  function startHitTest() {
    stopHitTest();
    ignoringMouse = true;
    if (live(win)) {
      try { win.setIgnoreMouseEvents(true, { forward: true }); } catch {}
    }
    hitTestTimer = setInterval(updateHitTest, DESKTOP_MOUNT.hitTestMs);
    hitTestTimer.unref?.();
  }

  function createWindow(targetBotId) {
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const target = new BrowserWindow({
      ...desktopMountBounds(workArea),
      frame: false,
      transparent: true,
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      acceptFirstMouse: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload,
        additionalArguments: args(),
      },
    });
    panels.add(target);
    target.excludedFromShownWindowsMenu = true;
    target.setAlwaysOnTop(true, "screen-saver");
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    target.webContents.on("will-navigate", (event, nextUrl) => {
      try {
        const expectedOrigin = new URL(rendererUrl(targetBotId)).origin;
        if (new URL(nextUrl).origin === expectedOrigin) return;
      } catch {}
      event.preventDefault();
    });
    target.once("ready-to-show", () => {
      if (win !== target || !live(target)) return;
      target.showInactive();
      updateHitTest();
    });
    target.on("closed", () => {
      if (win !== target) return;
      win = null;
      botId = null;
      interactiveRects = [];
      stopHitTest();
      emitState();
    });
    void target.loadURL(rendererUrl(targetBotId)).catch((error) => {
      log(`desktop mount load failed: ${error?.message ?? error}`);
    });
    return target;
  }

  const manager = {
    mount(nextBotId) {
      const normalized = typeof nextBotId === "string" ? nextBotId.trim() : "";
      if (!normalized) throw new Error("Bot ID is required");
      botId = normalized;
      if (!live(win)) {
        interactiveRects = [];
        win = createWindow(normalized);
        startHitTest();
      } else {
        void win.loadURL(rendererUrl(normalized)).catch((error) => {
          log(`desktop mount reload failed: ${error?.message ?? error}`);
        });
      }
      const state = currentState();
      emitState();
      return state;
    },
    unmount() {
      const target = win;
      win = null;
      botId = null;
      interactiveRects = [];
      stopHitTest();
      if (live(target)) target.destroy();
      const state = { mounted: false, botId: null };
      emitState();
      return state;
    },
    close() {
      const target = win;
      win = null;
      botId = null;
      interactiveRects = [];
      stopHitTest();
      if (live(target)) target.destroy();
    },
    state() {
      return currentState();
    },
    owns(event) {
      return Boolean(live(win) && event?.sender === win.webContents);
    },
    setInteractiveRects(rects) {
      interactiveRects = normalizeInteractiveRects(rects);
      updateHitTest();
    },
    openMain(targetBotId) {
      onOpenMain(typeof targetBotId === "string" && targetBotId.trim() ? targetBotId.trim() : botId);
      return true;
    },
    startCall(targetBotId) {
      onStartCall(typeof targetBotId === "string" && targetBotId.trim() ? targetBotId.trim() : botId);
      return true;
    },
    move(dx, dy) {
      if (!live(win)) return null;
      const deltaX = Number(dx);
      const deltaY = Number(dy);
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
      const bounds = win.getBounds();
      const nextX = bounds.x + deltaX;
      const nextY = bounds.y + deltaY;
      const center = { x: Math.round(nextX + bounds.width / 2), y: Math.round(nextY + bounds.height / 2) };
      const workArea = screen.getDisplayNearestPoint(center).workArea;
      const clamped = clampMountPosition(nextX, nextY, workArea);
      win.setPosition(clamped.x, clamped.y);
      return clamped;
    },
    snap() {
      if (!live(win)) return null;
      const bounds = win.getBounds();
      const center = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
      const workArea = screen.getDisplayNearestPoint(center).workArea;
      const snapped = snapMountPosition(bounds, workArea);
      win.setPosition(snapped.x, snapped.y);
      return snapped;
    },
    async capture() {
      const target = win;
      const wasVisible = Boolean(live(target) && target.isVisible());
      if (wasVisible) target.hide();
      try {
        if (wasVisible) await new Promise((resolve) => setTimeout(resolve, 90));
        return await captureScreen();
      } finally {
        if (wasVisible && live(target)) {
          target.showInactive();
          updateHitTest();
        }
      }
    },
  };
  ipcMain.handle("desktop-mount:mount", localOnly("desktop-mount:mount", (_event, botId) => manager.mount(botId)));
  ipcMain.handle("desktop-mount:unmount", localOnly("desktop-mount:unmount", () => manager.unmount()));
  ipcMain.handle("desktop-mount:state", localOnly("desktop-mount:state", () => manager.state()));
  ipcMain.handle("desktop-mount:open-main", localOnly("desktop-mount:open-main", (_event, botId) => manager.openMain(botId)));
  ipcMain.handle("desktop-mount:start-call", localOnly("desktop-mount:start-call", (_event, botId) => manager.startCall(botId)));
  ipcMain.handle("desktop-mount:move", localOnly("desktop-mount:move", (event, dx, dy) => {
    if (!manager.owns(event)) return null;
    return manager.move(dx, dy);
  }));
  ipcMain.handle("desktop-mount:snap", localOnly("desktop-mount:snap", (event) => {
    if (!manager.owns(event)) return null;
    return manager.snap();
  }));
  ipcMain.handle("desktop-mount:capture-screen", localOnly("desktop-mount:capture-screen", (event) => {
    if (!manager.owns(event)) return { ok: false, error: "Unauthorized" };
    return manager.capture();
  }));
  ipcMain.on("desktop-mount:interactive-rects", (event, rects) => {
    if (manager.owns(event)) manager.setInteractiveRects(rects);
  });
  return manager;
}
