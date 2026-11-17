// Adapted from Mika's SensitiveFilter (Apache-2.0).
// The second net over memory and skill drafts: a hit means the text is not saved.
// Phone numbers, addresses, birthdays and family terms are deliberately not
// flagged — they are the facts a phone bot works from.

import { redactSecretsInText } from "./redact.ts";

/** What a hit means. The kind alone is safe to report; the matched text never is. */
export const SENSITIVE_KINDS = ["api_key", "id_number", "card_number", "password"] as const;
export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

/** The kinds in words, for a refusal that says what it recognised without repeating it. */
export const SENSITIVE_KIND_LABELS: Record<SensitiveKind, string> = {
  api_key: "an API key or another credential",
  id_number: "an ID number",
  card_number: "a card number",
  password: "a password or one-time code",
};

/** Words that name a secret. The English ones need a letter boundary, so "passwordless" stays out. */
export const KEYWORD_SOURCE =
  "支付密码|密码|口令|验证码|校验码|动态码|安全码|安全问题|" +
  "(?<![A-Za-z])(?:password|passcode|passwd|cvv|cvc|verification code|security code|security question|one-time code)(?![A-Za-z])";

/** These two are ordinary English words (pinned, hotpot), so they count only when digits follow. */
export const DIGIT_KEYWORD_SOURCE = "(?<![A-Za-z])(?:pin|otp)(?![A-Za-z])";

/** Between a keyword and its value: a short link ("是", ":", " is "), never a whole sentence. */
export const GAP_SOURCE = "[\\s:：=,，是为叫]{0,4}(?:(?:is|was|are)\\s+)?";

/** The reversed form: the value first, then "is my password". */
export const OWNER_SOURCE = "\\s*(?:就是|是|为)(?:我的|我|用户的)?\\s*";

/** The four keyword shapes: keyword then value, value then keyword, and the same two for pin/otp. */
export const KEYWORD_RULE_SOURCES = [
  `(?:${KEYWORD_SOURCE})${GAP_SOURCE}[A-Za-z0-9]{4,}`,
  `(?<![A-Za-z0-9])[A-Za-z0-9]{4,}${OWNER_SOURCE}(?:${KEYWORD_SOURCE})`,
  `${DIGIT_KEYWORD_SOURCE}${GAP_SOURCE}[0-9]{4,}`,
  `(?<![A-Za-z0-9])[0-9]{4,}${OWNER_SOURCE}${DIGIT_KEYWORD_SOURCE}`,
] as const;

/** Eighteen digits. The shape is not enough: the birth date and the check digit decide. */
export const ID_NUMBER_SOURCE = "(?<![0-9])[1-9][0-9]{16}[0-9Xx](?![0-9A-Za-z])";

/** Thirteen to nineteen digits, a single space or hyphen between them (a card number is written in groups). */
export const CARD_LIKE_SOURCE = "(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])";

const KEYWORD_RULES = KEYWORD_RULE_SOURCES.map((source) => new RegExp(source, "i"));
const ID_NUMBER = new RegExp(ID_NUMBER_SOURCE, "g");
const CARD_LIKE = new RegExp(CARD_LIKE_SOURCE, "g");
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = "10X98765432";

/** The kind of secret in `text`, or null when there is none to refuse. */
export function hit(text: string): SensitiveKind | null {
  // Full-width digits and letters first; then the keyword rules run again on the
  // text with its whitespace gone ("验证码 1 2 3 4").
  const normalised = text.normalize("NFKC");
  const compact = normalised.replace(/\s+/g, "");
  // The same shapes the transcript scrubber refuses to print are the ones memory must not keep.
  if (redactSecretsInText(normalised) !== normalised) return "api_key";
  for (const match of normalised.matchAll(ID_NUMBER)) if (validId(match[0])) return "id_number";
  for (const match of normalised.matchAll(CARD_LIKE)) if (luhn(match[0].replace(/\D/g, ""))) return "card_number";
  if (KEYWORD_RULES.some((rule) => rule.test(normalised) || rule.test(compact))) return "password";
  return null;
}

/** A real birth date in the middle and the ISO 7064 MOD 11-2 check digit at the end. */
function validId(id: string): boolean {
  const year = Number(id.slice(6, 10));
  const month = Number(id.slice(10, 12));
  const day = Number(id.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day));
  // A date nobody lived: month 13, 30 February.
  if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) sum += (id.charCodeAt(index) - 48) * ID_WEIGHTS[index];
  return ID_CHECK[sum % 11] === id[17].toUpperCase();
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits.charCodeAt(digits.length - 1 - index) - 48;
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
