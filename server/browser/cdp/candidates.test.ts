import { describe, expect, it } from "vitest";

import { snapshotCandidates } from "./candidates.ts";

describe("snapshotCandidates", () => {
  it("reads interactive refs, roles and names, and skips disabled and text lines", () => {
    const tree = [
      '- button "Save" [ref=e1]',
      '- text: Some page copy',
      '- textbox [ref=e2] [value="Ada"]',
      '- button "Delete" [disabled] [ref=e3]',
      '- link "Help" [ref=e4]',
      '- checkbox "Remember me" [checked] [ref=e5]',
    ].join("\n");
    expect(snapshotCandidates(tree)).toEqual([
      { ref: "e1", role: "button", name: "Save" },
      { ref: "e2", role: "textbox" },
      { ref: "e4", role: "link", name: "Help" },
      { ref: "e5", role: "checkbox", name: "Remember me" },
    ]);
  });
});
