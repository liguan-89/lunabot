// Providers such as Grok narrate before tools.
import { useEffect, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { t } from "@/lib/i18n";

export function TurnNarrationRun({
  label,
  title,
  forceOpen = false,
  children,
}: {
  label: string;
  title?: string;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={title ?? t(open ? "chat.narration.hide" : "chat.narration.show")}
          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-hairline/35 bg-panel/80 px-2.5 text-[12px] font-medium text-ink-tertiary hover:bg-control hover:text-ink-secondary"
        >
          <Check size={12} className="shrink-0 text-success" />
          <span className="truncate">{label}</span>
          <ChevronRight size={12} className={open ? "shrink-0 rotate-90" : "shrink-0"} />
        </button>
      </div>
      {open && children}
    </div>
  );
}
