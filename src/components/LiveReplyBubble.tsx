import { memo, useEffect, useRef, useState } from "react";

import { ChatMarkdown } from "./ChatMarkdown";

// The words as they arrive, under the working mascot. The settled bubble
// replaces this one when `item.completed` lands, so this is deliberately the
// same shape and surface as a bot bubble — no actions, no timestamp, no
// edit affordances a half-written message cannot honour.
const THROTTLE_MS = 100;

/** Markdown is the expensive half of a live bubble: a long reply re-parses on
 * every animation frame otherwise. Token frames arrive faster than a person
 * can read, so repaint at most ten times a second and let the tail land. */
function useThrottledText(text: string, intervalMs = THROTTLE_MS): string {
  const [shown, setShown] = useState(text);
  const pending = useRef(text);
  const lastAt = useRef(0);
  useEffect(() => {
    pending.current = text;
    const wait = Math.max(0, intervalMs - (Date.now() - lastAt.current));
    if (wait === 0) {
      lastAt.current = Date.now();
      setShown(text);
      return;
    }
    const timer = setTimeout(() => {
      lastAt.current = Date.now();
      setShown(pending.current);
    }, wait);
    return () => clearTimeout(timer);
  }, [text, intervalMs]);
  return shown;
}

export const LiveReplyBubble = memo(function LiveReplyBubble({ text }: { text: string }) {
  const shown = useThrottledText(text);
  if (!shown.trim()) return null;
  return (
    <div className="flex w-full flex-col items-start" data-live-reply="true">
      <div className="flex w-full items-center justify-start">
        <div className="w-fit max-w-[min(42rem,78%)] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
          <ChatMarkdown text={shown} streaming />
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse rounded-full bg-ink-secondary/50 align-baseline"
          />
        </div>
      </div>
    </div>
  );
});
