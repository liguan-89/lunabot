import { useEffect, useState } from "react";
import { ChevronRight, Check } from "lucide-react";
import type { Message } from "@/state/store";
import { describeRun } from "@/lib/activity-runs";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { toolStepLabel } from "@/lib/tool-step-label";

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  const advanced = useAdvancedMode();
  const summary = advanced ? describeRun(messages) : describeRun(messages, toolStepLabel);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  if (open) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 justify-start">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-expanded
            className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-hairline/35 bg-panel/80 px-2.5 text-[12px] font-medium text-ink-secondary hover:bg-control"
          >
            <ChevronRight size={12} className="shrink-0 rotate-90" />
            <span className="min-w-0 truncate leading-5">{summary}</span>
          </button>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 justify-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title={t("chat.run.showSteps")}
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-hairline/35 bg-panel/80 px-2.5 text-[12px] font-medium text-ink-tertiary hover:bg-control hover:text-ink-secondary"
      >
        <Check size={12} className="shrink-0 text-success" />
        <span className="min-w-0 max-w-[480px] truncate leading-5">{summary}</span>
        <ChevronRight size={12} className="shrink-0" />
      </button>
    </div>
  );
}
