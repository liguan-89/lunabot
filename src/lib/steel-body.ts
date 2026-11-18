// Luna Bot's default brand mark (replaces legacy dexbot-steel cursor raster assets).
export interface SteelImage { body: string; px: number; url: string }

export const STEEL_IMAGES: readonly SteelImage[] = [
  { body: "cursor", px: 512, url: "/app-icon.svg" },
];

/** Returns the smallest image that covers `size * density` (or the largest available), or null when none exists for `body`. */
export function steelBodyImage(body: string, size: number, density: number, images: readonly SteelImage[] = STEEL_IMAGES): string | null {
  const candidates = images.filter((image) => image.body === body).toSorted((a, b) => a.px - b.px);
  if (candidates.length === 0) return null;
  const need = Math.max(0, size) * (density > 0 ? density : 1);
  return (candidates.find((image) => image.px >= need) ?? candidates.at(-1))!.url;
}
