import { useEffect, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { reportTk1688Offer } from "@/lib/tk1688-offer";
import { TK1688_URL } from "../../shared/tk1688";
import { LinkButton, NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";
import { ProviderMark, type IconProps } from "./ProviderIcons";

export type Tk1688CardAction = "get_key" | "not_now" | "close";

const CardMark = ({ className }: IconProps) => <span className={cn("block size-[22px]", className)}><ProviderMark driverKind="tk1688" /></span>;

export function Tk1688OfferCard({ onDone }: { onDone: (action: Tk1688CardAction) => void }) {
  return <NoticeCard titleId="tk1688-offer-title" notice="tk1688-offer" icon={CardMark} title={t("tk1688Offer.title")} onDismiss={() => onDone("close")}>
    <p className="mt-1 text-[13px] leading-[18px] text-ink-secondary">{t("tk1688Offer.line")}</p>
    <p data-tk1688-sponsor className="mt-1 text-[11px] leading-4 text-ink-tertiary">{t("tk1688Offer.sponsor")}</p>
    <div className="mt-3 flex flex-col gap-2">
      <LinkButton url={TK1688_URL} label={t("tk1688Offer.getKey")} className={cn(PRIMARY_BUTTON, "w-full")} onOpened={() => onDone("get_key")} />
      <NotNowButton onClick={() => onDone("not_now")} />
    </div>
  </NoticeCard>;
}

const GET_KEY_LINK = "inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-accent-text hover:underline";

/** The first run's row for TK1688, among the other ways to connect an AI; `children` is its key field, when the server has the provider. */
export function Tk1688Option({ open, onToggle, children }: { open: boolean; onToggle: () => void; children?: ReactNode }) {
  useEffect(() => { reportTk1688Offer("shown", "onboarding"); }, []);
  const name = <>
    <span className="flex size-[18px] shrink-0 items-center justify-center"><ProviderMark driverKind="tk1688" /></span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <span className="truncate text-[14px] text-ink">{t("tk1688Offer.name")}</span>
        <span data-tk1688-sponsor className="shrink-0 text-[11px] leading-4 text-ink-tertiary">{t("tk1688Offer.sponsor")}</span>
      </span>
      <span className="block truncate text-[12px] leading-4 text-ink-secondary">{t("tk1688Offer.line")}</span>
    </span>
  </>;
  return <div data-tk1688-option="">
    <div className="flex items-center gap-2 pr-4 transition-colors hover:bg-ink/[0.04]">
      {children ? <button type="button" aria-expanded={open} onClick={() => { if (!open) reportTk1688Offer("add_key", "onboarding"); onToggle(); }}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left focus-visible:outline-offset-[-2px]">
        {name}
        <ChevronDown size={14} className={cn("shrink-0 text-ink-secondary transition-transform duration-200", open && "rotate-180")} />
      </button> : <div className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4">{name}</div>}
      <LinkButton url={TK1688_URL} label={t("tk1688Offer.link")} className={GET_KEY_LINK} onOpened={() => reportTk1688Offer("get_key", "onboarding")} />
    </div>
    {open && children}
  </div>;
}
