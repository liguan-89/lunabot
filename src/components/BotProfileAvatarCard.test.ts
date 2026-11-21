import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { PRESET_STYLE_BODY_IDS } from "../../shared/bot-body";
import { bodyName } from "@/lib/mascot-names";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Maus",
    title: "Maus",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

function renderCard(bot: Bot) {
  return renderToStaticMarkup(
    createElement(
      StoreProvider,
      null,
      createElement(BotProfileAvatarCard, {
        bot,
        activeState: "idle",
        mascotMotion: null,
        onPatch: vi.fn(),
      }),
    ),
  );
}

describe("BotProfileAvatarCard body picker", () => {
  it("renders one option per preset-style body, labeled by name", () => {
    const markup = renderCard(makeBot());

    expect(markup).toContain(">Body<");
    for (const id of PRESET_STYLE_BODY_IDS) {
      expect(markup).toContain(`aria-label="Use the ${bodyName(id)} body"`);
    }
    expect(markup, "mascot-era bodies are not pickable here anymore").not.toContain('aria-label="Use the Star body"');
  });

  it("offers no festival rows; carved bodies are phone-side dress-up, not picker options", () => {
    const markup = renderCard(makeBot({ mascotBody: "jalebi" }));

    expect(markup).not.toContain(">Halloween<");
    expect(markup).not.toContain(">Diwali<");
    expect(markup).not.toContain('aria-label="Use the Jalebi body"');
    expect(markup).not.toContain('aria-label="Use the Witch body"');
  });

  it("selects the orb preset until a body is chosen; the old cursor default means the preset face", () => {
    const markup = renderCard(makeBot());

    expect(markup).toContain(`aria-pressed="true" aria-label="Use the ${bodyName("orb")} body"`);
    expect(markup).toContain(`aria-pressed="false" aria-label="Use the ${bodyName("neko")} body"`);
    expect(markup).not.toContain('aria-label="Use the Cursor body"');
  });

  it("reflects an explicitly chosen preset-style body", () => {
    const markup = renderCard(makeBot({ mascotBody: "neko" }));

    expect(markup).toContain(`aria-pressed="true" aria-label="Use the ${bodyName("neko")} body"`);
    expect(markup).toContain(`aria-pressed="false" aria-label="Use the ${bodyName("orb")} body"`);
  });

  it("offers zoom and drag framing for a custom image", () => {
    const markup = renderCard(makeBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 1.5,
    }));
    expect(markup).toContain('aria-label="Zoom avatar"');
    expect(markup).toContain("Drag the picture to reposition it");
    expect(markup).toContain("150%");
    expect(markup).toContain("Reset framing");
  });

  it("hides zoom controls for the mascot", () => {
    const markup = renderCard(makeBot());
    expect(markup).not.toContain('aria-label="Zoom avatar"');
  });

  it("hides the body picker for flat crops that have no mascot to wear one", () => {
    const markup = renderCard(makeBot({ avatarCrop: "circle" }));

    expect(markup).not.toContain(">Body<");
    expect(markup).not.toContain(`aria-label="Use the ${bodyName("orb")} body"`);
  });

  it("hides the body picker for every flat crop, not just circle", () => {
    for (const crop of ["rounded", "square"] as const) {
      const markup = renderCard(makeBot({ avatarCrop: crop }));

      expect(markup).not.toContain(">Body<");
    }
  });
});
