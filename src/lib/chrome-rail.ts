import { useEffect, useState } from "react";
import type { ChromeRailPopover, ChromeRailState } from "../../electron/chrome-rail.mjs";

let current: ChromeRailState | null = null;
let started = false;
const listeners = new Set<(state: ChromeRailState | null) => void>();

const bridge = () => (typeof window === "undefined" ? undefined : window.ogb?.rail);

function publish(next: ChromeRailState | null) {
  current = next;
  for (const listener of listeners) listener(current);
}

function start() {
  const rail = bridge();
  if (started || !rail?.state) return;
  started = true;
  rail.onState?.(publish);
  void rail.state().then(publish, () => publish(null));
}

/** The window's own rail of places, as the page beside it knows it: null in a browser, on an older app or on a page that
 * isn't beside it. Asking offers this page's button that opens its isolated popover. */
export function useChromeRail(): ChromeRailState | null {
  const [state, setState] = useState(current);
  useEffect(() => {
    listeners.add(setState);
    start();
    setState(current);
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}

/** On the rail's own page: whether the isolated places popover is currently open and where its trigger capsule sits. */
export function useChromeRailPopover(): ChromeRailPopover {
  const [popover, setPopover] = useState<ChromeRailPopover>({ open: false, x: 0, y: 0 });
  useEffect(() => bridge()?.onPopover?.(setPopover), []);
  return popover;
}

/** From the person's click on the top capsule switcher: opens or toggles the isolated places popover in the rail view. */
export function openChromeRailPopover(anchor?: { x: number; y: number }): void {
  const rail = bridge(), before = current;
  if (!rail?.openPopover || !before) return;
  publish({ ...before, popoverOpen: !before.popoverOpen });
  void rail.openPopover(anchor).then(publish, () => publish(before));
}

/** On the rail's own page: dismisses the isolated places popover and returns focus to the page beside it. */
export function closeChromeRailPopover(): void {
  void bridge()?.closePopover?.()?.catch(() => {});
}
