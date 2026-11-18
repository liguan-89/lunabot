// Adapted from Mika's Untrusted (Apache-2.0).
/**
 * The fixed markers around words the phone's own screens and apps wrote: an element's label, a chat line, a
 * notification, a file. They are put on once, where the phone's answer is turned into a tool result; trimming or
 * shortening later never wraps again. The model is told once, in the phone prompt, what they mean.
 *
 * A closing marker inside the body is escaped, so the body cannot end the layer early and speak as if it were not
 * content. What is recorded elsewhere stays the unwrapped original.
 */

export const UNTRUSTED_OPEN = "<untrusted>";
export const UNTRUSTED_CLOSE = "</untrusted>";
/** What wrapping adds to a non-empty body: the two newlines and both markers. */
export const UNTRUSTED_OVERHEAD = 2 + UNTRUSTED_OPEN.length + UNTRUSTED_CLOSE.length;

const ESCAPED_CLOSE = "<\\/untrusted>";

/** Wraps a body in the markers; an empty body is handed back as it is. */
export function wrapUntrusted(text: string): string {
  return text === "" ? text : `${UNTRUSTED_OPEN}\n${text.replaceAll(UNTRUSTED_CLOSE, ESCAPED_CLOSE)}\n${UNTRUSTED_CLOSE}`;
}

/** Wraps a body that must still fit `maxChars` once wrapped: the markers and the newlines count against the budget,
 * and only the body is cut to fit, so the result is always closed. */
export function wrapUntrustedWithin(text: string, maxChars: number): string {
  if (maxChars < UNTRUSTED_OVERHEAD) {
    throw new RangeError(`An untrusted body needs at least ${UNTRUSTED_OVERHEAD} characters for its markers.`);
  }
  const escaped = text.replaceAll(UNTRUSTED_CLOSE, ESCAPED_CLOSE);
  return escaped === "" ? escaped : `${UNTRUSTED_OPEN}\n${escaped.slice(0, maxChars - UNTRUSTED_OVERHEAD)}\n${UNTRUSTED_CLOSE}`;
}
