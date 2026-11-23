// The lines the Chief says in a new Cloud's first hour and in the recap after it. The server writes these messages, so
// their words come from here in the person's language, not from the app's packs.
import { byLanguage } from "../language.ts";

type Count = (n: number) => string;

export interface FirstHourWords {
  greeting(name: string | undefined, bot: string): string;
  /** The connect offer, with why: the cards for Gmail and Google Calendar follow it. */
  connect: string;
  /** An app came in but the first look could not run. */
  connected: string;
  briefOn: string;
  phoneTitle: string;
  phoneBody: string;
  phoneButton: string;
  firstLookReady: string;
  firstBriefReady: string;
  sorted: Count;
  drafted: Count;
  prepped: Count;
  routines: Count;
  list(items: readonly string[]): string;
  time(minutes: number): string;
  recap(done: string, time: string): string;
  overnight(done: string): string;
}

/** Rounded the way a person says it: five-minute steps under an hour, "an hour" up to 90 minutes, whole hours after. */
export function roundedTime(minutes: number): { unit: "minutes" | "hours"; n: number } {
  const fives = Math.max(5, Math.round(minutes / 5) * 5);
  if (fives < 60) return { unit: "minutes", n: fives };
  return { unit: "hours", n: minutes < 90 ? 1 : Math.round(minutes / 60) };
}

const joined = (items: readonly string[], and: string, comma = ", "): string =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(comma)}${and}${items.at(-1)}`;

const en: FirstHourWords = {
  greeting: (name, bot) => `Hi${name ? ` ${name}` : ""}! I'm ${bot}, your Chief of Staff. I live on the Cloud, so I keep working while your computer is off. What do you want off your plate?`,
  connect: "So I can see what needs you today, connect Gmail and Google Calendar. It's one sign-in each. I only read and write drafts: nothing is sent, accepted or deleted without you.",
  connected: "You're connected. I couldn't take a first look just now; I'll keep an eye on it and tell you when something needs you.",
  briefOn: "Every morning at 8 I'll send you a brief of what needs you.",
  phoneTitle: "Get me on your phone",
  phoneBody: "Your morning brief and anything that needs you will reach you there.",
  phoneButton: "Connect your phone",
  firstLookReady: "Your first look is ready",
  firstBriefReady: "Your first brief is ready",
  sorted: (n) => `sorted ${n} email${n === 1 ? "" : "s"}`,
  drafted: (n) => `drafted ${n} repl${n === 1 ? "y" : "ies"}`,
  prepped: (n) => `prepped ${n} meeting${n === 1 ? "" : "s"}`,
  routines: (n) => `ran ${n} routine${n === 1 ? "" : "s"}`,
  list: (items) => joined(items, " and "),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `about ${n} minutes` : n === 1 ? "about an hour" : `about ${n} hours`; },
  recap: (done, time) => `So far I've ${done}: ${time} back.`,
  overnight: (done) => `While you slept, I ${done}.`,
};








const zh: FirstHourWords = {
  greeting: (name, bot) => `你好${name ? `，${name}` : ""}！我是 ${bot}，你的 Luna。我在你的 Cloud 上，所以电脑关机时我也在工作。你想让我帮你分担什么？`,
  connect: "为了看清今天有哪些事需要你，请连接 Gmail 和 Google 日历。各登录一次即可。我只读取内容并写草稿：没有你的同意，不会发送、接受或删除任何东西。",
  connected: "已连接。我刚才没能完成第一份概览；我会继续留意，有需要你处理的事会告诉你。",
  briefOn: "每天早上 8 点，我会给你发一份需要你处理的事项简报。",
  phoneTitle: "在手机上用我",
  phoneBody: "早间简报和需要你处理的事都会发到手机上。",
  phoneButton: "连接你的手机",
  firstLookReady: "你的第一份概览已准备好",
  firstBriefReady: "你的第一份简报已准备好",
  sorted: (n) => `整理了 ${n} 封邮件`,
  drafted: (n) => `起草了 ${n} 封回复`,
  prepped: (n) => `准备了 ${n} 场会议`,
  routines: (n) => `运行了 ${n} 个例行任务`,
  list: (items) => items.join("，"),
  time: (minutes) => { const { unit, n } = roundedTime(minutes); return unit === "minutes" ? `大约 ${n} 分钟` : `大约 ${n} 小时`; },
  recap: (done, time) => `到目前为止，我${done}：为你省下${time}。`,
  overnight: (done) => `你睡觉时，我${done}。`,
};



const WORDS = { en, zh };

export const FIRST_HOUR_LANGUAGES = Object.keys(WORDS);
export const firstHourWords = (language: string | undefined): FirstHourWords => byLanguage(WORDS, language);
