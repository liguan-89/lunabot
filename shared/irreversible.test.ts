import { describe, expect, it } from "vitest";

import {
  ConfirmGate,
  IRREVERSIBLE_ACTIONS,
  MAX_STEPS,
  classifyControl,
  type ConfirmationRequest,
  type ControlElement,
  type IrreversibleAction,
  type ScreenView,
} from "./irreversible.ts";

const APP = "com.example.chat";
const OTHER_APP = "com.example.shop";

function tap(text: string, extra: Partial<ControlElement> = {}) {
  return classifyControl({ element: { text, ...extra } });
}

function request(over: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return { action: "delete", target: "旧照片", content: "", amount: null, app: APP, ...over };
}

function screen(elements: ScreenView["elements"], over: Partial<ScreenView> = {}): ScreenView {
  return { packageName: APP, elements, ...over };
}

function granted(over: Partial<ConfirmationRequest> = {}, step = 1): ConfirmGate {
  const gate = new ConfirmGate();
  expect(gate.declare(request(over), over.app ?? APP)).toBe("pending");
  gate.decide(true, step);
  return gate;
}

describe("classifyControl", () => {
  it("keeps the four action kinds closed", () => {
    expect(IRREVERSIBLE_ACTIONS).toEqual(["pay", "order", "delete", "send"]);
  });

  it("classifies each Chinese kind from the control's own text", () => {
    const cases: Array<[string, IrreversibleAction]> = [
      ["支付", "pay"],
      ["立即付款", "pay"],
      ["确认转账", "pay"],
      ["删除", "delete"],
      ["撤回消息", "delete"],
      ["立即下单", "order"],
      ["确认购买", "order"],
      ["去结算", "order"],
      ["去结账", "order"],
      ["取消订单", "order"],
      ["确认收货", "order"],
      ["申请退款", "order"],
      ["转发", "send"],
    ];
    for (const [text, action] of cases) {
      expect(tap(text), text).toEqual({ action, matched: text });
    }
  });

  it("classifies each English kind, matching a whole label only", () => {
    const cases: Array<[string, IrreversibleAction]> = [
      ["Pay", "pay"],
      ["Pay now", "pay"],
      ["Confirm payment", "pay"],
      ["Buy now", "order"],
      ["Place order", "order"],
      ["Checkout", "order"],
      ["Delete", "delete"],
      ["Remove", "delete"],
      ["Send message", "send"],
      ["Forward", "send"],
    ];
    for (const [text, action] of cases) {
      expect(tap(text), text).toEqual({ action, matched: text });
    }
  });

  it("does not read an order status or a payment-method entry as an action", () => {
    for (const text of ["待付款", "已付款", "付款成功", "购买记录", "转账记录", "支付方式", "支付宝", "付款方式说明", "支持花呗付款"]) {
      expect(tap(text), text).toBeNull();
    }
  });

  it("matches a strong word inside a short name, but not inside one longer than the limit", () => {
    expect(tap("去付款")).toEqual({ action: "pay", matched: "去付款" });
    expect(tap("请先核对收货地址信息后立即付款")).toBeNull();
  });

  it("splits a composed name and matches one of its segments", () => {
    expect(tap("请先核对收货地址信息 立即付款")).toEqual({ action: "pay", matched: "请先核对收货地址信息 立即付款" });
    expect(tap("待付款 立即付款")).toEqual({ action: "pay", matched: "待付款 立即付款" });
  });

  it("matches a send button that is a send word plus a little punctuation", () => {
    expect(tap("发送(1)")).toEqual({ action: "send", matched: "发送(1)" });
    expect(tap("发布")).toEqual({ action: "send", matched: "发布" });
    // PUNCT_WORDS is not ported: 评论(23) is an entry and a count, not a send.
    expect(tap("评论(23)")).toBeNull();
    expect(tap("回复 3")).toBeNull();
  });

  it("reads the content description and the view id when the text is absent", () => {
    expect(classifyControl({ element: { description: "删除这条消息" } })).toEqual({ action: "delete", matched: "删除这条消息" });
    expect(classifyControl({ element: { viewId: "com.example.chat:id/btn_send" } })).toEqual({
      action: "send",
      matched: "com.example.chat:id/btn_send",
    });
    expect(classifyControl({ element: { viewId: "com.example.chat:id/btnPay" } })).toEqual({
      action: "pay",
      matched: "com.example.chat:id/btnPay",
    });
    expect(classifyControl({ element: { viewId: "com.example.chat:id/messageList" } })).toBeNull();
  });

  it("folds traditional characters before matching", () => {
    expect(tap("刪除")).toEqual({ action: "delete", matched: "刪除" });
    expect(tap("確認購買")).toEqual({ action: "order", matched: "確認購買" });
  });

  it("treats a tap on a text field as editing, not as the words in it", () => {
    expect(tap("删除", { editable: true })).toBeNull();
    expect(tap("支付", { password: true })).toBeNull();
  });

  it("treats an enter key as a send unless the field is a search box", () => {
    expect(classifyControl({ interaction: "enter" })).toEqual({ action: "send", matched: "enter" });
    expect(classifyControl({ interaction: "enter", element: { text: "说点什么", editable: true } })).toEqual({
      action: "send",
      matched: "enter:说点什么",
    });
    expect(classifyControl({ interaction: "enter", element: { text: "搜索", editable: true, viewId: "id/search_input" } })).toBeNull();
    expect(classifyControl({ interaction: "enter", element: { text: "发送" } })).toEqual({ action: "send", matched: "发送" });
    expect(classifyControl({ interaction: "enter", element: { text: "确定" } })).toBeNull();
  });

  it("treats a horizontal swipe on a wide list row as a delete, and nothing else", () => {
    const row: ControlElement = { text: "张三", clickable: true, bounds: [0, 200, 900, 300] };
    expect(classifyControl({ interaction: "swipe", element: row })).toEqual({ action: "delete", matched: "swipe:张三" });
    expect(classifyControl({ interaction: "swipe", element: { ...row, scrollable: true } })).toBeNull();
    expect(classifyControl({ interaction: "swipe", element: { ...row, clickable: false } })).toBeNull();
    expect(classifyControl({ interaction: "swipe", element: { ...row, bounds: [0, 0, 100, 900] } })).toBeNull();
  });

  it("reads a generic confirm against the rest of the screen", () => {
    expect(classifyControl({ element: { text: "确认" }, screenTexts: ["确认删除这条消息吗", "删除", "取消"] })).toEqual({
      action: "delete",
      matched: "确认",
    });
    expect(classifyControl({ element: { text: "确定" }, screenTexts: ["合计 ¥39.90", "支付方式"] })).toEqual({
      action: "pay",
      matched: "确定",
    });
    expect(classifyControl({ element: { text: "确定" }, screenTexts: ["是否保存草稿"] })).toBeNull();
    expect(classifyControl({ element: { text: "确认" } })).toBeNull();
  });

  it("stays narrower than Mika's English prefix table", () => {
    expect(tap("Send message to Alice")).toBeNull();
    expect(tap("Payment history")).toBeNull();
    expect(tap("Pending payment")).toBeNull();
    expect(tap("Delete account history")).toBeNull();
    expect(tap("Delete account")).toEqual({ action: "delete", matched: "Delete account" });
    // The status affixes apply to the English path too.
    expect(tap("已pay")).toBeNull();
    expect(tap("pay成功")).toBeNull();
  });
});

describe("ConfirmGate", () => {
  it("allows the step the person approved", () => {
    const gate = granted();
    const hit = { action: "delete" as const, matched: "删除" };
    expect(gate.permits(hit, screen([{ text: "旧照片", bounds: [0, 100, 400, 200] }]), 2)).toEqual({ result: "allowed" });
  });

  it("refuses a declaration for another app or with no foreground app", () => {
    const gate = new ConfirmGate();
    expect(gate.declare(request(), OTHER_APP)).toBe("mismatch");
    expect(gate.declare(request(), null)).toBe("mismatch");
  });

  it("never asks for a payment, and never permits one", () => {
    const gate = new ConfirmGate();
    expect(gate.declare(request({ action: "pay" }), APP)).toBe("unsupported");
    const order = granted({ action: "order", target: "订单", amount: "¥39.90" });
    const permit = order.permits({ action: "pay", matched: "付款" }, screen([{ text: "订单" }]), 2);
    expect(permit).toEqual({ result: "mismatch", reason: "payment is never approved here" });
  });

  it("uses up the grant on a mismatch, so a second step gets nothing", () => {
    const gate = granted();
    const first = gate.permits({ action: "send", matched: "发送" }, screen([{ text: "旧照片" }]), 2);
    expect(first.result).toBe("mismatch");
    expect(gate.permits({ action: "delete", matched: "删除" }, screen([{ text: "旧照片" }]), 3)).toEqual({ result: "no-grant" });
  });

  it("refuses a screen that is not the declared app or no longer shows the target", () => {
    const wrongApp = granted();
    expect(wrongApp.permits({ action: "delete", matched: "删除" }, screen([{ text: "旧照片" }], { packageName: OTHER_APP }), 2).result).toBe("mismatch");
    const gone = granted();
    expect(gone.permits({ action: "delete", matched: "删除" }, screen([{ text: "新照片" }]), 2).result).toBe("mismatch");
  });

  it("expires after MAX_STEPS steps", () => {
    const atLimit = granted({}, 5);
    expect(atLimit.permits({ action: "delete", matched: "删除" }, screen([{ text: "旧照片" }]), 5 + MAX_STEPS)).toEqual({ result: "allowed" });
    const past = granted({}, 5);
    expect(past.permits({ action: "delete", matched: "删除" }, screen([{ text: "旧照片" }]), 5 + MAX_STEPS + 1)).toEqual({
      result: "mismatch",
      reason: `the approval expired (${MAX_STEPS} steps)`,
    });
  });

  it("survives typing but not any other write", () => {
    const typed = granted();
    typed.noteWrite("typing");
    expect(typed.permits({ action: "delete", matched: "删除" }, screen([{ text: "旧照片" }]), 2)).toEqual({ result: "allowed" });
    const written = granted();
    written.noteWrite("other");
    expect(written.permits({ action: "delete", matched: "删除" }, screen([{ text: "旧照片" }]), 2)).toEqual({ result: "no-grant" });
  });

  it("binds an order to the declared amount by value, not by substring", () => {
    const totals = (amount: string) => screen([{ text: `合计 ${amount}` }, { text: "商品" }, { text: "立即付款", bounds: [0, 900, 400, 960] }]);
    const hit = { action: "order" as const, matched: "立即付款" };
    expect(granted({ action: "order", target: "商品", amount: "39.90" }).permits(hit, totals("¥39.90"), 2)).toEqual({ result: "allowed" });
    expect(granted({ action: "order", target: "商品", amount: "¥3.90" }).permits(hit, totals("¥3.9"), 2)).toEqual({ result: "allowed" });
    expect(granted({ action: "order", target: "商品", amount: "39.90" }).permits(hit, totals("¥139.90"), 2).result).toBe("mismatch");
    expect(granted({ action: "order", target: "商品", amount: null }).permits(hit, totals("¥39.90"), 2).result).toBe("mismatch");
  });

  it("requires every total on the screen to match the declared amount", () => {
    const gate = granted({ action: "order", target: "商品", amount: "39.90" });
    const two = screen([{ text: "合计 ¥10.00" }, { text: "实付 ¥39.90" }]);
    expect(gate.permits({ action: "order", matched: "立即付款" }, two, 2).result).toBe("mismatch");
  });

  it("binds a send to the exact text and to a target in the title band", () => {
    const title = [{ text: "小明", bounds: [0, 0, 200, 60] }, { text: "我马上到", editable: true }];
    const hit = { action: "send" as const, matched: "发送" };
    const approved = () => granted({ action: "send", target: "小明", content: "我马上到" });
    expect(approved().permits(hit, screen(title, { height: 800 }), 2, "我马上到")).toEqual({ result: "allowed" });
    expect(approved().permits(hit, screen(title, { height: 800 }), 2, "我马上就到").result).toBe("mismatch");
    const scrolled = [{ text: "小明", bounds: [0, 600, 200, 660] }, { text: "我马上到", editable: true }];
    expect(approved().permits(hit, screen(scrolled, { height: 800 }), 2, "我马上到").result).toBe("mismatch");
  });

  it("remembers a refusal per kind and app for the run", () => {
    const gate = new ConfirmGate();
    expect(gate.declare(request(), APP)).toBe("pending");
    gate.decide(false, 1);
    expect(gate.declare(request(), APP)).toBe("declined");
    expect(gate.declare(request({ action: "send" }), APP)).toBe("pending");
    expect(gate.declare(request({ app: OTHER_APP }), OTHER_APP)).toBe("pending");
    gate.reset();
    expect(gate.declare(request(), APP)).toBe("pending");
  });

  it("drops the grant on reset", () => {
    const gate = granted();
    gate.reset();
    expect(gate.permits({ action: "delete", matched: "删除" }, screen([{ text: "旧照片" }]), 2)).toEqual({ result: "no-grant" });
  });
});
