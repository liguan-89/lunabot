import { describe, expect, it } from "vitest";

import { PHONE_TOOL_NAMES } from "../shared/phone-apps.ts";
import type { ScreenElement, ScreenView } from "../shared/irreversible.ts";
import {
  ACTION_RISK,
  CHANGE_VERBS,
  assessRisk,
  changesState,
  hasPayableAmount,
  type ActionRisk,
} from "./phone-risk.ts";

/** The tools whose step only reads, or only moves between screens. */
const READ_TOOLS: readonly string[] = [
  "PHONE_LIST_EVENTS", "PHONE_GET_EVENT", "PHONE_FIND_FREE_TIME", "PHONE_LIST_REMINDERS",
  "PHONE_SEARCH_CONTACTS", "PHONE_GET_CONTACT", "PHONE_GET_LOCATION", "PHONE_FIND_PLACES_NEARBY", "PHONE_LIST_HOME",
  "PHONE_UI_OBSERVE", "PHONE_UI_COLLECT", "PHONE_UI_LAUNCH", "PHONE_UI_SCROLL", "PHONE_UI_SWIPE", "PHONE_UI_BACK",
  "PHONE_UI_WAIT", "PHONE_UI_SCREENSHOT", "PHONE_UI_OCR", "PHONE_UI_QUERY", "PHONE_UI_FIND", "PHONE_LIST_APPS",
  "PHONE_CLIPBOARD_GET", "PHONE_NOTIF_LIST", "PHONE_FILE_LIST", "PHONE_FILE_READ", "PHONE_FILE_SEND", "PHONE_OPEN_LINK",
];

/** The tools whose step changes the phone, on its screen or in its own data. */
const CHANGE_TOOLS: readonly string[] = [
  "PHONE_CREATE_EVENT", "PHONE_UPDATE_EVENT", "PHONE_DELETE_EVENT", "PHONE_RESPOND_TO_INVITE",
  "PHONE_CREATE_REMINDER", "PHONE_UPDATE_REMINDER", "PHONE_COMPLETE_REMINDER", "PHONE_DELETE_REMINDER",
  "PHONE_CREATE_CONTACT", "PHONE_UPDATE_CONTACT", "PHONE_SET_ACCESSORY", "PHONE_RUN_SCENE",
  "PHONE_UI_TAP", "PHONE_UI_TAP_AT", "PHONE_UI_TYPE", "PHONE_UI_KEY", "PHONE_UI_RUN",
  "PHONE_CLIPBOARD_SET", "PHONE_SET_ALARM", "PHONE_SET_TIMER", "PHONE_UI_AFTER_TASK",
];

/** The tools whose step hands something to the world outside the phone. */
const EXTERNAL_TOOLS: readonly string[] = [
  "PHONE_SEND_MESSAGE", "PHONE_SEND_WHATSAPP", "PHONE_SHARE_TEXT", "PHONE_FILE_SHARE",
];

const APP = "com.example.shop";

function element(over: Partial<ScreenElement> = {}): ScreenElement {
  return { text: null, description: null, editable: false, scrollable: false, bounds: null, ...over };
}

function screen(elements: readonly ScreenElement[]): ScreenView {
  return { packageName: APP, elements };
}

/** A checkout panel: a total row and a pay button under it. */
const CHECKOUT = screen([
  element({ text: "订单详情", bounds: [0, 0, 1080, 120] }),
  element({ text: "合计", bounds: [0, 900, 300, 960] }),
  element({ text: "¥25", bounds: [300, 900, 1080, 960] }),
  element({ text: "立即支付", bounds: [0, 2000, 1080, 2120] }),
]);

/** An ordinary product page: a price, but nothing that adds up to a charge. */
const PRODUCT = screen([
  element({ text: "商品详情", bounds: [0, 0, 1080, 120] }),
  element({ text: "¥25", bounds: [0, 400, 400, 460] }),
  element({ text: "加入购物车", bounds: [0, 2000, 500, 2120] }),
]);

/** A delete confirmation dialog: the control's words, and no payment anywhere. */
const DELETE_DIALOG = screen([
  element({ text: "确认删除这条记录？", bounds: [0, 800, 1080, 900] }),
  element({ text: "取消", bounds: [0, 1900, 500, 2000] }),
  element({ text: "删除", bounds: [540, 1900, 1080, 2000] }),
]);

describe("ACTION_RISK", () => {
  it("keeps the five levels in Mika's order, read to unknown", () => {
    expect(ACTION_RISK).toEqual(["read", "change", "external", "irreversible", "unknown"]);
  });
});

describe("changesState", () => {
  it("is true for the five screen-changing tools and nothing else in the phone catalog", () => {
    const changing = PHONE_TOOL_NAMES.filter((name) => changesState(name));
    expect(changing).toEqual([...CHANGE_VERBS]);
    expect(changing).toEqual(["PHONE_UI_TAP", "PHONE_UI_TAP_AT", "PHONE_UI_TYPE", "PHONE_UI_KEY", "PHONE_UI_RUN"]);
  });

  it("does not count back, scroll or swipe as a change: they only move between screens", () => {
    for (const name of ["PHONE_UI_BACK", "PHONE_UI_SCROLL", "PHONE_UI_SWIPE", "PHONE_UI_LAUNCH"]) {
      expect(changesState(name), name).toBe(false);
    }
  });

  it("accepts the MCP-shaped name a caller may pass", () => {
    expect(changesState("mcp__device__PHONE_UI_TAP")).toBe(true);
    expect(changesState("mcp__device__PHONE_UI_OBSERVE")).toBe(false);
  });
});

describe("assessRisk, every tool in the catalog", () => {
  const graded = [...READ_TOOLS, ...CHANGE_TOOLS, ...EXTERNAL_TOOLS];

  it("classifies each name exactly once", () => {
    expect([...graded].sort()).toEqual([...PHONE_TOOL_NAMES].sort());
    expect(new Set(graded).size).toBe(PHONE_TOOL_NAMES.length);
  });

  it("grades a read as read, a change as change and a send as external", () => {
    const cases: Array<[readonly string[], ActionRisk]> = [
      [READ_TOOLS, "read"],
      [CHANGE_TOOLS, "change"],
      [EXTERNAL_TOOLS, "external"],
    ];
    for (const [names, level] of cases) {
      for (const name of names) {
        expect(assessRisk({ tool: name }).level, name).toBe(level);
      }
    }
  });

  it("gives every name a level from the closed list and a sentence", () => {
    for (const name of PHONE_TOOL_NAMES) {
      const grade = assessRisk({ tool: name });
      expect(ACTION_RISK).toContain(grade.level);
      expect(grade.why.length, name).toBeGreaterThan(0);
      expect(grade.why.endsWith("."), name).toBe(true);
    }
  });
});

describe("assessRisk, hits decide the level", () => {
  it("grades a read as read even when the page shows an amount", () => {
    expect(assessRisk({ tool: "PHONE_UI_OBSERVE", screen: CHECKOUT }).level).toBe("read");
    expect(assessRisk({ tool: "PHONE_UI_SCROLL", screen: CHECKOUT }).level).toBe("read");
  });

  it("keeps a send external on a checkout screen: sending never spends money", () => {
    const grade = assessRisk({ tool: "PHONE_UI_TAP", hit: { action: "send", matched: "发送" }, screen: CHECKOUT });
    expect(grade.level).toBe("external");
    expect(grade.why).not.toContain("pay");
  });

  it("keeps a delete irreversible with a confirmation dialog and no payment context", () => {
    const grade = assessRisk({ tool: "PHONE_UI_TAP", hit: { action: "delete", matched: "删除" }, screen: DELETE_DIALOG });
    expect(grade.level).toBe("irreversible");
  });

  it("always grades pay and order irreversible, whatever the screen shows", () => {
    for (const action of ["pay", "order"] as const) {
      expect(assessRisk({ tool: "PHONE_UI_TAP", hit: { action, matched: "x" }, screen: PRODUCT }).level).toBe("irreversible");
      expect(assessRisk({ tool: "PHONE_UI_TAP", hit: { action, matched: "x" } }).level).toBe("irreversible");
    }
  });

  it("grades the same tap by the screen it lands on: no panel is unknown, a checkout panel is irreversible", () => {
    const hit = { action: "unknown", matched: "其他" } as const;
    const plain = assessRisk({ tool: "PHONE_UI_TAP", hit, screen: PRODUCT });
    const checkout = assessRisk({ tool: "PHONE_UI_TAP", hit, screen: CHECKOUT });
    expect(plain.level).toBe("unknown");
    expect(checkout.level).toBe("irreversible");
    expect(checkout.why).not.toBe(plain.why);
  });

  it("keeps a delete irreversible either way, and says when the screen adds up to a payment", () => {
    const hit = { action: "delete", matched: "删除" } as const;
    const plain = assessRisk({ tool: "PHONE_UI_TAP", hit, screen: DELETE_DIALOG });
    const checkout = assessRisk({ tool: "PHONE_UI_TAP", hit, screen: CHECKOUT });
    expect(plain.level).toBe("irreversible");
    expect(checkout.level).toBe("irreversible");
    expect(checkout.why).not.toBe(plain.why);
    expect(checkout.why).toContain("pay");
  });

  it("does not quote the screen in the sentence", () => {
    const grade = assessRisk({ tool: "PHONE_UI_TAP", hit: { action: "unknown", matched: "其他" }, screen: CHECKOUT });
    expect(grade.why).not.toContain("¥25");
    expect(grade.why).not.toContain("合计");
    expect(grade.why).not.toContain("立即支付");
  });

  it("grades a name this server does not know as unknown", () => {
    expect(assessRisk({ tool: "COMPOSIO_PROXY_EXECUTE" }).level).toBe("unknown");
    expect(assessRisk({ tool: "" }).level).toBe("unknown");
  });

  it("grades the MCP-shaped name the bot's call carries the same way, and takes the call's args", () => {
    const grade = assessRisk({ tool: "mcp__device__PHONE_UI_TAP", args: { ref: "e3" }, hit: { action: "order", matched: "结算" } });
    expect(grade.level).toBe("irreversible");
    expect(assessRisk({ tool: "mcp__device__PHONE_UI_OBSERVE", args: {} }).level).toBe("read");
  });
});

describe("hasPayableAmount", () => {
  it("reads a total row split across elements as one amount", () => {
    expect(hasPayableAmount(CHECKOUT)).toBe(true);
  });

  it("reads an amount beside a pay control as a charge", () => {
    const sheet = screen([
      element({ text: "支付 ¥25", bounds: [0, 1900, 1080, 2000] }),
    ]);
    expect(hasPayableAmount(sheet)).toBe(true);
  });

  it("does not treat a price on a product page as a charge", () => {
    expect(hasPayableAmount(PRODUCT)).toBe(false);
  });

  it("does not join an amount to a pay button on another row", () => {
    const page = screen([
      element({ text: "¥25", bounds: [0, 400, 400, 460] }),
      element({ text: "立即支付", bounds: [0, 2000, 1080, 2120] }),
    ]);
    expect(hasPayableAmount(page)).toBe(false);
  });

  it("does not treat a salary range or a discount as a charge", () => {
    expect(hasPayableAmount(screen([element({ text: "150-200元/天" })]))).toBe(false);
    expect(hasPayableAmount(screen([element({ text: "优惠 ¥5" })]))).toBe(false);
  });

  it("ignores an amount the person typed into a field", () => {
    expect(hasPayableAmount(screen([element({ text: "合计 ¥25", editable: true })]))).toBe(false);
  });

  it("is false for a screen with none, and for no screen at all", () => {
    expect(hasPayableAmount(screen([]))).toBe(false);
    expect(hasPayableAmount(null)).toBe(false);
    expect(hasPayableAmount(undefined)).toBe(false);
  });
});

describe("assessRisk, a malformed screen", () => {
  it("never throws: the screen comes from the phone, not from this server", () => {
    const malformed = [
      null,
      undefined,
      { packageName: null, elements: "not a list" },
      { packageName: null, elements: [null, 7, "text", { text: 5 }, { bounds: "wide" }, { bounds: [1, 2] }] },
      { elements: [{ text: "合计 ¥25", bounds: [0, 0, "x", 10] }] },
      { elements: [{ text: "合计 ¥25", editable: "yes" }] },
    ] as unknown as ScreenView[];
    for (const screen of malformed) {
      const grade = assessRisk({ tool: "PHONE_UI_TAP", hit: { action: "delete", matched: "删除" }, screen });
      expect(grade.level).toBe("irreversible");
      expect(() => hasPayableAmount(screen)).not.toThrow();
    }
  });

  it("grades a hit on no screen at all by the hit alone", () => {
    expect(assessRisk({ tool: "PHONE_UI_TAP", hit: { action: "send", matched: "发送" }, screen: null }).level).toBe("external");
    expect(assessRisk({ tool: "PHONE_UI_TAP", hit: null, screen: null }).level).toBe("change");
  });
});
