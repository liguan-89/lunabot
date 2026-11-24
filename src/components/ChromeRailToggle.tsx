import type { CSSProperties, MouseEvent } from "react";
import { ChevronDown, Cloud, Laptop } from "lucide-react";
import { cn } from "@/lib/cn";
import { openChromeRailPopover, useChromeRail } from "@/lib/chrome-rail";
import { cloudColor } from "@/lib/cloud-look";
import { t } from "@/lib/i18n";
import { CloudTile } from "./cloud-buy/parts";
import { useWorkspacePlace } from "./DesktopWorkspaceSwitcher";
import { ELEVATED_CONTROL, ELEVATED_HOVER } from "./elevated";
import { SIMPLE_TOP_TOGGLE } from "./SidebarSimpleTop";

/** The places the button lists, drawn small: a card with three places on it. */
export function RailStripIcon({ size }: { size: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="3" width="16" height="18" rx="3" />
    <circle cx="8.5" cy="8" r="0.75" fill="currentColor" />
    <path d="M12 8h4.5" />
    <circle cx="8.5" cy="12" r="0.75" fill="currentColor" />
    <path d="M12 12h4.5" />
    <circle cx="8.5" cy="16" r="0.75" fill="currentColor" />
    <path d="M12 16h4.5" />
  </svg>;
}

/** The button that opens the isolated places popover: in Simple mode it renders as a macOS-style elevated capsule pill
 * showing the active workspace's icon and name, keeping cross-environment isolation intact (remote pages only read
 * their own current place and never the saved list). */
export function ChromeRailToggle({ advanced = false, icons = false, style }: { advanced?: boolean; icons?: boolean; style?: CSSProperties }) {
  const rail = useChromeRail();
  const { current } = useWorkspacePlace({});
  if (!rail?.available) return null;
  const label = t("rail.show");
  const expanded = rail.popoverOpen === true;
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openChromeRailPopover({ x: Math.round(rect.left), y: Math.round(rect.bottom + 8) });
  };

  if (!icons) {
    const name = current?.profileName ?? (current?.local && !current.localPath ? t("place.local") : current?.name) ?? t("sidebar.servers");
    const Icon = current?.local === false ? Cloud : Laptop;
    const hasColor = Boolean(cloudColor(current?.color));
    return <button type="button" data-rail-toggle data-rail-capsule aria-label={label} title={name} aria-haspopup="dialog" aria-expanded={expanded} style={style}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center rounded-full text-ink transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        advanced
          ? "h-8 max-w-[140px] gap-1.5 pl-1.5 pr-2 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.08]"
          : cn(
            "h-9 gap-1 pl-2 pr-2 @[310px]/sidebar-bar:max-w-[140px] @[310px]/sidebar-bar:gap-1.5 @[310px]/sidebar-bar:pl-1.5 @[310px]/sidebar-bar:pr-2.5",
            ELEVATED_CONTROL,
            ELEVATED_HOVER,
            expanded && "bg-raised",
          ),
      )}>
      {hasColor
        ? <CloudTile color={current?.color} size={20} />
        : <span aria-hidden="true" className="grid size-[22px] shrink-0 place-items-center rounded-full text-ink-secondary"><Icon size={15} strokeWidth={1.75} /></span>}
      <span className={cn("min-w-0 truncate text-[13px] font-medium text-ink", !advanced && "hidden @[310px]/sidebar-bar:inline")}>{name}</span>
      <ChevronDown size={12} strokeWidth={2} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform duration-150", expanded && "rotate-180")} />
    </button>;
  }

  return <button type="button" data-rail-toggle aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={expanded} style={style}
    onClick={onClick}
    className={advanced ? cn("flex shrink-0 items-center justify-center text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
      icons ? "size-[46px] rounded-xl" : "size-8 rounded-full") : SIMPLE_TOP_TOGGLE}>
    <RailStripIcon size={advanced && icons ? 20 : 18} />
  </button>;
}
