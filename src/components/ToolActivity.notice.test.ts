import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => mode.advanced }));

const { ToolActivity } = await import("./ToolActivity");
const { setLocale } = await import("@/lib/i18n");

const render = (tool: Parameters<typeof ToolActivity>[0]["tool"]) => renderToStaticMarkup(createElement(ToolActivity, { tool }));

const resumed = { name: "Resuming after a restart", ok: true, nameCode: "chat.notice.resumingAfterRestart" };
const { heldMemberLine } = await import("../../server/room-holds");
await import("../../server/server-line-packs");
const held = (name: string, language?: string) => ({ name: heldMemberLine(name, language), ok: false });

afterEach(() => {
  mode.advanced = false;
  setLocale("en");
});

describe("a server notice in ToolActivity", () => {
  it.each([false, true])("is worded in the person's language without its English name in the details (advanced: %s)", (advanced) => {
    mode.advanced = advanced;
    setLocale("zh");
    const html = render(resumed);
    expect(html).toContain("重启后正在恢复");
    expect(html).not.toContain("Resuming after a restart");
    expect(html).not.toContain('data-testid="tool-name"');
    expect(html).not.toContain("font-mono\">重启后");
  });

  it("fills its params", () => {
    setLocale("zh");
    expect(render(held("Scout", "zh"))).toContain("Scout 已暂停（由你停止）。用 @ 提及它，或输入「resume」");
  });

  it("keeps the English for a code this build does not know or a param that is missing", () => {
    setLocale("zh");
    const unknown = render({ name: "A notice from a newer server", ok: true, nameCode: "chat.notice.inventedLater" });
    expect(unknown).toContain("A notice from a newer server");
    const missing = render(held("Scout"));
    expect(missing).toContain("Scout is held (stopped by you) — @mention it or say resume");
    expect(missing).not.toContain("{name}");
  });

  it("shows markup in a param as text", () => {
    setLocale("zh");
    const html = render(held("<img src=x onerror=alert(1)>", "zh"));
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; 已暂停（由你停止）");
    expect(html).not.toContain("<img");
  });
});
