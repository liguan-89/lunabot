/** The canvas colour a window paints before the renderer loads: the light or dark theme's, so neither flashes the other. */
export function windowBackground(prefersDark) {
  return prefersDark ? "#121212" : "#fcfcfc";
}

/** macOS: where the traffic lights (14px) sit, inset in the window's chrome; each page leaves them that room itself. */
export const TRAFFIC_LIGHTS = { x: 16, y: 16 };

/** macOS: the title bar is inset into the page, which leaves the traffic lights their room. Other platforms keep the
 * system's own title bar. */
export function windowChromeOptions(platform) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: TRAFFIC_LIGHTS };
  }
  return {};
}
