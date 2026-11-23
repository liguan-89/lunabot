// What codesign says about the running app decides whether Squirrel.Mac can ever install over it.
import assert from "node:assert/strict";
import test from "node:test";
import { appSignatureKind } from "./app-signing.mjs";

const ADHOC = `Executable=/Applications/Luna Bot.app/Contents/MacOS/Luna Bot
Identifier=com.lunabot.app
CodeDirectory v=20500 size=624 flags=0x10002(adhoc,runtime) hashes=9+7 location=embedded
Signature=adhoc
`;

const SIGNED = `Executable=/Applications/Luna Bot.app/Contents/MacOS/Luna Bot
Identifier=com.lunabot.app
CodeDirectory v=20500 size=1630 flags=0x10000(runtime) hashes=50+6 location=embedded
Authority=Developer ID Application: Luna Bot (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 23, 2026 at 12:00:00
Signature size=4789
`;

test("an app with no signing identity is adhoc, whichever line says it", () => {
  for (const report of [ADHOC, "Identifier=com.lunabot.app\nCodeDirectory v=20500 flags=0x10002(adhoc,runtime)\n"]) {
    assert.equal(appSignatureKind({ platform: "darwin", report: () => report }), "adhoc");
  }
});

test("an app carrying an identity is signed and keeps the native updater", () => {
  assert.equal(appSignatureKind({ platform: "darwin", report: () => SIGNED }), "signed");
});

test("a report this does not understand leaves the native updater alone", () => {
  for (const report of ["", "codesign: not found", "Executable=/x\n"]) {
    assert.equal(appSignatureKind({ platform: "darwin", report: () => report }), "unknown");
  }
});

test("only macOS is asked about a signature", () => {
  let asked = 0;
  for (const platform of ["win32", "linux", "freebsd"]) {
    assert.equal(appSignatureKind({ platform, report: () => { asked += 1; return ADHOC; } }), "unknown");
  }
  assert.equal(asked, 0);
});

test("the report is taken from the running executable", () => {
  let asked = null;
  appSignatureKind({ platform: "darwin", execPath: "/Applications/Luna Bot.app/Contents/MacOS/Luna Bot", report: (path) => { asked = path; return SIGNED; } });
  assert.equal(asked, "/Applications/Luna Bot.app/Contents/MacOS/Luna Bot");
});
