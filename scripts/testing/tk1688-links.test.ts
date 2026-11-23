// TK1688 is the app's own market: every address to its site or API is one of a small set, so nothing drifts
// into a look-alike domain or a stray path.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TK1688_URL } from "../../shared/tk1688.ts";
import { CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";

const ROOT = new URL("../../", import.meta.url);
const API_BASE = "https://api.tk1688.com/v1";
const MENTION = /(?:https?:\/\/)?(?:[\w-]+\.)*tk1688\.com[^\s"'`)\]<>]*/gi;
const lines = (file: string) => readFileSync(new URL(file, ROOT), "utf8").split("\n");
const isComment = (line: string) => /^\s*(?:\/\/|\/?\*)/.test(line) || /^\s*\/\*\*.*\*\/\s*$/.test(line);
const files = (...paths: string[]) => execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...paths], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((file) => /\.(ts|tsx|mjs|json)$/.test(file) && !file.includes(".test."));
const mentions = (file: string) => lines(file).filter((line) => !isComment(line)).flatMap((line) => line.match(MENTION) ?? []);
// A bare hostname may sit inside a sentence (market copy): `tk1688.com;`, `tk1688.com，Luna…`. The address ends
// where the sentence's punctuation starts — a look-alike domain or stray path contains none of these characters.
const address = (mention: string) => mention.split(/[,;，。；！？、]/, 1)[0].replace(/[.:：]+$/, "");

describe("links to TK1688's site", () => {
  it("is the market's own address", () => {
    expect(TK1688_URL).toBe("https://tk1688.com/");
  });

  it("src/ and shared/ name only the market's own addresses", () => {
    const allowed = new Set([TK1688_URL, "tk1688.com", API_BASE]);
    const found = files("src", "shared").flatMap((file) => mentions(file).map((mention) => [file, mention]));
    expect(found.filter(([, mention]) => !allowed.has(address(mention)))).toEqual([]);
  });

  it("is the only link the secret card offers; the server otherwise names only the API base", () => {
    expect(CREDENTIAL_TARGETS.tk1688ApiKey.helpUrl).toBe(TK1688_URL);
    const found = files("server").flatMap((file) => mentions(file).map((mention) => [file, mention]));
    expect(found.filter(([, mention]) => mention !== API_BASE)).toEqual([]);
  });
});
