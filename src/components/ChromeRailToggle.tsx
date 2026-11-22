import type { CSSProperties, MouseEvent } from "react";
import { ChevronDown, Cloud, Laptop } from "lucide-react";
import { cn } from "@/lib/cn";
import { openChromeRailPopover, setChromeRailHidden, useChromeRail } from "@/lib/chrome-rail";
import { cloudColor } from "@/lib/cloud-look";
import { t } from "@/lib/i18n";
import { CloudTile } from "./cloud-buy/parts";
import { useWorkspacePlace } from "./DesktopWorkspaceSwitcher";
import { ELEVATED_CONTROL, ELEVATED_HOVER } from "./elevated";
import { SettingRow, Switch } from "./SettingsPrimitives";
import { SIMPLE_TOP_TOGGLE } from "./SidebarSimpleTop";

/** The window's rail of places, drawn small: a window with the rail at its left edge and three places on it. */
export function RailStripIcon({ size }: { size: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
    <circle cx="6" cy="7.5" r="0.75" fill="currentColor" />
    <circle cx="6" cy="12" r="0.75" fill="currentColor" />
    <circle cx="6" cy="16.5" r="0.75" fill="currentColor" />
  </svg>;
}

/** The button that opens the isolated places popover (when the docked strip is hidden) or hides the docked strip:
 * in Simple mode it renders as a macOS-style elevated capsule pill showing the active workspace's icon and name,
 * keeping cross-environment isolation intact (remote pages only read their own current place and never the saved list). */
export function ChromeRailToggle({ advanced = false, icons = false, bar, style }: { advanced?: boolean; icons?: boolean; bar?: string; style?: CSSProperties }) {
  const rail = useChromeRail();
  const { current } = useWorkspacePlace({});
  if (!rail?.available) return null;
  const usesPopover = rail.hidden && typeof window !== "undefined" && typeof window.ogb?.rail?.openPopover === "function";
  const label = usesPopover
    ? t("rail.show")
    : t(rail.hidden ? "rail.show" : "rail.hide");
  const expanded = usesPopover ? rail.popoverOpen === true : !rail.hidden;
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (usesPopover) {
      const rect = event.currentTarget.getBoundingClientRect();
      openChromeRailPopover({ x: Math.round(rect.left), y: Math.round(rect.bottom + 8) });
      return;
    }
    setChromeRailHidden(!rail.hidden);
  };

  if (usesPopover && !bar && !icons) {
    const name = current?.profileName ?? (current?.local && !current.localPath ? t("place.local") : current?.name) ?? t("sidebar.servers");
    const Icon = current?.local === false ? Cloud : Laptop;
    const hasColor = Boolean(cloudColor(current?.color));
    return <button type="button" data-rail-toggle data-rail-capsule aria-label={label} title={name} aria-haspopup="dialog" aria-expanded={expanded} style={style}
      onClick={onClick}
      className={cn(
        "flex min-w-0 max-w-[136px] shrink items-center gap-1.5 rounded-full text-ink transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        advanced
          ? "h-8 pl-1.5 pr-2 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.08]"
          : cn("h-9 pl-1.5 pr-2.5", ELEVATED_CONTROL, ELEVATED_HOVER, expanded && "bg-raised"),
      )}>
      {hasColor
        ? <CloudTile color={current?.color} size={22} />
        : <span aria-hidden="true" className="grid size-[22px] shrink-0 place-items-center rounded-[7px] bg-ink/[0.06] text-ink-secondary"><Icon size={13} strokeWidth={1.75} /></span>}
      <span className="min-w-0 truncate text-[13px] font-medium text-ink">{name}</span>
      <ChevronDown size={12} strokeWidth={2} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform duration-150", expanded && "rotate-180")} />
    </button>;
  }

  return <button type="button" data-rail-toggle aria-label={label} title={label} aria-haspopup={usesPopover ? "dialog" : undefined} aria-expanded={expanded} style={style}
    onClick={onClick}
    className={bar ?? (advanced ? cn("flex shrink-0 items-center justify-center text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
      icons ? "size-[46px] rounded-xl" : "size-8 rounded-full") : SIMPLE_TOP_TOGGLE)}>
    <RailStripIcon size={bar ? 15 : advanced && icons ? 20 : 18} />
  </button>;
}

/** Settings' switch for the same rail, while this window has one. */
export function ChromeRailRow() {
  const rail = useChromeRail();
  if (!rail?.available) return null;
  return <div data-rail-switch>
    <SettingRow title={t("rail.show")} subtitle={t("rail.showSub")}>
      <Switch checked={!rail.hidden} aria-label={t("rail.show")} onClick={() => setChromeRailHidden(!rail.hidden)} />
    </SettingRow>
  </div>;
}
