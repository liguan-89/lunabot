// Notice shapes: a chat notice is read into one shape — `title` is the conversation (a person or a group),
// `sender` is who spoke in a group, `text` is only that line, `group` says which. Adapted from Mika's
// NoticeShapes (Apache-2.0); it runs after sanitizeNotice and before the inbox, so triage, learning and the
// surfaced line all read the same form. ContactIdentity and ContactPool stay unported: contacts are off, so only
// `withoutUnreadCount` comes across for the QQ title.
//
// MessagingStyle notices take the system's own conversation name and speaker, whatever the app. The chat apps whose
// style does not parse get their observed "name: line" shapes split instead — only the ones seen on a real phone;
// guessing on an app whose format was never seen would invent a speaker that is not there, so everything else passes
// through. Of the guesses, QQ private chat and WeChat group were never seen on a device upstream either; a wrong split
// only mislabels that one notice's speaker and chat kind, never its conversation.

import type { NoticeRecord } from "./phone-notices.ts";

const SHAPE_QQ: ReadonlySet<string> = new Set(["com.tencent.mobileqq", "com.tencent.tim", "com.tencent.qqlite", "com.tencent.mobileqqi"]);
const SHAPE_WECHAT = "com.tencent.mm";
/** "某人: 那句话": a speaker name without a colon, at most 40 chars, then the line. */
const SHAPE_SAID = /^([^:：]{1,40}): (.+)$/;
/** WeChat's leading "[3条]" unread count. */
const SHAPE_UNREAD_PREFIX = /^\[[0-9]+条\]\s*/;
/** A trailing "(2条新消息)"/"(99+条以上新消息)" is a count, not part of the name (ContactIdentity.withoutUnreadCount). */
const SHAPE_UNREAD_COUNT = /\s*[(（]\s*[0-9]+\+?\s*条(?:以上)?新消息\s*[)）]$/;

function withoutUnreadCount(title: string): string {
  return title.replace(SHAPE_UNREAD_COUNT, "");
}

/** Mika's NoticeShapes.apply. */
export function shapeNotice(record: NoticeRecord): NoticeRecord {
  if (record.conversation === true || (record.messages?.length ?? 0) > 0) return shapeStyled(record);
  if (SHAPE_QQ.has(record.packageName)) return shapeChat(record, withoutUnreadCount(record.title), record.text, true);
  if (record.packageName === SHAPE_WECHAT) return shapeChat(record, record.title, record.text.replace(SHAPE_UNREAD_PREFIX, ""), false);
  return record;
}

/**
 * A styled notice: the system's conversation name is the title (the raw title
 * is "name: latest speaker"), the speaker suffix becomes `sender`, and a
 * conversation name with no group flag still reads as a group — old writers
 * only set the name for groups. With no conversation name a group notice's
 * title is the latest speaker, which is flagged rather than trusted as a name.
 */
function shapeStyled(record: NoticeRecord): NoticeRecord {
  const name = record.conversationTitle?.trim() ?? "";
  if (name === "") return record.group === true ? { ...record, titleIsSpeaker: true } : record;
  const trimmed = record.title.trim();
  const rest = (trimmed.startsWith(name) ? trimmed.slice(name.length) : trimmed).trimStart();
  const styledSender = record.messages?.at(-1)?.sender?.trim() ?? "";
  const titlePrefix = /^([^:：]{1,40})[:：]\s*.+$/.exec(trimmed)?.[1]?.trim() ?? "";
  const parsed = rest.startsWith(":") || rest.startsWith("：") ? rest.slice(1).trim() : "";
  const speaker = parsed !== "" ? parsed : styledSender !== "" ? styledSender : titlePrefix;
  return {
    ...record,
    title: name,
    sender: speaker !== "" && speaker !== name ? speaker : null,
    group: record.group === false ? null : true,
  };
}

/**
 * A "name: line" body split for the apps whose notifications carry no style:
 * a speaker equal to the title is a private chat, any other speaker is a
 * group member. [privateWithoutPrefix] is QQ's observed shape — a plain body
 * still reads as private there; elsewhere a plain body says nothing.
 */
function shapeChat(record: NoticeRecord, title: string, text: string, privateWithoutPrefix: boolean): NoticeRecord {
  const match = title.trim() === "" ? null : SHAPE_SAID.exec(text);
  const name = match?.[1]?.trim() ?? "";
  if (match === null || name === "") {
    return { ...record, title, text, sender: null, group: privateWithoutPrefix && title.trim() !== "" ? false : null };
  }
  if (name === title.trim()) return { ...record, title, text: match[2]!.trim(), sender: null, group: false };
  return { ...record, title, text: match[2]!.trim(), sender: name, group: true };
}
