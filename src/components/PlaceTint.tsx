import type { CSSProperties } from "react";
import { placeTint, usePlaceLook } from "@/lib/place-look";

/** What the top of the sidebar shows: the place's colour, or nothing as it always was. */
export function PlaceTop({ color }: { color: unknown }) {
  const tint = placeTint(color);
  return tint ? <div aria-hidden="true" data-place-tint className="place-tint pointer-events-none absolute inset-x-0 top-0" style={tint as CSSProperties} /> : null;
}

/** The sidebar's own: its place's colour from the app. */
export function PlaceTint() {
  return <PlaceTop color={usePlaceLook()?.color} />;
}
