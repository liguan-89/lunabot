/** Words another app shows in the person's own language, for each language this app ships its interface in. A word
 * names a whole word or phrase; `word*` also matches longer words that start with it; `=word` matches only a label that
 * is exactly that. Languages written without spaces match anywhere in the label. */
export interface LanguageWords { words: readonly string[]; unspaced?: true }

/** Security invariant: steps that press one of these (send, delete, buy, pay, post, submit, order, transfer, publish and
 * their like) are never saved, so that request always goes to the AI. */
export const FINAL_ACTIONS: Readonly<Record<string, LanguageWords>> = {
  en: { words: ["send", "resend", "paperplane", "delete", "trash", "erase", "remove", "discard", "empty bin", "move to bin", "don't save", "do not save",
    "buy", "purchase", "checkout", "check out", "subscribe", "unsubscribe", "pay", "place order", "place your order", "order now", "book now", "reserve", "donate",
    "post", "publish", "tweet", "share", "reply", "comment", "submit", "confirm", "transfer", "withdraw", "upload", "approve", "uninstall", "reset", "shut down", "restart"] },
  zh: { unspaced: true, words: ["发送", "删除", "抹掉", "移除", "清除", "丢弃", "放弃", "清倒废纸篓", "清空废纸篓", "清空回收站", "移到废纸篓", "不存储", "不保存", "购买",
    "结算", "结账", "下单", "支付", "付款", "预订", "预约", "捐款", "捐赠", "订阅", "退订", "发布", "发表", "分享", "共享", "回复", "评论", "提交", "确认", "转账",
    "转帐", "汇款", "提现", "上传", "批准", "卸载", "重置", "关机", "重新启动", "重启", "转发"] },
};

/** Security invariant: a field labelled with one of these holds a secret, and a step on it is never saved. */
export const SECRET_FIELDS: Readonly<Record<string, LanguageWords>> = {
  en: { words: ["password", "passcode", "passphrase", "pin", "pin code", "security code", "verification code", "one-time code", "otp", "cvv", "cvc",
    "card number", "credit card", "api key", "secret", "private key", "recovery key", "recovery phrase", "seed phrase", "social security"] },
  zh: { unspaced: true, words: ["密码", "口令", "安全码", "验证码", "卡号", "信用卡"] },
};

const QUOTES = /[‘’ʼ`´]/g;

/** Case, Unicode forms, Turkish dots, curly apostrophes, dashes and spacing evened out, the same way for words and labels. */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/̇/g, "").replace(/ı/g, "i").replace(QUOTES, "'").replace(/\p{Pd}/gu, "-").replace(/\s+/g, " ").trim();
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EDGE = String.raw`[\p{L}\p{M}\p{N}]`;

function matcher(table: Readonly<Record<string, LanguageWords>>): (text: string | undefined) => boolean {
  const exact = new Set<string>();
  const whole: string[] = [];
  const starts: string[] = [];
  const inside: string[] = [];
  for (const { words, unspaced } of Object.values(table)) {
    for (const word of words) {
      if (word.startsWith("=")) exact.add(fold(word.slice(1)));
      else if (unspaced) inside.push(escaped(fold(word)));
      else if (word.endsWith("*")) starts.push(escaped(fold(word.slice(0, -1))));
      else whole.push(escaped(fold(word)));
    }
  }
  const pattern = new RegExp([
    whole.length ? `(?<!${EDGE})(?:${whole.join("|")})(?!${EDGE})` : "",
    starts.length ? `(?<!${EDGE})(?:${starts.join("|")})` : "",
    inside.length ? `(?:${inside.join("|")})` : "",
  ].filter(Boolean).join("|") || "(?!)", "u");
  return (text) => {
    if (!text) return false;
    const folded = fold(text);
    return exact.has(folded) || pattern.test(folded);
  };
}

/** True when a label or title names a final, can't-undo action in any language this app ships. */
export const namesFinalAction = matcher(FINAL_ACTIONS);

/** True when a field's label says it holds a password, PIN, code or card number in any language this app ships. */
export const namesSecret = matcher(SECRET_FIELDS);
