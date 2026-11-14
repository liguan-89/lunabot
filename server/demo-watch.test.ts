import { describe, expect, it } from "vitest";

import { DEMO_HARVEST, DemoWatch, demoTranscript, type DemoHarvest } from "./demo-watch.ts";
import { FakeLoginPage } from "./testing/fake-login-page.ts";

const url = "https://shop.example.test/checkout";

function page(html: string) {
  return new FakeLoginPage(url, html);
}

describe("DEMO_HARVEST", () => {
  it("records clicks, typing, keys and submits, and drains on each call", async () => {
    const fake = page(`<form><input id="q" name="q"><button id="go">Go</button></form>`);
    const harvest = async () => ((await fake.engine(["eval", DEMO_HARVEST]))?.result ?? {}) as DemoHarvest;
    const { window } = fake;

    await harvest(); // installs the listeners
    const input = window.document.querySelector("#q") as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    input.value = "tea";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    (window.document.querySelector("#go") as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const first = await harvest();
    expect(first.href).toBe(url);
    expect(first.entries.map((entry) => entry.k)).toEqual(["fill", "press", "click", "submit"]);
    expect((first.entries[0] as { v: string }).v).toBe("tea");
    expect((first.entries[1] as { key: string }).key).toBe("Enter");
    expect((first.entries[2] as { t: string }).t).toContain("button#go");

    expect((await harvest()).entries).toEqual([]);
  });

  it("records the field of a secret input but never its value", async () => {
    const fake = page(`<input type="password" name="pwd"><input autocomplete="cc-number" name="num">`);
    const { window } = fake;
    await fake.engine(["eval", DEMO_HARVEST]);
    for (const selector of ["input[type=password]", "input[autocomplete=cc-number]"]) {
      const el = window.document.querySelector(selector) as unknown as { value: string; dispatchEvent(event: unknown): boolean };
      el.value = "hunter2";
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    const { entries } = ((await fake.engine(["eval", DEMO_HARVEST]))?.result ?? {}) as DemoHarvest;
    expect(entries).toEqual([
      { k: "fill", t: 'input "pwd"', s: 1, url },
      { k: "fill", t: 'input "num"', s: 1, url },
    ]);
    expect(JSON.stringify(entries)).not.toContain("hunter2");
  });
});

describe("demoTranscript", () => {
  it("opens each url once and coalesces the keystroke storm into one fill", () => {
    const outcome = demoTranscript([
      { k: "click", t: 'a "Sign in"', url },
      { k: "fill", t: 'input "q"', v: "t", url },
      { k: "fill", t: 'input "q"', v: "tea", url },
      { k: "fill", t: 'input "q"', v: "teacup", url },
      { k: "fill", t: 'input "pwd"', s: 1, url },
      { k: "press", key: "Enter", t: 'input "pwd"', url },
      { k: "click", t: 'a "Home"', url: "https://shop.example.test/home" },
    ]);
    expect(outcome.ok).toBe(true);
    const text = (outcome as { text: string }).text;
    expect(text).toContain(`1. Opened ${url}`);
    expect(text).toContain('2. Clicked a "Sign in"');
    expect(text).toContain('3. Typed "teacup" into input "q"');
    expect(text).toContain('4. Typed into input "pwd" (the value was theirs and was not recorded)');
    expect(text).toContain('5. Pressed Enter on input "pwd"');
    expect(text).toContain("6. Opened https://shop.example.test/home");
    expect(text).toContain('7. Clicked a "Home"');
  });

  it("fails politely when the person showed nothing", () => {
    expect(demoTranscript([])).toEqual({ ok: false, text: expect.stringContaining("showed nothing") });
  });
});

describe("DemoWatch", () => {
  it("opens once, harvests under a throttle, and closes into a transcript", () => {
    const watch = new DemoWatch(0);
    expect(watch.begin("s1")).toBe(true);
    expect(watch.begin("s1")).toBe(false);
    expect(watch.watching("s1")).toBe(true);
    expect(watch.due("s2")).toBe(false);

    expect(watch.due("s1")).toBe(true);
    watch.append("s1", { entries: [{ k: "click", t: "button#go", url }], href: url });
    const outcome = watch.finish("s1");
    expect(outcome.ok).toBe(true);
    expect((outcome as { text: string }).text).toContain('Clicked button#go');
    expect(watch.watching("s1")).toBe(false);
  });

  it("throttles repeat harvests inside the window", () => {
    const watch = new DemoWatch(60_000);
    watch.begin("s1");
    expect(watch.due("s1")).toBe(true);
    expect(watch.due("s1")).toBe(false);
  });

  it("folds the closing harvest into the transcript", () => {
    const watch = new DemoWatch();
    watch.begin("s1");
    const outcome = watch.finish("s1", { entries: [{ k: "submit", t: "form#order", url }] });
    expect((outcome as { text: string }).text).toContain('Submitted form#order');
  });
});
