// Adapted from Mika's SensitiveFilter (Apache-2.0).
import { describe, expect, it } from "vitest";

import { hit, SENSITIVE_KINDS } from "./sensitive.ts";

describe("sensitive text gate", () => {
  it("flags a password written with its value, in either order", () => {
    expect(hit("支付密码是123456")).toBe("password");
    expect(hit("门禁口令:8866")).toBe("password");
    expect(hit("123456是我的密码")).toBe("password");
    // A keyword alone is a topic, not a secret.
    expect(hit("用户忘了密码时会找客服")).toBeNull();
  });

  it("flags codes, CVVs and a numeric PIN", () => {
    expect(hit("验证码 4821")).toBe("password");
    expect(hit("信用卡 CVV 是 1234")).toBe("password");
    expect(hit("PIN: 0000")).toBe("password");
    expect(hit("otp 552211")).toBe("password");
  });

  it("reads a code typed with spaces between its digits", () => {
    expect(hit("验证码 1 2 3 4")).toBe("password");
    expect(hit("Passcode: 5 5 2 2 1 1")).toBe("password");
  });

  it("takes full-width digits and letters as the characters they stand for", () => {
    expect(hit("支付密码是１２３４５６")).toBe("password");
    expect(hit("身份证１１０１０５１９４９１２３１００２Ｘ")).toBe("id_number");
  });

  it("wants a whole word for pin and otp, because pinned and hotpot are ordinary words", () => {
    expect(hit("pin this note to the top")).toBeNull();
    expect(hit("PIN: abcd")).toBeNull();
    expect(hit("用户把便签置顶 pinned 了 2024 年的计划")).toBeNull();
    expect(hit("the hotpot place near the office is good")).toBeNull();
  });

  it("flags a mainland ID number only when the birth date and check digit hold", () => {
    expect(hit("我的身份证 11010519491231002X")).toBe("id_number");
    expect(hit("证件号440308199001011239")).toBe("id_number");
    // Check digit wrong, then a thirteenth month.
    expect(hit("单号 440308199001011234")).not.toBe("id_number");
    expect(hit("单号 110105194913310021")).not.toBe("id_number");
  });

  it("flags a card number written as one run or in groups", () => {
    expect(hit("卡号 4111111111111111")).toBe("card_number");
    expect(hit("卡号 4111 1111 1111 1111")).toBe("card_number");
    expect(hit("卡号 4111-1111-1111-1111")).toBe("card_number");
    expect(hit("卡号6222020200112233446")).toBe("card_number");
    // Same length, failing Luhn: an order number, not a card.
    expect(hit("订单号 4111111111111112")).toBeNull();
  });

  it("flags a credential shape as an API key", () => {
    expect(hit(`key 是 sk-${"a1B2c3D4e5F6g7H8i9J0k1L2"}`)).toBe("api_key");
    expect(hit(`the token is ${"ghp_"}${"A".repeat(24)}`)).toBe("api_key");
  });

  it("knows the English variants", () => {
    expect(hit("my password is hunter2")).toBe("password");
    expect(hit("Passcode: 7788")).toBe("password");
    expect(hit("the verification code was 552211")).toBe("password");
    expect(hit("security code 9987")).toBe("password");
  });

  it("leaves the facts a phone bot works from alone", () => {
    expect(hit("我手机号 13800138000")).toBeNull();
    expect(hit("寄到浦东张江路 100 号")).toBeNull();
    expect(hit("用户的妈妈在微信里备注为『老妈』,生日 1960-05-01")).toBeNull();
    expect(hit("The person's birthday is 1960-05-01 and they take the 8:15 train")).toBeNull();
  });

  it("names its kinds in one list", () => {
    expect(SENSITIVE_KINDS).toEqual(["api_key", "id_number", "card_number", "password"]);
  });
});
