import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BotOverview } from "@/lib/bot-overview-types";
import type { PromptPreviewData } from "./PromptPreview";
import { OverviewSection } from "./OverviewSection";

// renderToStaticMarkup HTML-escapes apostrophes as &#x27;; decode before comparing.
function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element).replace(/&#x27;/g, "'");
}

const sentences: BotOverview = {
  who: {
    name: "Scout",
    title: "Research specialist",
    blurb: "Digs into a claim and reports back with sources.",
    soulLead: "Always cite primary sources and separate fact from inference.",
  },
  does: ["Daily at 9:00 AM: Morning brief. Next run 9:00 AM."],
  reaches: ["Works in its own private folder.", "Has the built-in browser."],
  wont: [
    "Won't run commands without asking you first.",
    "Won't contact other bots without asking.",
    "Has no connected apps.",
    "Can't use a computer.",
    "Won't act on a schedule.",
    "Won't change its own instructions without your approval.",
  ],
  recent: [{ at: 1700000000000, summary: "Title changed" }],
};

const prompt: PromptPreviewData = {
  sections: [{ id: "persona", label: "Identity", text: "You are Scout.", bytes: 42 }],
  totalBytes: 42,
  approxTokens: 11,
  note: "Approximate.",
};

describe("OverviewSection", () => {
  it("offers optional setup ideas without declaring a usable bot unfinished", () => {
    const markup = render(createElement(OverviewSection, {
      overview: { ...sentences, setup: [
        { id: "identity", label: "Identity", done: true, section: "identity" },
        { id: "folder", label: "Choose a working folder", done: false, section: "access" },
        { id: "schedule", label: "Add a routine", done: false, section: "routines" },
      ] }, prompt: null, onOpen: vi.fn(),
    }));
    expect(markup).toContain("Setup ideas");
    expect(markup).toContain("You can start chatting now.");
    expect(markup).toContain("Choose a working folder");
    expect(markup).not.toContain("Finish setting up");
    expect(markup).not.toContain("1 of 3 done");
    expect(markup).not.toContain(">Identity</span>");
  });

  it("says in its own words that a bot can reach every bot, and whose departments a Chief is in charge of", () => {
    const markup = render(createElement(OverviewSection, {
      overview: { ...sentences, reaches: ["Can talk to all 7 other bots, in any department.", "Also in charge of these departments: Dev, Sales."] },
      prompt: null, onOpen: vi.fn(),
    }));
    expect(markup).toContain("Can talk to all 7 other bots, in any department.");
    expect(markup).toContain("Also in charge of these departments: Dev, Sales.");
  });

  it("shows Loading… before the overview arrives", () => {
    const markup = render(
      createElement(OverviewSection, { overview: null, prompt: null, onOpen: vi.fn() }),
    );
    expect(markup).toContain("Loading…");
  });

  it("renders the six wont lines, a does line, and a Read all link into Soul", () => {
    const markup = render(
      createElement(OverviewSection, { overview: sentences, prompt, onOpen: vi.fn() }),
    );

    for (const line of sentences.wont) {
      expect(markup).toContain(line);
    }
    expect(markup).toContain(sentences.does[0]);
    expect(markup).toContain("Read all");
  });

  it("shows the empty-does fallback when the bot does nothing yet", () => {
    const empty: BotOverview = { ...sentences, does: [] };
    const markup = render(
      createElement(OverviewSection, { overview: empty, prompt, onOpen: vi.fn() }),
    );

    expect(markup).toContain("Nothing scheduled or learned yet.");
  });

  it("passes promptError through to PromptPreview instead of just nulling the data", () => {
    const markup = render(
      createElement(OverviewSection, { overview: sentences, prompt: null, promptError: true, onOpen: vi.fn() }),
    );

    expect(markup).toContain("Prompt preview");
  });

  it("keeps showing the loaded overview and adds a quiet banner when a background refresh fails", () => {
    const markup = render(
      createElement(OverviewSection, { overview: sentences, refreshError: true, prompt, onOpen: vi.fn() }),
    );

    expect(markup).toContain("Couldn’t refresh. Showing the last loaded overview.");
    for (const line of sentences.wont) {
      expect(markup).toContain(line);
    }
  });

  it("omits the refresh banner when there was no refresh error", () => {
    const markup = render(
      createElement(OverviewSection, { overview: sentences, refreshError: false, prompt, onOpen: vi.fn() }),
    );

    expect(markup).not.toContain("Couldn’t refresh");
  });
});

describe("the overview's reach and limits in the person's language", () => {
  it("words the bots it can talk to, contact and Ask mode, each count by its own plural", async () => {
    const { setLocale } = await import("@/lib/i18n");
    const overview = { ...sentences, reaches: ["Can talk to 1 other bot in its department.", "Can talk to 3 other bots in its allowed departments."],
      wont: ["Cannot initiate contact with other bots.", "Command approvals use Ask mode; saved permissions and provider rules still apply."] };
    const html = () => render(createElement(OverviewSection, { overview, prompt: null, onOpen: vi.fn() }));
    expect(html()).toContain("Can talk to 1 other bot in its department.");
    setLocale("zh");
    try {
      const shown = html();
      expect(shown).toContain("可以与其部门中的 1 个其他机器人交谈。");
      expect(shown).toContain("可以与其允许的部门中的 3 个其他机器人交谈。");
      expect(shown).toContain("无法主动联系其他机器人。");
      expect(shown).toContain("命令批准使用「询问」模式；已保存的权限和提供方规则仍然适用。");
    } finally {
      setLocale("en");
    }
  });

  it("words an older server's overview, with no doesRoutines or managedSections, as it words a newer one's", async () => {
    const { setLocale } = await import("@/lib/i18n");
    const older: BotOverview = { ...sentences, does: ["Paused: Nightly Backup."],
      reaches: ["Can talk to 1 other bot in its section.", "Can talk to 2 other bots in its allowed teams.", "Coordinates its section as Chief of Staff.", "May also coordinate these teams: General, Research."] };
    const newer: BotOverview = { ...sentences, does: ["Paused: Nightly Backup."], managedSections: ["", "Research"],
      doesRoutines: [{ name: "Nightly Backup", paused: true, schedule: { type: "daily", time: "09:00", weekdays: [1] } }],
      reaches: ["Can talk to 1 other bot in its department.", "Can talk to 2 other bots in its allowed departments.", "Coordinates its department as Chief of Staff.", "May also coordinate these departments: General, Research."] };
    const html = (overview: BotOverview) => render(createElement(OverviewSection, { overview, prompt: null, onOpen: vi.fn() }));
    for (const overview of [older, newer]) {
      const shown = html(overview);
      for (const line of [...overview.does, ...overview.reaches]) expect(shown, line).toContain(line);
    }
    setLocale("zh");
    try {
      for (const shown of [html(older), html(newer)]) {
        expect(shown).toContain("可以与其部门中的 1 个其他机器人交谈。");
        expect(shown).toContain("可以与其允许的部门中的 2 个其他机器人交谈。");
        expect(shown).toContain("以 Luna 的身份协调其部门。");
      }
      expect(html(older)).toContain("也可以协调这些部门：General, Research。");
      expect(html(older)).toContain("Paused: Nightly Backup.");
      expect(html(newer)).toContain("也可以协调这些部门：通用, Research。");
      expect(html(newer)).toContain("已暂停：Nightly Backup。");
    } finally {
      setLocale("en");
    }
  });
});
