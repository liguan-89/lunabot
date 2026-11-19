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
 */
const POLL_MS = 10_000;

/**
 * @param {() => Promise<Array<{ id: string }>>} listRequests the service's own
 *   `pairRequests`, already authenticated by the caller.
 * @param {() => any} currentWindow the window to deliver to, read on every tick
 *   so a window that closed and reopened is not skipped.
 * @returns {{ stop: () => void }} the handle a shutdown path can clear.
 */
export function watchPairRequests(listRequests, currentWindow) {
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
