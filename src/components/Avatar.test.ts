import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotAvatar,
  MausAvatar,
  resolveBotAvatarOutcome,
  type BotAvatarProps,
  type MausAvatarProps,
} from "./Avatar";

const render = (props: Partial<MausAvatarProps>) =>
  renderToStaticMarkup(createElement(MausAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>, fallback?: BotAvatarProps["fallback"]) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false, ...(fallback ? { fallback } : {}) }),
  );

describe("MausAvatar body", () => {
  it("renders the stored avatar style when no body is given", () => {
    const markup = render({});
    expect(markup).toContain('data-preset-face="green"');
    expect(markup).toContain('data-avatar-style="orb"');
  });

  it("renders a preset-style body as its own style", () => {
    const markup = render({ bodyId: "neko" });
    expect(markup).toContain('data-avatar-style="neko"');
  });

  it("falls back to the stored style for a mascot or unknown body", () => {
    // SAFETY: "hexagram" is deliberately not a BotBodyId, to exercise the runtime fallback for persisted or streamed
    // data. Mascot-era ids like "star" reach the same fallback now that bodies route through PresetFace.
    for (const bodyId of ["hexagram", "star"] as MausAvatarProps["bodyId"][]) {
      expect(render({ bodyId })).toContain('data-avatar-style="orb"');
    }
  });

  it("paints the body with the per-bot gradient, never a flat black fill", () => {
    const markup = render({ bodyId: "circle" });
    expect(markup).not.toContain('fill="#000000"');
    expect(markup).not.toContain("{{GRADIENT}}");
    expect(markup).toContain("url(#");
  });
});

describe("mascot facial feature colors", () => {
  it.each(["white", "black"] as const)("paints the features with %s ink when the bot asks for it", (mascotFaceColor) => {
    const ink = mascotFaceColor === "white" ? "#ffffff" : "#000000";
    for (const mascotBody of ["orb", "neko", "liquid"] as const) {
      for (const color of ["green", "chrome"] as const) {
        const markup = renderBot({ color, mascotBody, mascotFaceColor });
        expect(markup).toContain(`fill="${ink}"`);
      }
    }
  });

  it("keeps each preset's own eye ink when no override is set", () => {
    expect(renderBot({ color: "chrome", mascotFaceColor: null })).toContain('fill="#1C1C1E"');
    expect(renderBot({ color: "green" })).toContain('fill="#16291E"');
  });

  it("does not paint features over an uploaded image", () => {
    const markup = renderBot({ mascotFaceColor: "black", avatarUrl: "/api/attachments/photo.png", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });
});

describe("the flat preset portrait", () => {
  it.each([
    ["chrome", "white"],
    ["silver", "silver"],
    ["green", "green"],
    ["coral", "coral"],
    ["red", "red"],
    ["orange", "orange"],
    ["yellow", "yellow"],
    ["purple", "purple"],
    ["blue", "blue"],
  ] as const)("maps %s to the phone's %s face", (color, preset) => {
    const markup = renderBot({ color }, "preset");
    expect(markup).toContain(`data-preset-face="${preset}"`);
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("<img");
  });

  it("is the portrait the mascot outcome draws, whatever legacy fallback the caller passes", () => {
    expect(renderBot({ color: "chrome" })).toContain('data-preset-face="white"');
    expect(renderBot({ color: "chrome" }, "preset")).toContain('data-preset-face="white"');
    expect(renderBot({ color: "chrome" }, "preset")).toContain("linearGradient");
  });

  it("still shows an uploaded image ahead of the preset", () => {
    const markup = renderBot({ color: "chrome", avatarUrl: "/api/attachments/photo.png", avatarCrop: "circle" }, "preset");
    expect(markup).toContain("<img");
    expect(markup).not.toContain("data-preset-face");
  });

  it("renders mascot-era body ids through the stored style; preset ids keep their own style", () => {
    expect(renderBot({ mascotBody: "cursor" }, "preset")).toContain('data-avatar-style="orb"');
    expect(renderBot({ mascotBody: "star" }, "preset")).toContain('data-avatar-style="orb"');
    expect(renderBot({ mascotBody: "neko" }, "preset")).toContain('data-avatar-style="neko"');
  });
});

describe("BotAvatar's two avatar outcomes", () => {
  it("zooms and positions a custom image inside its crop", () => {
    const markup = renderBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 2,
      avatarFocusX: 0.25,
      avatarFocusY: 0.75,
    });
    expect(markup).toContain("scale(2)");
    expect(markup).toContain("25% 75%");
    expect(markup).toContain("border-radius:50%");
  });

  it("renders a flat cropped image for circle/rounded/square, with no mascot at all", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  it("shows the image as it is, with no mascot face painted on it", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "square" });
    expect(markup).toContain("border-radius:0");
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<image");
    expect(markup).not.toContain("radialGradient");
  });

  it("renders the gradient mascot when the crop is mascot, image or not", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "mascot" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });

  it("falls back to the gradient mascot when a flat crop has no valid image", () => {
    const markup = renderBot({ avatarUrl: undefined, avatarCrop: "circle" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });
});

describe("resolveBotAvatarOutcome", () => {
  // imageFailed is set by the <img>'s onError, which renderToStaticMarkup never fires, so the decision is a pure
  // function.
  it("falls back to the gradient mascot for an image that failed to load", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "circle", hasUrl: true, imageFailed: true }),
    ).toBe("gradientMascot");
  });

  it("renders a good flat image flat", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "rounded", hasUrl: true, imageFailed: false }),
    ).toBe("flatImage");
  });

  it("keeps the mascot crop on the gradient mascot even with a loaded image", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "mascot", hasUrl: true, imageFailed: false }),
    ).toBe("gradientMascot");
  });

  it("falls back to the gradient mascot when there is no image at all", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "square", hasUrl: false, imageFailed: false }),
    ).toBe("gradientMascot");
  });
});
