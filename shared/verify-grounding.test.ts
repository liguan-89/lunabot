import { describe, expect, it } from "vitest";

import { checkGrounding, ORDINAL, ungroundedFacts, UNIT_AFTER, DATE } from "./verify-grounding.ts";

const found = (answer: string, evidence: readonly string[], goal?: string) =>
  ungroundedFacts(answer, evidence, goal === undefined ? {} : { goal }).map((claim) => claim.text);

describe("quoted text", () => {
  it("must appear in some evidence", () => {
    expect(found("已发送「早上好」给阿明。", ["微信\n阿明\n早上好\n已发送"])).toEqual([]);
    expect(found("已发送「晚上好」给阿明。", ["微信\n阿明\n早上好\n已发送"])).toEqual(["晚上好"]);
  });

  it("works for every quote style, and for English", () => {
    expect(found("The screen said “Payment sent” and 『Done』.", ["Payment sent\nDone"])).toEqual([]);
    expect(found('It said "Payment sent".', ["Payment sent"])).toEqual([]);
    expect(found("It said ‘Payment sent’.", ["Payment sent"])).toEqual([]);
  });

  it("skips an empty quote rather than failing the whole answer", () => {
    expect(found("状态：已发送。", ["已发送"])).toEqual([]);
    expect(found("「」状态：已发送。", ["已发送"])).toEqual([]);
  });

  it("is known when the task prompt already said it", () => {
    expect(found("已发送「早上好」。", ["阿明"], "给阿明发「早上好」")).toEqual([]);
  });

  it("is matched with punctuation and spacing folded", () => {
    expect(found("「已发送，上午好」", ["已发送, 上午好"])).toEqual([]);
  });

  it("matches a quote split with … when every part is on one screen", () => {
    expect(found("「订单号 2026102312345…已发货」", ["订单号 2026102312345\n已发货"])).toEqual([]);
    // The parts must meet in one source: two sources that each hold half the quotation do not make it whole.
    expect(found("「订单号 2026102312345…已发货」", ["订单号 2026102312345", "已发货"]))
      .toEqual(["订单号 2026102312345...已发货"]);
  });
});

describe("numbers", () => {
  it("leaves integers of two digits or fewer, with no unit, unchecked", () => {
    expect(found("3 条未读，第 2 个。", ["随便什么"])).toEqual([]);
  });

  it("checks a number with a unit, a currency, a percent or a magnitude", () => {
    expect(found("共 128 元。", ["共 128 元"])).toEqual([]);
    expect(found("共 129 元。", ["共 128 元"])).toEqual(["129"]);
    expect(found("温度 26°", ["26°"])).toEqual([]);
    expect(found("完成 87%", ["87%"])).toEqual([]);
    expect(found("涨了 1561 万热度", ["热度 1561 万"])).toEqual([]);
    expect(found("涨了 1562 万热度", ["热度 1561 万"])).toEqual(["1562万"]);
  });

  it("folds 万 and 亿 to the same value as the plain number", () => {
    expect(found("5.3万粉丝", ["53000 粉丝"])).toEqual([]);
    expect(found("1.2亿", ["120000000"])).toEqual([]);
    expect(found("1.2亿", ["12000000"])).toEqual(["1.2亿"]);
  });

  it("keeps 千 as a unit inside 千米 and 千克, not a magnitude", () => {
    expect(found("跑了 3 千米", ["3 千米"])).toEqual([]);
    expect(found("重 5 千克", ["5 千克"])).toEqual([]);
    // 千 here is part of a unit, so the number carries no magnitude: the claim is just the number.
    expect(found("跑了 3 千米", ["无关的屏幕"])).toEqual(["3"]);
  });

  it("checks decimals and integers of three or more digits", () => {
    expect(found("评分 4.8", ["4.8"])).toEqual([]);
    expect(found("评分 4.9", ["4.8"])).toEqual(["4.9"]);
    expect(found("共 1234 条", ["共 1234 条"])).toEqual([]);
    expect(found("共 1235 条", ["共 1234 条"])).toEqual(["1235"]);
  });

  it("folds thousands separators, full-width digits and zero-width characters", () => {
    expect(found("收入 1,234", ["收入 1234"])).toEqual([]);
    expect(found("收入 １２３４", ["收入 1234"])).toEqual([]);
    expect(found("收入 12\u200B34", ["收入 1234"])).toEqual([]);
  });

  it("counts a number the task prompt gave as known", () => {
    expect(found("已设 1500 元", ["余额 3000 元"], "转 1500 元")).toEqual([]);
  });

  it("needs the number to be a whole word on the screen", () => {
    expect(found("共 128 元", ["订单 A128B 元"])).toEqual(["128"]);
    expect(found("共 128 元", ["共 128GB 元"])).toEqual([]);
  });
  it("checks a two-digit number once it carries a unit", () => {
    expect(found("共 45 元", ["共 45 元"])).toEqual([]);
    expect(found("共 46 元", ["共 45 元"])).toEqual(["46"]);
    // Mika's unit table holds SI symbols, not English words: "minutes" does not make 45 a value.
    expect(found("took 46 km", ["took 45 km"])).toEqual(["46"]);
  });

  it("checks a percentage in either script", () => {
    expect(found("上涨 8.5%", ["上涨 8.5%"])).toEqual([]);
    expect(found("上涨 8.6%", ["上涨 8.5%"])).toEqual(["8.6"]);
  });

  it("checks a number glued to a Latin unit", () => {
    expect(found("剩余 128GB", ["剩余 128GB"])).toEqual([]);
    expect(found("剩余 256GB", ["剩余 128GB"])).toEqual(["256"]);
  });
});

describe("ids, dates and times", () => {
  it("checks an id embedded in letters as one token", () => {
    expect(found("提交 A3F899C 成功", ["提交 A3F899C 成功"])).toEqual([]);
    expect(found("提交 A3F899D 成功", ["提交 A3F899C 成功"])).toEqual(["A3F899D"]);
  });

  it("checks dates and times", () => {
    expect(found("定在 10月23日", ["10月23日 开会"])).toEqual([]);
    expect(found("定在 10月24日", ["10月23日 开会"])).toEqual(["10月24日"]);
    expect(found("定在 2026-10-23", ["2026-10-23 开会"])).toEqual([]);
    expect(found("14:05 提醒你", ["14:05 提醒"])).toEqual([]);
    expect(found("14:06 提醒你", ["14:05 提醒"])).toEqual(["14:06"]);
  });

  it("folds the year away when the screen shows only the month and day", () => {
    expect(found("定在 2026年10月23日", ["10月23日 开会"])).toEqual([]);
  });

  it("does not read a decimal as a date", () => {
    expect(found("价格 1561.5", ["价格 1561.5"])).toEqual([]);
  });

  it("checks an English sentence's date and currency", () => {
    expect(found("Paid $1,299 on 2026-10-23.", ["Paid $1,299 on 2026-10-23"])).toEqual([]);
    expect(found("Paid $1,298 on 2026-10-23.", ["Paid $1,299 on 2026-10-23"])).toEqual(["1298"]);
  });
});

describe("ordinals are not values", () => {
  it("leaves 第N条 / 前N / Top N / No.N / #N and list numbers unchecked", () => {
    expect(found("第3条、前2名、Top 5、No.7、#12", ["无关的屏幕"])).toEqual([]);
    expect(found("1. 打开设置\n2、点开蓝牙", ["无关的屏幕"])).toEqual([]);
    expect(found("（3）确认", ["无关的屏幕"])).toEqual([]);
  });

  it("still checks 第2026届, which is a value", () => {
    expect(found("第2026届", ["无关的屏幕"])).toEqual(["2026"]);
  });

  it("leaves a leading number followed by a name unchecked, but keeps a leading number with a unit", () => {
    expect(found("5 千与千寻", ["无关的屏幕"])).toEqual([]);
    expect(found("5 公里", ["无关的屏幕"])).toEqual(["5"]);
  });

  it("keeps the rest of a line that begins with a list number", () => {
    expect(found("1. 共 128 元", ["无关的屏幕"])).toEqual(["128"]);
  });

  it("exports its tables", () => {
    expect(ORDINAL).toBeInstanceOf(RegExp);
    expect(DATE).toBeInstanceOf(RegExp);
    expect(UNIT_AFTER.test("%")).toBe(true);
    expect(UNIT_AFTER.test("个")).toBe(false);
  });
});

describe("the 依据: section", () => {
  it("checks only its quotations, not its sources and times", () => {
    expect(found("已发送。\n依据:微信读取时间 2026-10-23 14:05，来源 https://example.test/a", ["已发送"])).toEqual([]);
  });

  it("still fails when a quotation in it is not on any screen", () => {
    expect(found("已发送。\n依据:「已发送」", ["未发送"])).toEqual(["已发送"]);
  });

  it("locates a screen line through a fragment of it", () => {
    const result = checkGrounding("已发送。\n依据:聊天窗口显示发送成功", ["聊天窗口\n发送成功"]);
    expect(result.located).toBe(true);
    expect(result.found).toBe(true);
  });

  it("reports nothing to check when the answer has no facts", () => {
    const result = checkGrounding("已打开蓝牙。", ["蓝牙 已开启"]);
    expect(result.claims).toEqual([]);
    expect(result.found).toBeNull();
  });
});

describe("the evidence and the answer", () => {
  it("treats a 当前 App: line as a header, not as screen text", () => {
    expect(found("在「设置」里", ["当前 App:设置\n蓝牙"])).toEqual(["设置"]);
  });

  it("never joins one answer line with the next", () => {
    expect(found("「已发送」", ["已\n发送"])).toEqual(["已发送"]);
  });

  it("does not join evidence lines either", () => {
    expect(found("「早上好阿明」", ["早上好\n阿明"])).toEqual(["早上好阿明"]);
  });

  it("strips citation marks and footnotes before comparing", () => {
    expect(found("点 @e46 显示「已发送」[1]", ["已发送"])).toEqual([]);
    expect(found("见【2】「已发送」", ["已发送"])).toEqual([]);
  });

  it("strips markdown emphasis", () => {
    expect(found("**已发送** 到 `微信`", ["已发送 到 微信"])).toEqual([]);
  });

  it("is anchored by a matched claim", () => {
    const result = checkGrounding("「已发送」", ["已发送"]);
    expect(result.anchored).toBe(true);
    expect(result.found).toBe(true);
    expect(result.unmatched).toEqual([]);
  });

  it("reads a quotation with a stand-in letter as the answer's own wording, not the screen's", () => {
    expect(found("今日 +2,271 人，即「今日 +N 人」。", ["今日 +2,271 人"])).toEqual([]);
  });
});
