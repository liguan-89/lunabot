import { redactSecretsInText } from "../../shared/redact.ts";
import type { PhoneToolName } from "../../shared/phone-apps.ts";
import { CHAT_NOTICE, noticeSummary, type ChatNoticeKey } from "../chat-notices.ts";
import { describeAction } from "./access.ts";

const WRITES = new Set<PhoneToolName>([
  "PHONE_CREATE_EVENT", "PHONE_UPDATE_EVENT", "PHONE_DELETE_EVENT", "PHONE_RESPOND_TO_INVITE",
  "PHONE_CREATE_REMINDER", "PHONE_UPDATE_REMINDER", "PHONE_COMPLETE_REMINDER", "PHONE_DELETE_REMINDER",
  "PHONE_CREATE_CONTACT", "PHONE_UPDATE_CONTACT", "PHONE_SET_ACCESSORY", "PHONE_RUN_SCENE", "PHONE_SEND_MESSAGE", "PHONE_SEND_WHATSAPP",
  "PHONE_UI_LAUNCH", "PHONE_UI_TAP", "PHONE_UI_TYPE", "PHONE_UI_SCROLL", "PHONE_UI_BACK", "PHONE_UI_RUN", "PHONE_UI_COLLECT",
  "PHONE_UI_FIND", "PHONE_SET_ALARM", "PHONE_SET_TIMER", "PHONE_OPEN_LINK", "PHONE_SHARE_TEXT", "PHONE_UI_AFTER_TASK",
]);

export function phoneWriteSummary(name: PhoneToolName, phone: string): { summary: string; summaryCode?: ChatNoticeKey; summaryParams?: Record<string, string> } {
  const action = describeAction(name);
  const key = `chat.notice.phone.write.${name}` as ChatNoticeKey;
  // A write the packs have no words for yet still shows its action, rather than throwing.
  if (!WRITES.has(name) || !Object.hasOwn(CHAT_NOTICE, key)) return { summary: `${action} on ${phone}`.slice(0, 240) };
  return noticeSummary(key, { phone: redactSecretsInText(phone).slice(0, Math.max(0, 240 - action.length - " on ".length)) });
}
