export declare const CHROME_RAIL_PATH: string;
/** What the page beside the window's rail knows of it: whether this window has one (two places or more) and whether its
 * places popover is open. Never the places on it. */
export interface ChromeRailState { available: boolean; popoverOpen?: boolean }
export interface ChromeRailPopover { open: boolean; x: number; y: number }
/** `window.ogb.rail`. The page beside the rail offers the button that opens the isolated places popover: `state()` from
 * a document is that offer. `expand`, `closePopover`, `onPopover` and `onSkin` are the rail's own page's, on this app's
 * pages only. Each is absent on an older app. */
export interface ChromeRailBridge {
  state?(): Promise<ChromeRailState>;
  /** Opens or toggles the isolated places popover anchored to the switcher capsule (from the person's click). */
  openPopover?(anchor?: { x: number; y: number }): Promise<ChromeRailState>;
  onState?(callback: (state: ChromeRailState) => void): () => void;
  expand?(on: boolean): Promise<void>;
  closePopover?(): Promise<void>;
  onPopover?(callback: (popover: ChromeRailPopover) => void): () => void;
  onSkin?(callback: (skin: string) => void): () => void;
}
export interface ChromeRail {
  attach(window: unknown): void;
  refresh(): void;
  holdOpen(on: boolean): void;
  expand(on: boolean): void;
  openPopover(anchor?: { x: number; y: number }): void;
  closePopover(): void;
  owns(event: unknown): boolean;
  shown(): boolean;
  expanded(): boolean;
  popoverOpen(): boolean;
  send(channel: string, ...values: unknown[]): void;
  install(ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void }): void;
}
export declare function createChromeRail(deps: {
  createView: (options: object) => any;
  preload: string;
  args: () => string[];
  url: () => string;
  wanted: () => boolean;
  log?: (line: string) => void;
}): ChromeRail;
