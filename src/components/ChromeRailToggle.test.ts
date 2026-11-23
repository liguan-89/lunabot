// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChromeRailBridge, ChromeRailState } from "../../electron/chrome-rail.mjs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); vi.resetModules(); });

/** Main's side of the bridge: its answer to the page's offer and to a click on the capsule. */
function bridge(answer: ChromeRailState | Error) {
  let push: (state: ChromeRailState) => void = () => {};
  const rail = {
    state: vi.fn(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer))),
    openPopover: vi.fn((_anchor?: { x: number; y: number }) => Promise.resolve({ available: true, popoverOpen: true })),
    onState: vi.fn((callback: (state: ChromeRailState) => void) => { push = callback; return () => {}; }),
  };
  return { rail, push: (state: ChromeRailState) => act(async () => push(state)) };
}

async function page(rail: ChromeRailBridge | undefined) {
  vi.resetModules();
  Object.assign(window, { ogb: rail ? { rail } : undefined });
  const { setLocale } = await import("@/lib/i18n");
  setLocale("en");
  const { ChromeRailToggle } = await import("./ChromeRailToggle");
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(ChromeRailToggle, { advanced: true }));
  });
  await act(async () => { await Promise.resolve(); });
}
const button = () => host.querySelector<HTMLButtonElement>("[data-rail-toggle]");
const said = () => [button()?.getAttribute("aria-label"), button()?.getAttribute("aria-haspopup"), button()?.getAttribute("aria-expanded")];
const click = async (target: HTMLElement | null) => {
  expect(target).toBeTruthy();
  await act(async () => { target!.click(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};

it("once main says this window has a rail, the capsule asks main to open the places popover beside it", async () => {
  const { rail } = bridge({ available: true, popoverOpen: false });
  await page(rail);
  expect(rail.state, "one offer from the page, whatever asks").toHaveBeenCalledTimes(1);
  expect(said()).toEqual(["Show your computers", "dialog", "false"]);
  await click(button());
  expect(rail.openPopover).toHaveBeenCalledTimes(1);
  const anchor = rail.openPopover.mock.calls[0]![0]!;
  expect(typeof anchor.x).toBe("number");
  expect(typeof anchor.y).toBe("number");
  expect(said()).toEqual(["Show your computers", "dialog", "true"]);
});

it("a second click while the popover is open asks main again; main's push is what the capsule shows", async () => {
  const { rail, push } = bridge({ available: true, popoverOpen: false });
  await page(rail);
  await click(button());
  expect(said()[2]).toBe("true");
  await click(button());
  expect(rail.openPopover).toHaveBeenCalledTimes(2);
  await push({ available: true, popoverOpen: false });
  expect(said()[2]).toBe("false");
});

it("is nowhere without a rail whose popover could open: one place, a browser, an older app, or an offer that failed", async () => {
  await page(undefined);
  expect(button()).toBeNull();
  await page(bridge({ available: false, popoverOpen: false }).rail);
  expect(button()).toBeNull();
  await page(bridge(new Error("no main")).rail);
  expect(button()).toBeNull();
});
