import { expect, it } from "vitest";

import { locales } from "./index";

it("words the unreadable-credential-store notice for any device, never calling it a Mac", () => {
  const packs = Object.entries(locales) as Array<[string, Record<string, string | undefined>]>;
  for (const [language, pack] of packs) {
    expect(pack["connectors.stale"], language).toBeTruthy();
    expect(pack["connectors.stale"], language).not.toMatch(/Mac/);
  }
});
