import { describe, expect, it } from "vitest";

import { windowBackground, windowChromeOptions } from "./window-chrome.mjs";

describe("window chrome", () => {
  it("uses inset traffic lights on macOS", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    });
  });

  it("keeps the system's own title bar on Windows and Linux", () => {
    expect(windowChromeOptions("win32")).toEqual({});
    expect(windowChromeOptions("linux")).toEqual({});
  });

  it("paints the light or dark canvas before the renderer loads", () => {
    expect(windowBackground(true)).toBe("#121212");
    expect(windowBackground(false)).toBe("#fcfcfc");
  });
});
