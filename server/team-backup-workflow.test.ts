import { expect, it } from "vitest";
import { verifyTeamBackup } from "../scripts/verify-team-backup.ts";

// The recipe (and the copied-conversation assertions below it) names the reply
// "hello from fake claude". The fixture runs the fake pi now; the launcher's
// supported compat knobs make that same pi answer under the retired name, so
// the recipe's transcript checks keep reading one fixed reply.
it("exports and imports through the real server, retains originals and continues the copied chat", async () => {
  const previous = process.env.FAKE_CLAUDE_REPLIES;
  process.env.FAKE_CLAUDE_REPLIES = JSON.stringify(["hello from fake claude"]);
  try {
    expect(await verifyTeamBackup()).toMatchObject({ ok: true, originalConversationUnchanged: true, importedConversationContinued: true, standingInstructionsPreserved: true, templateSectionsIsolated: true });
  } finally {
    if (previous === undefined) delete process.env.FAKE_CLAUDE_REPLIES;
    else process.env.FAKE_CLAUDE_REPLIES = previous;
  }
}, 90_000);
