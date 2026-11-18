// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
// @ts-expect-error -- untyped ESM module in electron/
import { DESKTOP_MOUNT, desktopMountBounds, normalizeInteractiveRects, pointInInteractiveRects } from "../../electron/desktop-mount.mjs";
import { latestReplySnippet } from "./DesktopMountView";
import type { Message } from "@/state/store";

describe("desktop-mount helpers", () => {
  it("positions 320x176 panel at bottom-right of workArea", () => {
    const bounds = desktopMountBounds({ x: 100, y: 40, width: 1440, height: 900 });
    expect(bounds).toEqual({
      x: 100 + 1440 - DESKTOP_MOUNT.width - DESKTOP_MOUNT.margin,
      y: 40 + 900 - DESKTOP_MOUNT.height - DESKTOP_MOUNT.margin,
      width: 320,
      height: 176,
    });
  });

  it("normalizes, clamps, and filters invalid interactive rects", () => {
    const rects = normalizeInteractiveRects([
      { x: -10, y: 120, width: 60, height: 60 },
      { x: 0, y: 0, width: 0, height: 20 },
      { x: 10, y: Number.NaN, width: 40, height: 40 },
      { x: 260, y: 120, width: 100, height: 100 },
    ]);
    expect(rects).toEqual([
      { x: 0, y: 120, width: 50, height: 56 },
      { x: 260, y: 120, width: 60, height: 56 },
    ]);
  });

  it("detects cursor hit only inside interactive rects", () => {
    const winBounds = { x: 1000, y: 700, width: 320, height: 176 };
    const rects = [{ x: 256, y: 112, width: 52, height: 52 }];
    expect(pointInInteractiveRects({ x: 1270, y: 820 }, winBounds, rects)).toBe(true);
    expect(pointInInteractiveRects({ x: 1020, y: 720 }, winBounds, rects)).toBe(false);
    expect(pointInInteractiveRects({ x: 1270, y: 820 }, winBounds, [])).toBe(false);
  });
});

describe("latestReplySnippet", () => {
  it("extracts and truncates the latest bot reply", () => {
    const messages: Message[] = [
      { id: "1", role: "user", kind: "text", text: "hi", at: 1 },
      { id: "2", role: "bot", kind: "text", text: "First reply", at: 2 },
      { id: "3", role: "bot", kind: "text", text: "```ts\nconst x = 1;\n```\nDone with the build and tests.", at: 3 },
    ];
    expect(latestReplySnippet(messages)).toBe("Done with the build and tests.");
  });
});
