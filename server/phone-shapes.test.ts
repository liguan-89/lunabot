import { describe, expect, it } from "vitest";

import { shapeNotice } from "./phone-shapes.ts";
import type { NoticeMessage, NoticeRecord } from "./phone-notices.ts";

const record = (key: string, overrides: Partial<NoticeRecord> = {}): NoticeRecord => ({
  key,
  packageName: "com.chat",
  postedAtMs: 1,
  title: "t",
  text: `text ${key}`,
  ...overrides,
});

const msg = (sender: string | null, text: string): NoticeMessage => ({ sender, text, atMs: 1 });

describe("shapeNotice", () => {
  it("reads a MessagingStyle notice by the system's conversation name and speaker", () => {
    const styled = (title: string, conv: string | null, group: boolean | null) =>
      shapeNotice(record("k", {
        packageName: "org.chat.any",
        title,
        text: "那句话",
        messages: [msg("张三", "那句话")],
        conversation: true,
        group,
        conversationTitle: conv,
      }));
    const a = styled("周末爬山群: 张三", "周末爬山群", true);
    const b = styled("周末爬山群：李四", "周末爬山群", true);
    expect(a.title).toBe("周末爬山群");
    expect(b.title).toBe("周末爬山群");
    expect(a.group).toBe(true);
    expect(a.sender).toBe("张三");
    expect(b.sender).toBe("李四");
    // 系统没说是不是群:有会话名就当群
    expect(styled("周末爬山群: 张三", "周末爬山群", null).group).toBe(true);
    // 发言人就是会话名的(以对方的名字当会话名的私聊):不另记
    expect(styled("张三: 张三", "张三", false).sender).toBeNull();
    // 系统说不是群、却有会话名:看不出来,不硬说是私聊
    const unsure = styled("备注名: 张三", "备注名", false);
    expect(unsure.group).toBeNull();
    expect(unsure.title).toBe("备注名");
    // 群聊却没有会话名:标题是发言人,记上一笔;标题不动
    const nameless = styled("张三", null, true);
    expect(nameless.title).toBe("张三");
    expect(nameless.titleIsSpeaker).toBe(true);
    expect(nameless.group).toBe(true);
    // 私聊:没有会话名,标题就是对方,原样
    const p = styled("张三", null, false);
    expect(p.title).toBe("张三");
    expect(p.group).toBe(false);
    expect(p.titleIsSpeaker).toBeUndefined();
  });

  it("splits the QQ 「群名(13条新消息)」 + 「某人: 那句话」 shape", () => {
    for (const title of ["三年2班家长群(13条新消息)", "三年2班家长群", "三年2班家长群 (99条以上新消息)"]) {
      const shaped = shapeNotice(record("k", { packageName: "com.tencent.mobileqq", title, text: "王老师: 明天下午三点开家长会" }));
      expect(shaped.title).toBe("三年2班家长群");
      expect(shaped.sender).toBe("王老师");
      expect(shaped.text).toBe("明天下午三点开家长会");
      expect(shaped.group).toBe(true);
    }
    expect(shapeNotice(record("k", { packageName: "com.tencent.tim", title: "家长群(2条新消息)", text: "王老师: 好的" })).sender).toBe("王老师");
  });

  it("reads a QQ private chat: no 「某人: 」 prefix means the title is the person", () => {
    const shaped = shapeNotice(record("k", { packageName: "com.tencent.mobileqq", title: "张三(2条新消息)", text: "明天来吗" }));
    expect(shaped.title).toBe("张三");
    expect(shaped.sender).toBeNull();
    expect(shaped.text).toBe("明天来吗");
    expect(shaped.group).toBe(false);
    // 正文带着的名字就是标题的,也是私聊
    const same = shapeNotice(record("k", { packageName: "com.tencent.mobileqq", title: "张三", text: "张三: 明天来吗" }));
    expect(same.sender).toBeNull();
    expect(same.text).toBe("明天来吗");
    expect(same.group).toBe(false);
  });

  it("splits the WeChat 「[3条]某人: 那句话」 shape", () => {
    const priv = shapeNotice(record("k", { packageName: "com.tencent.mm", title: "张三", text: "[3条]张三: 明天来吗" }));
    expect(priv.title).toBe("张三");
    expect(priv.sender).toBeNull();
    expect(priv.text).toBe("明天来吗");
    expect(priv.group).toBe(false);
    const group = shapeNotice(record("k", { packageName: "com.tencent.mm", title: "家长群", text: "[12条]王老师: 明天开会" }));
    expect(group.sender).toBe("王老师");
    expect(group.text).toBe("明天开会");
    expect(group.group).toBe(true);
    // 没有「某人: 」的(看不出是不是群):只去掉条数,别的不动
    const plain = shapeNotice(record("k", { packageName: "com.tencent.mm", title: "微信支付", text: "[2条]你有一笔新的收款" }));
    expect(plain.text).toBe("你有一笔新的收款");
    expect(plain.sender).toBeNull();
    expect(plain.group).toBeNull();
  });

  it("leaves text that is not someone saying something alone", () => {
    for (const text of ["x".repeat(41) + ": 你好", "网址 http://a.b: 看看", "时间:明天", "王老师: ", "只有一句话"]) {
      const shaped = shapeNotice(record("k", { packageName: "com.tencent.mobileqq", title: "家长群", text }));
      expect(shaped.text.trim(), text).toBe(text.trim());
      expect(shaped.sender, text).toBeNull();
    }
  });

  it("leaves other apps and unstyled notices untouched", () => {
    const other = record("k", { packageName: "com.shop", title: "订单(2条新消息)", text: "客服: 已发货" });
    expect(shapeNotice(other)).toBe(other);
    const styled = record("k", {
      packageName: "com.tencent.mobileqq",
      title: "群(2条新消息)",
      text: "甲: 乙",
      messages: [msg("甲", "乙")],
      conversation: true,
    });
    // 带会话样式但没有会话名、系统也没说群:原样
    expect(shapeNotice(styled)).toBe(styled);
  });
});
