import assert from "node:assert/strict";
import test from "node:test";

import { createPairRequestNotice, watchPairRequests } from "./companion-pair-watch.mjs";

/** A Notification stand-in that records what was raised and lets a test click it. */
function fakeNotifications() {
  const shown = [];
  class FakeNotification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; this.handlers = {}; shown.push(this); }
    on(event, handler) { this.handlers[event] = handler; return this; }
    show() { this.visible = true; }
  }
  return { Notification: FakeNotification, shown };
}

const request = (id, deviceName) => ({ id, deviceName, createdAt: 1, expiresAt: 2 });

test("a request is announced by the system when the window is not in front", () => {
  const { Notification, shown } = fakeNotifications();
  const focused = [];
  const notice = createPairRequestNotice({
    Notification,
    t: (key, params) => (params ? `${key}:${params.device}` : key),
    reveal: () => focused.push(true),
  });

  notice(request("r1", "OnePlus"));

  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.title, "native.pairRequest.title");
  assert.equal(shown[0].options.body, "native.pairRequest.body:OnePlus");
  shown[0].handlers.click();
  assert.deepEqual(focused, [true], "a click brings the window forward, where the card waits");
});

test("a request without a device name still says something", () => {
  const { Notification, shown } = fakeNotifications();
  const notice = createPairRequestNotice({ Notification, t: (key) => key, reveal: () => {} });

  notice(request("r2", "   "));

  assert.equal(shown[0].options.body, "native.pairRequest.bodyNoDevice");
});

test("a platform without notifications is not an error", () => {
  const notice = createPairRequestNotice({
    Notification: class { static isSupported() { return false; } },
    t: (key) => key,
    reveal: () => { throw new Error("nothing was shown, so nothing may be opened"); },
  });

  assert.equal(notice(request("r3", "iPad")), false);
});

test("the poll delivers a request once, and only announces it while the window is behind", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const delivered = [];
  const announced = [];
  const window = { isDestroyed: () => false, webContents: { send: (channel, payload) => delivered.push([channel, payload]) } };
  const pending = [request("r1", "OnePlus")];
  let focused = false;

  const watch = watchPairRequests(() => Promise.resolve(pending), () => window, {
    notify: (one) => announced.push(one.id),
    focused: () => focused,
  });

  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered.map(([, payload]) => payload.map((one) => one.id)), [["r1"]]);
  assert.deepEqual(announced, ["r1"], "the window is behind, so the system speaks");

  // The same request on the next tick is not delivered or announced twice.
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(announced.length, 1);

  // A new request while the window is in front is drawn by the page alone.
  focused = true;
  pending.push(request("r2", "iPad"));
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered.at(-1)[1].map((one) => one.id), ["r2"]);
  assert.deepEqual(announced, ["r1"]);

  watch.stop();
});

test("a control plane that is briefly unreachable is skipped, not thrown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const window = { isDestroyed: () => false, webContents: { send: () => { throw new Error("nothing should be sent"); } } };
  const watch = watchPairRequests(() => Promise.reject(new Error("offline")), () => window, {});

  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  watch.stop();
});
