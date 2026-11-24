import { describe, expect, it } from "vitest";
import { namesFinalAction, namesSecret } from "./screen-words.ts";

describe("screen words", () => {
  it.each<[string, string[]]>([
    ["en", ["Send", "Send Message", "Delete Forever", "Buy now", "Pay", "Place your order", "Post", "Publish", "Submit", "Transfer", "Don’t Save", "Empty Trash", "Move to Trash", "paperplane.fill"]],
    ["zh", ["发送", "删除", "立即购买", "支付", "提交订单", "发布", "转账", "不存储", "清倒废纸篓"]],
  ])("name a final action in %s", (_, labels) => {
    for (const label of labels) expect(namesFinalAction(label), label).toBe(true);
  });

  it("leave everyday labels alone, in many languages", () => {
    for (const label of ["Inbox", "Sent", "Sender", "Deleted Items", "Drafts", "Open", "Save", "Cancel", "OK", "Settings", "PayPal", "Gesendet", "Speichern",
      "Envoyés", "Enregistrer", "Enviados", "Guardar", "Inviati", "Salva", "Wysłane", "Отправленные", "Сохранить", "Надіслані", "Gönderilenler", "Kaydet",
      "Lưu", "Đăng nhập", "सहेजें", "保存", "受信", "收件箱", "收件匣", "받은 편지함", "보낸 편지함", "저장", "취소", "확인", "열기", "설정", "", undefined]) {
      expect(namesFinalAction(label), String(label)).toBe(false);
    }
  });

  it("know a secret field in each language", () => {
    for (const label of ["Password", "Enter your PIN", "One‑time code", "密码", "验证码"]) {
      expect(namesSecret(label), label).toBe(true);
    }
    for (const label of ["Username", "Email", "Search", "Pinned", "Shopping list", "Benutzername", "Notes", ""]) {
      expect(namesSecret(label), label).toBe(false);
    }
  });

  it("read labels in any case, Unicode form or spacing", () => {
    for (const label of ["DELETE", "  send  ", "ｓｅｎｄ", "Delete…", "Send—now"]) expect(namesFinalAction(label), label).toBe(true);
  });
});
