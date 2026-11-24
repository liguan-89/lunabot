import { byLanguage } from "./language.ts";
import { greetingName } from "../shared/greeting-name.ts";

type Greeting = (name: string, person?: string) => string;

/** The first bot's seeded line is created by the server before the UI exists. */
const GREETINGS: { en: Greeting } & Record<string, Greeting> = {
  en: (name, person) => `Hi${person ? ` ${person}` : ""}, I'm ${name}. What would you like me to do?`,
  zh: (name, person) => `嗨${person ? ` ${person}` : ""}，我是 ${name}。你想让我做什么？`,
};

/** What the bot says the moment Set me up is pressed: no model is asked, so it is written here. */
const SETUP_REQUEST_LINES: { en: string } & Record<string, string> = {
  en: "Great. Tell me what you'd like help with, in your own words, and I'll set myself up for it. For example: \"sort my inbox every morning\" or \"research our competitors every week\".",
  zh: "好的。用你自己的话告诉我你想让我帮什么忙，我会照此设置好自己。例如：“每天早上整理我的收件箱”或“每周研究我们的竞争对手”。",
};

/** The answers a blank bot's greeting offers on its setup card. Picking one sets the bot up for its words, as
 * `/setup <words>` would; the client sends the words, never a position, so these may change freely. */
const SETUP_CHOICES: { en: readonly string[] } & Record<string, readonly string[]> = {
  en: ["Research and digging into topics", "Keeping an eye on things for me", "Email, calendar and messages",
    "Bookings, shopping and errands", "Data, spreadsheets and reports"],
  zh: ["调研和深挖各种主题", "帮我盯着一些事情", "邮件、日历和消息",
    "预订、购物和跑腿", "数据、表格和报告"],
};

export function setupChoices(language?: string): string[] {
  return [...byLanguage(SETUP_CHOICES, language)];
}

/** The fixed answers exist in this language, not only the English stand-in. */
export function hasSetupChoices(language?: string): boolean {
  return byLanguage(SETUP_CHOICES, language) !== SETUP_CHOICES.en || /^en(?:-|$)/i.test(language?.trim() || "en");
}

/** `person`: the name the person gave, greeted by greetingName; absent or blank, the greeting names no one. */
export function initialGreeting(name: string, language?: string, person?: string): string {
  return byLanguage(GREETINGS, language)(name, greetingName(person) || undefined);
}

export function setupRequestLine(language?: string): string {
  return byLanguage(SETUP_REQUEST_LINES, language);
}

/** The seeded message; a function language is read now, so a language changed in Settings reaches the next new bot.
 * `offerSetup`: the bot has no role or instructions yet, so its greeting carries the setup card and its answers. */
export function initialGreetingMessage(name: string, language: string | (() => string), offerSetup = false, person?: string) {
  const spoken = typeof language === "function" ? language() : language;
  const text = initialGreeting(name, spoken, person);
  return { role: "bot", kind: "text", text, ...(offerSetup ? { setupOffer: true as const, setupChoices: setupChoices(spoken) } : {}) } as const;
}
