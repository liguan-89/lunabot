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

function BuiltinServiceGlyph({ domain }: { domain: string | null }) {
  switch (domain) {
    case "calendar.google.com":
      return (
        <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
          <rect x="2.5" y="3.5" width="19" height="18" rx="3.5" fill="#4285F4" />
          <path d="M6 3.5h12v4H6z" fill="#1967D2" />
          <rect x="5" y="8" width="14" height="11" rx="1.5" fill="#FFFFFF" />
          <path d="M16.5 19l4.5-4.5v3a1.5 1.5 0 0 1-1.5 1.5z" fill="#EA4335" />
          <path d="M5 17.5V19h11.5v-1.5z" fill="#34A853" />
          <path d="M19 8v6.5h2.5V8z" fill="#FBBC04" />
          <text x="12" y="15.8" textAnchor="middle" fontSize="7.5" fontWeight="700" fontFamily="system-ui, sans-serif" fill="#1A73E8">31</text>
        </svg>
      );
    case "sheets.google.com":
      return (
        <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
          <path d="M6 2.5h8.5L20 8v12.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 6 2.5z" fill="#0F9D58" />
          <path d="M14.5 2.5V8H20z" fill="#87CEAC" />
          <path d="M7.5 11.5h9v7h-9zm1.2 1.2v1.8h2.7v-1.8zm3.9 0v1.8h2.7v-1.8zm-3.9 3v1.6h2.7v-1.6zm3.9 0v1.6h2.7v-1.6z" fill="#FFFFFF" />
        </svg>
      );
    case "docs.google.com":
      return (
        <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
          <path d="M6 2.5h8.5L20 8v12.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 6 2.5z" fill="#4285F4" />
          <path d="M14.5 2.5V8H20z" fill="#A1C2FA" />
          <path d="M7.5 11.8h9v1.3h-9zm0 2.6h9v1.3h-9zm0 2.6h6v1.3h-6z" fill="#FFFFFF" />
        </svg>
      );
    case "drive.google.com":
      return (
        <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
          <path d="M8.5 3.5h7l6 10.5h-7z" fill="#FBBC04" />
          <path d="M2.5 14l6-10.5 3.5 6-6 10.5z" fill="#0F9D58" />
          <path d="M6 20l3.5-6h12L18 20z" fill="#4285F4" />
        </svg>
      );
    case "gmail.com":
      return (
        <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
          <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" fill="#FFFFFF" stroke="#E0E3E7" strokeWidth="0.75" />
          <path d="M4 6.5l8 6 8-6" fill="none" stroke="#EA4335" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 18.5V7l4.2 3.2V18.5z" fill="#4285F4" />
          <path d="M20 18.5V7l-4.2 3.2V18.5z" fill="#34A853" />
          <path d="M15.8 10.2L20 7v3.2z" fill="#FBBC04" />
        </svg>
      );
    default:
      return null;
  }
}

/** An app's logo, then its built-in glyph / site favicon, then its initial — each inside a unified rounded tray. */
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
    const builtin = BuiltinServiceGlyph({ domain: card.domain });
    if (builtin) {
      return <span className={cn(ICON_TRAY, className)}>{builtin}</span>;
    }
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
