// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  DESKTOP_MOUNT,
  clampMountPosition,
  desktopMountBounds,
  normalizeInteractiveRects,
  pointInInteractiveRects,
  snapMountPosition,
  // @ts-expect-error -- untyped ESM module in electron/
} from "../../electron/desktop-mount.mjs";
import { latestReplySnippet, recentMountMessages } from "./DesktopMountView";
import type { Message } from "@/state/store";

describe("desktop-mount helpers", () => {
  it("positions 360x420 panel at bottom-right of workArea", () => {
    const bounds = desktopMountBounds({ x: 100, y: 40, width: 1440, height: 900 });
    expect(bounds).toEqual({
      x: 100 + 1440 - DESKTOP_MOUNT.width - DESKTOP_MOUNT.margin,
      y: 40 + 900 - DESKTOP_MOUNT.height - DESKTOP_MOUNT.margin,
      width: 360,
      height: 420,
    });
  });

  it("clamps dragged positions inside workArea and snaps to nearest edge", () => {
    const workArea = { x: 0, y: 24, width: 1440, height: 876 };
    expect(clampMountPosition(-100, 0, workArea)).toEqual({ x: 0, y: 24 });
    expect(clampMountPosition(2000, 2000, workArea)).toEqual({
      x: 1440 - DESKTOP_MOUNT.width,
      y: 24 + 876 - DESKTOP_MOUNT.height,
    });
    expect(snapMountPosition({ x: 120, y: 200, width: 360, height: 420 }, workArea)).toEqual({
      x: DESKTOP_MOUNT.margin,
      y: 200,
      side: "left",
    });
    expect(snapMountPosition({ x: 900, y: 200, width: 360, height: 420 }, workArea)).toEqual({
      x: 1440 - DESKTOP_MOUNT.width - DESKTOP_MOUNT.margin,
      y: 200,
      side: "right",
    });
  });

  it("normalizes, clamps, and filters invalid interactive rects", () => {
    const rects = normalizeInteractiveRects([
      { x: -10, y: 120, width: 60, height: 60 },
      { x: 0, y: 0, width: 0, height: 20 },
      { x: 10, y: Number.NaN, width: 40, height: 40 },
      { x: 300, y: 360, width: 100, height: 100 },
    ]);
    expect(rects).toEqual([
      { x: 0, y: 120, width: 50, height: 60 },
      { x: 300, y: 360, width: 60, height: 60 },
    ]);
  });

  it("detects cursor hit only inside interactive rects", () => {
    const winBounds = { x: 1000, y: 500, width: 360, height: 420 };
    const rects = [{ x: 296, y: 356, width: 52, height: 52 }];
    expect(pointInInteractiveRects({ x: 1310, y: 870 }, winBounds, rects)).toBe(true);
    expect(pointInInteractiveRects({ x: 1020, y: 520 }, winBounds, rects)).toBe(false);
    expect(pointInInteractiveRects({ x: 1310, y: 870 }, winBounds, [])).toBe(false);
  });
});

describe("latestReplySnippet & recentMountMessages", () => {
  it("preserves readable paragraphs and skips digest/compaction", () => {
    const messages: Message[] = [
      { id: "1", role: "user", kind: "text", text: "hi", at: 1 },
      { id: "2", role: "bot", kind: "text", text: "First reply", at: 2 },
      { id: "3", role: "bot", kind: "text", text: "Line one.\n\nLine two.", at: 3 },
      { id: "4", role: "bot", kind: "digest", text: "[digest] · no tool activity observed in this turn", at: 4 },
      { id: "5", role: "bot", kind: "compaction", text: "Compacted", at: 5 },
    ];
    expect(latestReplySnippet(messages)).toBe("Line one.\n\nLine two.");
    expect(recentMountMessages(messages).map((m) => m.id)).toEqual(["1", "2", "3"]);
  });
});
