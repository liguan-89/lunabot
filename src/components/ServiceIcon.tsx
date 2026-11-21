import { useState } from "react";
import { cn } from "@/lib/cn";

/** One connectable app as the Apps catalog lists it. */
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  noAuth?: boolean;
  domain: string | null;
  categories?: string[];
}

const ICON_TRAY = "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-panel/90 p-1.5 ring-[0.5px] ring-ink/[0.1] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_6%,transparent)]";

/** An app's logo, then its site's favicon, then its initial — each inside a unified rounded tray. */
export function ServiceIcon({ card, className = "size-11" }: { card: Pick<ToolkitCard, "logo" | "domain" | "label">; className?: string }) {
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
  if (stage === 0 && card.logo) {
    return (
      <span className={cn(ICON_TRAY, className)}>
        <img
          src={card.logo}
          alt=""
          loading="lazy"
          className="size-full object-contain"
          onError={() => setStage(1)}
        />
      </span>
    );
  }
  if (stage === 1 && card.domain) {
    return (
      <span className={cn(ICON_TRAY, className)}>
        <img
          src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`}
          alt=""
          loading="lazy"
          className="size-full object-contain"
          onError={() => setStage(2)}
        />
      </span>
    );
  }
  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl bg-raised text-[15px] font-semibold text-ink-secondary ring-[0.5px] ring-ink/[0.08] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_6%,transparent)]",
        className,
      )}
    >
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}
