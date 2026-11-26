// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  pairingOpen: vi.fn(),
  pairingClose: vi.fn(),
  route: vi.fn(),
  answer: vi.fn(),
  enqueued: [] as Array<(requests: Array<{ id: string; deviceName: string; createdAt: number; expiresAt: number }>) => void>,
}));

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/lib/companion-bridge", () => ({
  companionBridge: () => ({
    pairing: (open: boolean, token?: string) => open ? fakes.pairingOpen() : fakes.pairingClose(token),
  }),
}));
vi.mock("@/lib/companion-pairing", () => ({
  companionPairingRoute: (...args: unknown[]) => fakes.route(...args),
}));

const { PairRequestCard } = await import("./PairRequestCard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const token = `omb_pair_${"a".repeat(43)}`;
const request = { id: "req-1", deviceName: "Pixel", createdAt: Date.now(), expiresAt: Date.now() + 300_000 };

function bridge() {
  return {
    onPairRequest: (listener: (requests: typeof request[]) => void) => {
      fakes.enqueued.push(listener as (typeof fakes.enqueued)[number]);
      return () => {};
    },
    pairRequests: async () => [request],
    answerPairRequest: (...args: unknown[]) => fakes.answer(...args),
  };
}

let root: Root;
let host: HTMLElement;

beforeEach(async () => {
  vi.clearAllMocks();
  fakes.enqueued.length = 0;
  (window as unknown as { ogb?: unknown }).ogb = { companionAccount: bridge() };
  fakes.pairingOpen.mockResolvedValue({ pairing: { token }, e2e: null });
  fakes.pairingClose.mockResolvedValue(null);
  fakes.route.mockReturnValue({ address: "192.168.1.20", port: 8810 });
  fakes.answer.mockRejectedValue(new Error("gone"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(PairRequestCard)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  (window as unknown as { ogb?: unknown }).ogb = undefined;
});

const card = () => document.querySelector<HTMLElement>("[data-pair-request-card]")!;
const allowButton = () => [...card().querySelectorAll("button")].find((b) => b.textContent === "pairRequest.allow")!;

it("closes the window it opened when Allow cannot finish", async () => {
  await act(async () => {});
  expect(card()).not.toBeNull();
  await act(async () => {
    allowButton().click();
  });
  expect(fakes.answer).toHaveBeenCalledWith("req-1", "allow", expect.stringContaining("lunabot://pair?"));
  await vi.waitFor(() => expect(fakes.pairingClose).toHaveBeenCalledWith(token));
  expect(card().querySelector('[role="alert"]')).not.toBeNull();
});

it("a denial never opens a pairing window", async () => {
  await act(async () => {});
  fakes.answer.mockResolvedValue("ok");
  const deny = [...card().querySelectorAll("button")].find((b) => b.textContent === "pairRequest.deny")!;
  await act(async () => {
    deny.click();
  });
  expect(fakes.pairingOpen).not.toHaveBeenCalled();
});
