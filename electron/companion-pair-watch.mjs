/**
 * The phone-asks-a-computer loop's delivery half: a cheap poll that turns the
 * control plane's open pair requests into renderer events.
 *
 * `main.mjs` is at its line ratchet and may only shrink, and this is a
 * self-contained piece of behaviour with two inputs (a service that lists
 * requests, a window to send them to), so it lives here rather than inline.
 *
 * The poll is one authenticated GET every ten seconds and only runs while a
 * window exists. A request already shown is not re-sent, so a slow tap cannot
 * stack two cards for the same ask.
 *
 * A request is also worth a system notification. The card lives in the page, so
 * a minimised, hidden or covered window shows nothing at all — and the person
 * being asked is by definition not looking at this app. The notification only
 * goes out when the window is not focused, so a visible card is not doubled.
 */
const POLL_MS = 10_000;

/**
 * @param {() => Promise<Array<{ id: string, deviceName?: string }>>} listRequests
 *   the service's own `pairRequests`, already authenticated by the caller.
 * @param {() => any} currentWindow the window to deliver to, read on every tick
 *   so a window that closed and reopened is not skipped.
 * @param {{ notify?: (request: { id: string, deviceName?: string }) => void,
 *   focused?: () => boolean }} [deps] `focused`: false while the window is
 *   behind, minimised or hidden. `notify`: raises the system notification.
 * @returns {{ stop: () => void }} the handle a shutdown path can clear.
 */
export function watchPairRequests(listRequests, currentWindow, { notify = () => {}, focused = () => true } = {}) {
  let shown = new Set();
  let timer = null;

  const tick = async () => {
    const window = currentWindow();
    if (!window || window.isDestroyed()) return;
    let requests;
    try {
      requests = await listRequests();
    } catch {
      // A control plane that is briefly unreachable is not an error worth
      // surfacing: the next tick asks again.
      return;
    }
    const fresh = requests.filter((request) => !shown.has(request.id));
    if (fresh.length === 0) return;
    // Forget ids the server no longer lists, so a request id that comes back
    // later is delivered again rather than swallowed by this set.
    const live = new Set(requests.map((request) => request.id));
    for (const id of shown) if (!live.has(id)) shown.delete(id);
    for (const request of fresh) shown.add(request.id);
    window.webContents.send("companion-account:pair-request", fresh);
    if (!focused()) for (const request of fresh) notify(request);
  };

  timer = setInterval(tick, POLL_MS);
  timer.unref?.();

  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      shown = new Set();
    },
  };
}

/**
 * "A phone wants to connect", raised by the system rather than drawn in a page.
 *
 * The card can only speak to someone already looking at this window, and the
 * person who has to tap Allow is by definition somewhere else. A click brings
 * the window forward, where the card is waiting.
 */
export function createPairRequestNotice({ Notification, t, reveal }) {
  return (request) => {
    if (!Notification.isSupported()) return false;
    const device = typeof request?.deviceName === "string" && request.deviceName.trim() ? request.deviceName.trim() : "";
    const note = new Notification({
      title: t("native.pairRequest.title"),
      body: device ? t("native.pairRequest.body", { device }) : t("native.pairRequest.bodyNoDevice"),
    });
    note.on("click", () => reveal());
    note.show();
    return true;
  };
}
