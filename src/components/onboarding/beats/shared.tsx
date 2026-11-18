import type { CSSProperties } from "react";

export function staggerIndex(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

