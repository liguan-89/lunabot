// The brief is a widget the server writes, so its words come from here in the language set in Settings, not from the app's packs.
import { byLanguage } from "../language.ts";

type Count = (count: number) => string;
type Name = (name: string) => string;
type Pair = (first: string, second: string) => string;

export interface BriefWords {
  title: string;
  intro: string;
  needsYou: string;
  nothingNeedsYou: string;
  yourDay: string;
  noMoreMeetings: string;
  importantEmails: string;
  routines: string;
  open: string;
  join: string;
  openInGmail: string;
  draftReply: Name;
  dismiss: Name;
  waitingOnReply: string;
  important: string;
  noSender: string;
  noSubject: string;
  more: Count;
  waitingMany: string;
  waitingCount: Count;
  summary: { needs: Count; meetings: Count; emails: Count; routines: Count; ideas: Count; nothing: string };
  finished: string;
  failed: Name;
  missed: Name;
  didNotFinish: string;
  signedOut: Name;
  signInAgain: string;
  usageLimit: string;
  outOfCredit: string;
  ownAccount: string;
  reconnecting: Name;
  unreachable: string;
  chooseAnother: string;
  asked: Name;
  aBot: string;
  overlap: Pair;
  both: Pair;
  couldNotRead: Name;
  reconnect: Name;
  tryAgainSoon: string;
  unsorted: string;
  unsortedNote: Name;
  openPage: string;
  unpreparedMeetings: string;
  unpreparedNote: Name;
  isAsking: Name;
  ideas: string;
  noticedAcross: Count;
}

const en: BriefWords = {
  title: "Your brief",
  intro: "I keep an eye on your calendar and email and put what needs you here, once a day and when you come back. Tell me to stop, or what to watch for.",
  needsYou: "Needs you",
  nothingNeedsYou: "Nothing needs you right now.",
  yourDay: "Your day",
  noMoreMeetings: "No more meetings today.",
  importantEmails: "Important emails",
  routines: "Routines",
  open: "Open",
  join: "Join",
  openInGmail: "Open in Gmail",
  draftReply: (who) => `Draft a reply to ${who}`,
  dismiss: (who) => `Dismiss ${who}'s email`,
  waitingOnReply: "Waiting on your reply",
  important: "Important",
  noSender: "(no sender)",
  noSubject: "(no subject)",
  more: (n) => `and ${n} more`,
  waitingMany: "More new emails than one check reads; I'll sort the rest next.",
  waitingCount: (n) => `${n} more new email${n === 1 ? "" : "s"} since you were away; I'll sort them next.`,
  summary: {
    needs: (n) => `${n} ${n === 1 ? "needs" : "need"} you`,
    meetings: (n) => `${n} meeting${n === 1 ? "" : "s"}`,
    emails: (n) => `${n} important email${n === 1 ? "" : "s"}`,
    routines: (n) => `${n} routine result${n === 1 ? "" : "s"}`,
    ideas: (n) => `${n} idea${n === 1 ? "" : "s"}`,
    nothing: "nothing needs you right now",
  },
  finished: "Finished",
  failed: (name) => `${name} failed`,
  missed: (name) => `${name} was missed`,
  didNotFinish: "It did not finish",
  signedOut: (engine) => `${engine} is signed out`,
  signInAgain: "Sign in again in Settings, Model providers.",
  usageLimit: "An AI reached its usage limit",
  outOfCredit: "The trial credit can't run this",
  ownAccount: "Sign in with your own AI account, or add a key.",
  reconnecting: (app) => `${app} needs reconnecting`,
  unreachable: "A bot couldn't reach its computer",
  chooseAnother: "Open it to choose another place.",
  asked: (bot) => `${bot} asked you`,
  aBot: "A bot",
  overlap: (a, b) => `${a} and ${b} overlap`,
  both: (a, b) => `${a} and ${b}`,
  couldNotRead: (app) => `Couldn't read ${app}`,
  reconnect: (app) => `Reconnect ${app} in Connected apps.`,
  tryAgainSoon: "I'll try again soon.",
  unsorted: "I didn't sort email or prepare meetings",
  unsortedNote: (name) => `That needs a Claude model as ${name}'s AI. Your day, reminders and clashes still show here.`,
  openPage: "Open page",
  unpreparedMeetings: "I didn't prepare meetings",
  unpreparedNote: (name) => `That needs a Claude model as ${name}'s AI. Your email is still sorted, and your day, reminders and clashes show here.`,
  isAsking: (bot) => `${bot} is asking you`,
  ideas: "Ideas",
  noticedAcross: (n) => `Noticed across ${n} chats`,
};






const zh: BriefWords = {
  title: "你的简报",
  intro: "我会留意你的日历和邮箱，把需要你处理的内容放在这里，每天一次，也在你回来时更新。你可以叫我停止，或告诉我关注什么。",
  needsYou: "需要你处理",
  nothingNeedsYou: "现在没有需要你处理的内容。",
  yourDay: "今日日程",
  noMoreMeetings: "今天没有其他会议了。",
  importantEmails: "重要邮件",
  routines: "例行任务",
  open: "打开",
  join: "加入",
  openInGmail: "在 Gmail 中打开",
  draftReply: (who) => `为 ${who} 起草回复`,
  dismiss: (who) => `忽略 ${who} 的邮件`,
  waitingOnReply: "等待你回复",
  important: "重要",
  noSender: "（无发件人）",
  noSubject: "（无主题）",
  more: (n) => `还有 ${n} 项`,
  waitingMany: "新邮件多过一次检查能读取的数量；余下的我下次整理。",
  waitingCount: (n) => `你离开后还有 ${n} 封新邮件；我接下来会整理它们。`,
  summary: {
    needs: (n) => `${n} 项需要你处理`,
    meetings: (n) => `${n} 个会议`,
    emails: (n) => `${n} 封重要邮件`,
    routines: (n) => `${n} 个例行任务结果`,
    ideas: (n) => `${n} 个想法`,
    nothing: "目前没有需要你处理的事",
  },
  finished: "已完成",
  failed: (name) => `${name} 失败了`,
  missed: (name) => `${name} 未执行`,
  didNotFinish: "它没有完成",
  signedOut: (engine) => `${engine} 已退出登录`,
  signInAgain: "请在设置的「模型提供方」中重新登录。",
  usageLimit: "某个 AI 已达到使用上限",
  outOfCredit: "试用额度无法运行此任务",
  ownAccount: "请用你自己的 AI 账号登录，或添加密钥。",
  reconnecting: (app) => `${app} 需要重新连接`,
  unreachable: "某个机器人无法连接到它的电脑",
  chooseAnother: "打开它以选择其他位置。",
  asked: (bot) => `${bot} 向你提了一个问题`,
  aBot: "某个机器人",
  overlap: (a, b) => `${a} 与 ${b} 时间重叠`,
  both: (a, b) => `${a} 和 ${b}`,
  couldNotRead: (app) => `无法读取 ${app}`,
  reconnect: (app) => `请在已连接应用中重新连接 ${app}。`,
  tryAgainSoon: "我很快会再试一次。",
  unsorted: "我没有整理邮件或准备会议",
  unsortedNote: (name) => `这需要 Claude 模型作为 ${name} 的 AI。你的一天、提醒和冲突仍会显示在这里。`,
  openPage: "打开页面",
  unpreparedMeetings: "我没有准备会议",
  unpreparedNote: (name) => `这需要 Claude 模型作为 ${name} 的 AI。你的邮件仍会整理，你的一天、提醒和冲突也会显示在这里。`,
  isAsking: (bot) => `${bot} 正在向你提问`,
  ideas: "想法",
  noticedAcross: (n) => `在 ${n} 个聊天中发现`,
};




const WORDS = { en, zh };

export const ENGLISH_BRIEF: BriefWords = en;
export const briefWords = (language: string | undefined): BriefWords => byLanguage(WORDS, language);