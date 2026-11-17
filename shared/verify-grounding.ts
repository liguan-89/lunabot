// Adapted from Mika's Grounding and Verifier (Apache-2.0).
// The model-free backstop over an answer's own words: quoted text, a number with a unit or a magnitude, an id, a date
// or a time must appear in the screen evidence the assistant actually read. It checks only that the string is there,
// not that the value belongs to the thing the answer names: the verifier model judges the second.

export type ClaimKind = "quote" | "number" | "date" | "token";

/** One fact in the answer that a screen could show. */
export interface Claim {
  kind: ClaimKind;
  text: string;
}

export interface GroundingResult {
  /** True when every claim matched, false when one did not, null when the answer held nothing to check. */
  found: boolean | null;
  claims: Claim[];
  /** The claims no evidence source holds. */
  unmatched: Claim[];
  /** At least one claim, or one piece of the 依据: section, matched. */
  anchored: boolean;
  /** The 依据: section pointed at a line the assistant read. */
  located: boolean;
}

/** A unit or quantity word right after a number makes it a value; a count word (个, 条, 次) does not. */
export const UNIT_AFTER =
  /^\s*(?:%|‰|元|块|角|美元|欧元|日元|港元|英镑|℃|°|度|公里|千米|米|厘米|毫米|公斤|千克|斤|克|吨|小时|分钟|秒|毫秒|岁|英寸|寸|折|星|(?:km|cm|mm|kg|mAh|GB|MB|KB|TB|Hz|ms|[kKwWmgGM])(?![A-Za-z]))/u;

export const CURRENCY_BEFORE = /[¥$€£]\s*$/u;

/** The words an ordinal's number may be followed by; 届 is not here, so 第2026届 stays a value. */
export const UNIT_WORDS =
  "公里|千米|米|厘米|毫米|公斤|千克|斤|克|吨|元|块|角|小时|分钟|秒|岁|度|分|人|次|个|条|件|万|亿|千[米克瓦卡帕焦]|[A-Za-z%℃°]";

/**
 * A number that orders things rather than naming a value: 第N条, 前N个, Top N, No.N, #N, a list number at the start of a
 * line, and a leading number followed by a name (「5 千与千寻」). Global: use with replace or matchAll, never test.
 */
export const ORDINAL = new RegExp(
  "第[ \\t]*\\d+[ \\t]*(?=[条个集页项张篇步名位行章节轮次题])"
  + "|前[ \\t]*\\d+[ \\t]*(?=[个条名位项张])"
  + "|[tT][oO][pP][ \\t]*\\d+"
  + "|[nN][oO]\\.[ \\t]*\\d+"
  + "|#\\d+"
  + "|^[ \\t]*\\d+[ \\t]*[.、)）](?!\\d)"
  + "|(?:^|(?<=[「『“\"‘]))[ \\t]*\\d{1,3}[ \\t]*[.、](?!\\d)"
  + "|(?:^|(?<=[「『“\"‘]))[ \\t]*\\d{1,3}[ \\t]+(?=\\p{L})(?!" + UNIT_WORDS + ")",
  "gmu",
);

/** Dates and times. A dotted date needs all three parts, so 1561.5 is not read as one. Global, as above. */
export const DATE =
  /(?<!\d)(?:\d{4}\s*[-/年]\s*\d{1,2}(?:\s*[-/月]\s*\d{1,2}\s*[日号]?)?|\d{4}\.\d{1,2}\.\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?)(?!\d)/gu;

/** 亿 is 10^8, 万 10^4, 千 10^3. */
export const MAGNITUDE = { 亿: 8, 万: 4, 千: 3 } as const;

/** Every kind of quote the answer may use; an empty pair is skipped rather than failing the task. Global. */
export const QUOTED = /「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)"|‘([^’]*)’/gu;

/** The App in front is a header, not something the screen showed. */
export const APP_HEADER = "当前 App:";

/** NFKC turns … into ..., so a quote cut with either is split the same way. */
export const CUT = "...";

const EVIDENCE = /依据\**\s*[:：]/u;
const NUMBER = /(?<!\d)(?<!\d[.,])\d+(?:[.,]\d+)*(?!\d)([ \t]*(?:[亿万]|千(?![米克瓦卡帕焦])))?/gu;
const THOUSANDS = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u;
const DIGITS = /\d+/gu;
const ZERO_WIDTH = /\u200B|\u200C|\u200D|\uFEFF|\u2060/gu;
const MARKUP = /\*\*|__|~~|`/gu;
const FRAGMENT_BREAK = /[^\p{L}]+/gu;
const PIECE_BREAK = /[^\p{L}\p{N}]+/gu;
const REF_CITATION = /[([【]\s*@[ev]\d+(?:\s*[,、]\s*@[ev]\d+)*\s*[)\]】]|(?<![A-Za-z0-9_])@[ev]\d+(?!\d)/gu;
const FOOTNOTE = /\[\^?\d{1,3}\]|【\d{1,3}】/gu;
const ALNUM_RUN = /[A-Za-z0-9]+/gu;
const MIN_FRAGMENT = 4;
const MIN_LINE_IN_BASIS = 2;

/** Two numbers: what was written, and the same value with its 万/亿/千 folded in, when it parses. */
interface Num {
  value: string;
  magnitude: string;
  scaled: string | null;
}

/** A line of evidence, reduced to what comparisons need. */
interface Line {
  text: string;
  nums: Num[];
  digits: string[];
  tokens: Set<string>;
}

/** One number's value with its trailing zeros removed; null when it is not a plain decimal. */
function plain(value: string): string | null {
  if (!/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const [whole = "", frac = ""] = value.split(".");
  const digits = whole.replace(/^0+(?=\d)/u, "");
  const rest = frac.replace(/0+$/u, "");
  return rest ? `${digits}.${rest}` : digits;
}

function magnitudePower(magnitude: string): number | null {
  return magnitude === "亿" ? MAGNITUDE.亿 : magnitude === "万" ? MAGNITUDE.万 : magnitude === "千" ? MAGNITUDE.千 : null;
}

/** 5.3万 and 53000 are the same value; the decimal point moves in the text, so no floating-point error creeps in. */
function scale(value: string, magnitude: string): string | null {
  if (!/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const power = magnitude === "" ? 0 : magnitudePower(magnitude);
  if (power === null) return null;
  const [whole = "", frac = ""] = value.split(".");
  if (frac.length <= power) return plain(whole + frac.padEnd(power, "0"));
  return plain(`${whole}${frac.slice(0, power)}.${frac.slice(power)}`);
}

function num(match: RegExpMatchArray): Num {
  const magnitude = (match[1] ?? "").trim();
  const raw = match[0].slice(0, match[0].length - (match[1]?.length ?? 0));
  const value = THOUSANDS.test(raw) ? raw.replace(/,/gu, "") : raw;
  return { value, magnitude, scaled: scale(value, magnitude) };
}

function numbers(text: string): Num[] {
  return [...text.matchAll(NUMBER)].map(num);
}

function sameNum(claim: Num, screen: Num): boolean {
  return (claim.value === screen.value && (claim.magnitude === "" || claim.magnitude === screen.magnitude))
    || (claim.scaled !== null && claim.scaled === screen.scaled);
}

function isAsciiLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isAsciiDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAsciiAlnum(ch: string): boolean {
  return isAsciiLetter(ch) || isAsciiDigit(ch);
}

/** Letters and decimal digits only: punctuation, spacing and emphasis disappear from the comparison. */
function norm(text: string): string {
  return text.replace(/[^\p{L}\p{Nd}]+/gu, "");
}

/** The answer and the evidence are folded alike before any comparison. */
function canon(text: string): string {
  return text.normalize("NFKC").replace(ZERO_WIDTH, "").replace(MARKUP, "")
    .replace(REF_CITATION, " ").replace(FOOTNOTE, " ");
}

function quotes(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(QUOTED)) {
    const inner = match.slice(1).find((part) => typeof part === "string" && part !== "");
    if (inner !== undefined) out.push(inner);
  }
  return out;
}

/** One letter standing in for a number the answer itself wrote (「今日 +N」 for 「今日 +2,271」). */
const PLACEHOLDER = /(?<![A-Za-z])[A-Za-z](?![A-Za-z])/u;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

function escapeRegex(text: string): string {
  return text.replace(REGEX_SPECIAL, "\\$&");
}

/**
 * Whether a quotation speaks of the answer's own wording: with each stand-in letter read as a number, it matches a
 * passage the answer wrote outside its quotes. Such a quotation is not claiming the screen shows those words.
 */
function template(quote: string, plain: string): boolean {
  if (!PLACEHOLDER.test(quote)) return false;
  const pattern = quote.trim().split(/\s+/u)
    .map((word) => word.split(PLACEHOLDER).map(escapeRegex).join("\\d+(?:[.,]\\d+)*"))
    .join("\\s*");
  return new RegExp(pattern, "u").test(plain);
}

/**
 * Whether the number at [start, end) is a whole word on the screen: not glued to a letter or digit before it, and after
 * it only a run of letters may follow (a unit such as 128GB), never another digit. A hash or an id's digits are not a
 * screen value.
 */
function wholeToken(text: string, start: number, end: number): boolean {
  if (start > 0 && isAsciiAlnum(text.charAt(start - 1))) return false;
  let index = end;
  while (index < text.length && isAsciiLetter(text.charAt(index))) index++;
  return index === end || index === text.length || !isAsciiDigit(text.charAt(index));
}

function screenNumbers(text: string): Num[] {
  const out: Num[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const end = match.index + match[0].length - (match[1]?.length ?? 0);
    if (wholeToken(text, match.index, end)) out.push(num(match));
  }
  return out;
}

function digitsOf(text: string): string[] {
  return [...text.matchAll(DIGITS)].map((match) => match[0].replace(/^0+(?=\d)/u, "") || "0");
}

function screenDigits(text: string): string[] {
  return [...text.matchAll(DIGITS)]
    .filter((match) => wholeToken(text, match.index, match.index + match[0].length))
    .map((match) => match[0].replace(/^0+(?=\d)/u, "") || "0");
}

function alnumRuns(text: string): Set<string> {
  return new Set([...text.matchAll(ALNUM_RUN)].map((match) => match[0].toLowerCase()));
}

/** The ids glued into letters (A3F899C), and the line with their characters blanked so their digits are not numbers. */
function idTokens(text: string): { ids: string[]; plainText: string } {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(NUMBER)) {
    const end = match.index + match[0].length - (match[1]?.length ?? 0);
    if (wholeToken(text, match.index, end)) continue;
    let start = match.index;
    let stop = match.index + match[0].length;
    while (start > 0 && isAsciiAlnum(text.charAt(start - 1))) start--;
    while (stop < text.length && isAsciiAlnum(text.charAt(stop))) stop++;
    if (!ranges.some(([from, to]) => from === start && to === stop)) ranges.push([start, stop]);
  }
  let plainText = text;
  for (const [from, to] of ranges) plainText = plainText.slice(0, from) + " ".repeat(to - from) + plainText.slice(to);
  return { ids: ranges.map(([from, to]) => text.slice(from, to)), plainText };
}

function evidenceLines(entries: readonly string[]): Line[] {
  const out: Line[] = [];
  for (const entry of entries) {
    for (const line of canon(entry).split("\n")) {
      if (line.trim() === "" || line.startsWith(APP_HEADER)) continue;
      out.push({ text: norm(line), nums: screenNumbers(line), digits: screenDigits(line), tokens: alnumRuns(line) });
    }
  }
  return out;
}

function containsWindow(list: readonly string[], window: readonly string[]): boolean {
  if (window.length === 0 || window.length > list.length) return false;
  for (let start = 0; start + window.length <= list.length; start++) {
    if (window.every((value, offset) => list[start + offset] === value)) return true;
  }
  return false;
}

/** The numbers a line claims: with a unit, currency or magnitude, a decimal, or three or more digits. */
function valueNumbers(text: string, known: ReadonlySet<string>): Num[] {
  const out: Num[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const number = num(match);
    if (number.scaled !== null && known.has(number.scaled)) continue;
    const end = match.index + match[0].length;
    const after = text.slice(end, end + 8);
    const unit = number.magnitude !== "" || UNIT_AFTER.test(after) || CURRENCY_BEFORE.test(text.slice(0, match.index));
    const decimal = number.value.includes(".");
    const long = (number.value.split(".")[0] ?? "").split(",")[0]!.length >= 3;
    if (unit || decimal || long) out.push(number);
  }
  return out;
}

function distinctClaims(claims: readonly Claim[]): Claim[] {
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const claim of claims) {
    const key = `${claim.kind}\u0000${claim.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

export interface GroundingOptions {
  /** What the person asked. Its own numbers and words are known, so the answer may repeat them without a screen. */
  goal?: string;
}

/** The answer's facts that no evidence source holds. */
export function ungroundedFacts(answer: string, evidence: readonly string[], options: GroundingOptions = {}): Claim[] {
  return checkGrounding(answer, evidence, options).unmatched;
}

/** At least one line of [quote] is a line of some evidence source, after both are folded alike. */
export function quoteInReads(quote: string, evidence: readonly string[]): boolean {
  const lines = evidenceLines(evidence);
  return canon(quote).split("\n").map(norm).filter((line) => line.length >= 2)
    .some((line) => lines.some((screen) => screen.text.includes(line)));
}

/**
 * Check an answer against the evidence the assistant read. Quotations, numbers, ids and dates in the body must be found;
 * a 依据: section is checked only for its quotations, and its other words merely help locate a screen line. The body is
 * compared line by line, never joined with the next line, and no two evidence lines are joined either.
 */
export function checkGrounding(answer: string, evidence: readonly string[], options: GroundingOptions = {}): GroundingResult {
  const folded = canon(answer);
  const entries = evidence.map((entry) => evidenceLines([entry]));
  const all = entries.flat();
  const foldedGoal = canon(options.goal ?? "");
  const goalNumbers = new Set(numbers(foldedGoal).map((number) => number.value));
  const goalValues = new Set(numbers(foldedGoal).map((number) => number.scaled).filter((value): value is string => value !== null));
  const goalText = norm(foldedGoal);
  const marker = EVIDENCE.exec(folded);
  const basis = marker ? folded.slice(marker.index + marker[0].length) : "";
  const body = marker ? folded.slice(0, marker.index) : folded;

  const numberOnScreen = (number: Num) => all.some((line) => line.nums.some((screen) => sameNum(number, screen)));

  const textIn = (text: string, where: readonly Line[]): boolean => {
    const flat = norm(text);
    if (flat === "" || where.some((line) => line.text.includes(flat))) return true;
    const pieces = text.split(PIECE_BREAK).map(norm).filter((piece) => piece !== "");
    return pieces.length > 1 && pieces.every((piece) => where.some((line) => line.text.includes(piece)))
      && screenNumbers(text.trim().replace(ORDINAL, " ")).every((number) => where.some((line) => line.nums.some((screen) => sameNum(number, screen))));
  };

  const quoteFound = (text: string): boolean => {
    const parts = text.split(CUT).filter((part) => norm(part) !== "");
    const wanted = parts.length ? parts : [text];
    return entries.some((entry) => wanted.every((part) => textIn(part, entry)));
  };

  const dateOnScreen = (text: string): boolean => {
    const parts = digitsOf(text);
    const variants = [parts];
    if (parts.length === 3 && parts[0]?.length === 4) variants.push(parts.slice(1));
    return variants.some((variant) => all.some((line) => containsWindow(line.digits, variant)));
  };

  const values = (line: string): Claim[] => {
    const dates = [...line.matchAll(DATE)].map((match) => match[0])
      .filter((date) => digitsOf(date).some((part) => !goalNumbers.has(part)));
    const { ids, plainText } = idTokens(line.replace(DATE, " ").replace(ORDINAL, " "));
    return [
      ...dates.map((text): Claim => ({ kind: "date", text: text.trim() })),
      ...ids.filter((id) => !goalText.includes(norm(id))).map((text): Claim => ({ kind: "token", text })),
      ...valueNumbers(plainText, goalValues).map((number): Claim => ({ kind: "number", text: number.value + number.magnitude })),
    ];
  };

  const plainBody = body.replace(QUOTED, " ");
  const bodyQuotes = quotes(body).filter((text) => norm(text).length >= 2 && !goalText.includes(norm(text)) && !template(text, plainBody));
  const basisQuotes = quotes(basis).filter((text) => norm(text).length >= 2);
  const lineClaims = body.split("\n").map(values);
  const claims = distinctClaims([
    ...bodyQuotes.map((text): Claim => ({ kind: "quote", text })),
    ...lineClaims.flat(),
    ...basisQuotes.map((text): Claim => ({ kind: "quote", text })),
  ]);

  const matched = (claim: Claim): boolean => {
    if (claim.kind === "quote") return quoteFound(claim.text);
    if (claim.kind === "number") {
      const first = numbers(claim.text)[0];
      return first !== undefined && numberOnScreen(first);
    }
    if (claim.kind === "date") return dateOnScreen(claim.text);
    return all.some((line) => line.tokens.has(claim.text.toLowerCase()));
  };

  const unmatched = claims.filter((claim) => !matched(claim));
  const basisText = norm(basis);
  const fragments = basis.replace(QUOTED, " ").split(FRAGMENT_BREAK).map(norm).filter((piece) => piece.length >= MIN_FRAGMENT);
  const located = (basisQuotes.length > 0 && basisQuotes.every(quoteFound))
    || fragments.some((piece) => all.some((line) => line.text.includes(piece)))
    || all.some((line) => line.text.length >= MIN_LINE_IN_BASIS && basisText.includes(line.text));

  const quoteMatched = claims.some((claim) => claim.kind === "quote" && !unmatched.includes(claim));
  const found = unmatched.length > 0 ? false : quoteMatched || located ? true : null;
  return { found, claims, unmatched, anchored: located || claims.length > unmatched.length, located };
}
