// The app's flat portrait: one disc, two pill eyes, no mouth — the face the phone's roster draws and the face the
// launcher icon carries.
//
// This is a port of Android's BotFace.kt, not a still: BotFaceRig (src/lib/preset-face-rig.ts) schedules blinks, gaze,
// idle gestures and breath; this component ticks it on requestAnimationFrame and writes the pose straight to the SVG
// nodes, so a row of faces animates without React re-rendering any of them. The crown is drawn in the same SVG and
// leans with pose.roll and the gaze, exactly as drawCrown does on the phone.
import { useEffect, useId, useRef } from "react";

import { cn } from "@/lib/cn";
import { facePose, lookAt, withLook, type FaceLife, type FaceMood } from "@/lib/preset-face-rig";
import { handsPose, Hands, handIsMirrored, HAND_BASE_X, HAND_BASE_Y, HAND_RADIUS, HAND_TIP_X, HAND_TIP_Y } from "@/lib/preset-hands-rig";

type PresetKey = "black" | "white" | "blue" | "orange" | "purple" | "mint" | "coral" | "grey";

const FACES: Record<PresetKey, { light: string; body: string; edge: string; eye: string }> = {
  black: { light: "#2E2E2E", body: "#000000", edge: "#000000", eye: "#FDFEFD" },
  white: { light: "#FFFFFF", body: "#F7F3ED", edge: "#D9D5CD", eye: "#1C1C1E" },
  blue: { light: "#3F7CFF", body: "#0E5AFD", edge: "#0A42BE", eye: "#FEFEFE" },
  orange: { light: "#FFB266", body: "#FF9432", edge: "#D96F0C", eye: "#FEFEFE" },
  purple: { light: "#B87DFF", body: "#9443F4", edge: "#6D21C3", eye: "#FEFEFE" },
  mint: { light: "#8DF1B0", body: "#57E58C", edge: "#2FAF62", eye: "#FEFEFE" },
  coral: { light: "#FF9588", body: "#FD5C59", edge: "#D63B3B", eye: "#FEFEFE" },
  grey: { light: "#A2A3A2", body: "#777877", edge: "#555655", eye: "#FEFEFE" },
};

/** The preset a bot's own colour maps to, word for word from the phone's PresetAvatars.forColor. */
export function presetFaceForColor(color: string | null | undefined): PresetKey {
  switch (color?.toLowerCase()) {
    case "blue":
    case "cyan": return "blue";
    case "orange":
    case "yellow": return "orange";
    case "red":
    case "coral": return "coral";
    case "green":
    case "teal": return "mint";
    case "purple":
    case "violet": return "purple";
    case "white":
    case "cream":
    case "sand":
    case "grey":
    case "gray":
    case "chrome":
    case "silver": return "white";
    default: return "black";
  }
}

// The reference's two eyes: a pair tilted about -19°, each pill a little less (2.4°) so they do not look pasted on.
// These are BotFace.kt's fractions of a radius (the 100-unit viewBox has a radius of 50, so the offset is 17.1 there).
const EYE_OFFSET = 0.342;
const EYE_DROP = -0.150;
const FACE_TILT_DEG = -19.1;
const EYE_TILT_DEG = 2.4;
const EYE_LENGTH = 0.245;
const EYE_WIDTH = 0.125;

const TILT = (FACE_TILT_DEG * Math.PI) / 180;
const COS_TILT = Math.cos(TILT);
const SIN_TILT = Math.sin(TILT);

const vision = (side: 1 | -1) => ({
  x: side * EYE_OFFSET * 50 * COS_TILT,
  y: EYE_DROP * 50 + side * EYE_OFFSET * 50 * SIN_TILT,
});
const LEFT_EYE = vision(-1);
const RIGHT_EYE = vision(1);

// The crown, as BotFace.kt draws it: a band on the skull's own circle, three ink peaks stroked in gold with light tips,
// and three ink stones. Sizes are in the same 100-unit face space (radius 50).
const CROWN_SPAN = 28;
const CROWN_INNER = 50;
const CROWN_OUTER = 57;
const CROWN_PEAK_HALF = 8;
const CROWN_PEAKS = [-18, 0, 18];
const CROWN_APEX = [69, 74.5, 69];
const CROWN_STONES = [-12, 0, 12];
const CROWN_STONE_RADIUS = 52.5;
const CROWN_INK = "#17171B";
const CROWN_GOLD = "#C9A227";
const CROWN_GOLD_LIGHT = "#ECC564";

const crownAt = (degrees: number, radius: number) => {
  const angle = (degrees * Math.PI) / 180;
  return { x: 50 + radius * Math.sin(angle), y: 50 - radius * Math.cos(angle) };
};
const crownPath = (points: Array<{ x: number; y: number }>) => `M${points.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L")}Z`;

const CROWN_BAND = (() => {
  const outer = Array.from({ length: 15 }, (_, index) => crownAt(-CROWN_SPAN + (2 * CROWN_SPAN * index) / 14, CROWN_OUTER));
  const inner = Array.from({ length: 15 }, (_, index) => crownAt(CROWN_SPAN - (2 * CROWN_SPAN * index) / 14, CROWN_INNER));
  return crownPath([...outer, ...inner]);
})();
const CROWN_EDGE = Array.from({ length: 14 }, (_, index) => [
  crownAt(-CROWN_SPAN + (2 * CROWN_SPAN * index) / 14, CROWN_OUTER),
  crownAt(-CROWN_SPAN + (2 * CROWN_SPAN * (index + 1)) / 14, CROWN_OUTER),
] as const);
const CROWN_PEAK_PATHS = CROWN_PEAKS.map((angle, index) =>
  crownPath([crownAt(angle - CROWN_PEAK_HALF, CROWN_OUTER), crownAt(angle, CROWN_APEX[index]!), crownAt(angle + CROWN_PEAK_HALF, CROWN_OUTER)]),
);
const CROWN_TIPS = CROWN_PEAKS.map((angle, index) => crownAt(angle, CROWN_APEX[index]!));
const CROWN_STONE_POINTS = CROWN_STONES.map((angle) => crownAt(angle, CROWN_STONE_RADIUS));

function Crown({ testId }: { testId?: string }) {
  return (
    <g data-crown="" data-testid={testId} transform={`rotate(${FACE_TILT_DEG} 50 50)`}>
      {CROWN_PEAK_PATHS.map((peak, index) => (
        <g key={CROWN_PEAKS[index]}>
          <path d={peak} fill={CROWN_INK} stroke={CROWN_GOLD} strokeWidth={2.6} strokeLinejoin="round" />
          <circle cx={CROWN_TIPS[index]!.x} cy={CROWN_TIPS[index]!.y} r={2.8} fill={CROWN_GOLD_LIGHT} />
        </g>
      ))}
      <path d={CROWN_BAND} fill={CROWN_GOLD} />
      {CROWN_EDGE.map(([from, to], index) => (
        <line key={index} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={CROWN_GOLD_LIGHT} strokeWidth={2} strokeLinecap="round" />
      ))}
      {CROWN_STONE_POINTS.map((stone, index) => (
        <circle key={CROWN_STONES[index]} cx={stone.x} cy={stone.y} r={2.2} fill={CROWN_INK} />
      ))}
    </g>
  );
}

const EDGE_UNIT = 0.16;

const hexRgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff] as const;
};
const mixHex = (from: string, to: string, amount: number) => {
  const a = hexRgb(from);
  const b = hexRgb(to);
  return `#${[0, 1, 2].map((index) => Math.round(a[index]! + (b[index]! - a[index]!) * amount).toString(16).padStart(2, "0")).join("")}`;
};

const handEdgeFor = (body: string) => {
  const [r, g, b] = hexRgb(body);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? mixHex(body, "#000000", 0.22) : mixHex(body, "#FFFFFF", 0.30);
};

/** One of the phone's hands in unit space (palm radius 1): five round-capped fingers then the palm. */
function HandShape({ mirror, gradient, edge }: { mirror: 1 | -1; gradient: string; edge: string }) {
  const fingers = HAND_BASE_X.map((base, index) => ({
    x1: base * mirror,
    y1: HAND_BASE_Y[index]!,
    x2: HAND_TIP_X[index]! * mirror,
    y2: HAND_TIP_Y[index]!,
    r: HAND_RADIUS[index]!,
  }));
  return (
    <>
      {fingers.map((finger, index) => (
        <g key={`edge-${index}`} data-hand-finger={index} data-hand-pass="edge">
          <line x1={finger.x1} y1={finger.y1} x2={finger.x2} y2={finger.y2} stroke={edge} strokeWidth={2 * finger.r + 2 * EDGE_UNIT} strokeLinecap="round" />
        </g>
      ))}
      <circle data-hand-palm="edge" r="1" fill="none" stroke={edge} strokeWidth={2 * EDGE_UNIT} />
      {fingers.map((finger, index) => (
        <g key={`fill-${index}`} data-hand-finger={index} data-hand-pass="fill">
          <line x1={finger.x1} y1={finger.y1} x2={finger.x2} y2={finger.y2} stroke={`url(#${gradient})`} strokeWidth={2 * finger.r} strokeLinecap="round" />
        </g>
      ))}
      <circle data-hand-palm="fill" r="1" fill={`url(#${gradient})`} />
    </>
  );
}

const HAND_SIDES = ["left", "right"] as const;

function PresetHands({ gradient, edge }: { gradient: string; edge: string }) {
  return (
    <>
      {HAND_SIDES.map((side) => (
        <g key={side} data-hand={side} opacity="0">
          {(["left", "right"] as const).map((shape) => (
            <g key={shape} data-hand-shape={shape} style={{ display: shape === side ? "inline" : "none" }}>
              <HandShape mirror={shape === "left" ? -1 : 1} gradient={gradient} edge={edge} />
            </g>
          ))}
        </g>
      ))}
    </>
  );
}

export function PresetFace({ color, preset, size = 44, label, className, life = "glance", mood = "idle", seed = 0, crown = false }: {
  color?: string | null;
  preset?: PresetKey;
  size?: number;
  label?: string;
  className?: string;
  life?: FaceLife;
  mood?: FaceMood;
  /** A stable per-bot number: two faces with the same seed blink together. */
  seed?: number;
  crown?: boolean;
}) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const face = FACES[preset ?? presetFaceForColor(color)];
  const gradient = `preset-face-${id}`;
  const clip = `preset-clip-${id}`;
  const handGradient = `preset-hand-${id}`;
  const handEdge = handEdgeFor(face.body);
  const showsHands = life === "alive";
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || life === "still" || typeof requestAnimationFrame === "undefined") return;
    const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    const breath = svg.querySelector<SVGGElement>("[data-face-breath]");
    const eyes = [svg.querySelector<SVGGElement>('[data-eye="left"]'), svg.querySelector<SVGGElement>('[data-eye="right"]')] as const;
    const rects = [svg.querySelector<SVGRectElement>('[data-eye-rect="left"]'), svg.querySelector<SVGRectElement>('[data-eye-rect="right"]')] as const;
    const crownNode = svg.querySelector<SVGGElement>("[data-crown]");
    if (!breath || !eyes[0] || !eyes[1] || !rects[0] || !rects[1]) return;

    const width = EYE_WIDTH * 100;
    let frame = 0;
    let last = 0;
    let visible = true;
    let lastTouch = performance.now();
    let pointer: { x: number; y: number; at: number } | null = null;
    const start = performance.now();
    const hands = showsHands ? new Hands() : null;
    const wake = () => { lastTouch = performance.now(); };
    const follow = (event: PointerEvent) => {
      lastTouch = performance.now();
      const rect = svg.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top, at: lastTouch };
    };
    const dozes = life === "alive";
    if (dozes) {
      window.addEventListener("pointermove", follow, { passive: true });
      window.addEventListener("pointerdown", wake, { passive: true });
      window.addEventListener("keydown", wake);
    }

    const moveEye = (side: 1 | -1, open: number, index: 0 | 1, poseRoll: number, poseGazeX: number, poseGazeY: number, poseLookX: number, poseLookY: number) => {
      const gazeX = poseGazeX * 50 * COS_TILT - poseGazeY * 50 * SIN_TILT + poseLookX * 50;
      const gazeY = poseGazeX * 50 * SIN_TILT + poseGazeY * 50 * COS_TILT + poseLookY * 50;
      const base = side === -1 ? LEFT_EYE : RIGHT_EYE;
      const offsetX = base.x + gazeX;
      const offsetY = base.y + gazeY;
      const roll = (poseRoll * Math.PI) / 180;
      const cosRoll = Math.cos(roll);
      const sinRoll = Math.sin(roll);
      const x = offsetX * cosRoll - offsetY * sinRoll;
      const y = offsetX * sinRoll + offsetY * cosRoll;
      const height = Math.max(EYE_LENGTH * 100 * open, width * 0.34);
      eyes[index]!.setAttribute("transform", `translate(${50 + x} ${50 + y}) rotate(${FACE_TILT_DEG + EYE_TILT_DEG + poseRoll})`);
      rects[index]!.setAttribute("y", String(-height / 2));
      rects[index]!.setAttribute("height", String(height));
    };

    const draw = (now: number) => {
      // A large idle portrait dozes off after 45 s without a touch, exactly as the phone's does; a list face never does.
      const asleep = life === "alive" && mood === "idle" && performance.now() - lastTouch > 45_000;
      const effectiveMood = asleep ? "drowsy" : mood;
      const look = showsHands && pointer
        ? lookAt(size / 2, size / 2, pointer.x, pointer.y, performance.now() - pointer.at)
        : [0, 0] as const;
      const pose = withLook(facePose(now, seed, effectiveMood, life), [look[0], look[1]]);
      breath.setAttribute("transform", `translate(50 50) scale(${pose.scale * (1 - pose.squash)} ${pose.scale * (1 + pose.squash)}) translate(-50 -50)`);
      moveEye(-1, pose.openLeft, 0, pose.roll, pose.gazeX, pose.gazeY, pose.lookX, pose.lookY);
      moveEye(1, pose.openRight, 1, pose.roll, pose.gazeX, pose.gazeY, pose.lookX, pose.lookY);
      crownNode?.setAttribute("transform", `rotate(${FACE_TILT_DEG + pose.roll + pose.gazeX * 90} 50 50)`);

      if (hands) {
        handsPose(now, seed, effectiveMood, life, pose.roll, hands);
        for (const side of HAND_SIDES) {
          const hand = side === "left" ? hands.left : hands.right;
          const node = svg.querySelector<SVGGElement>(`[data-hand="${side}"]`);
          if (!node) continue;
          node.setAttribute("opacity", String(hand.alpha));
          node.setAttribute("transform", `translate(${50 + hand.x * 50} ${50 + hand.y * 50}) rotate(${hand.angle}) scale(${10 * hand.scale})`);
          const mirrored = handIsMirrored(side === "left", hand.palmOut);
          const shape = node.querySelector<SVGGElement>(`[data-hand-shape="${mirrored ? "left" : "right"}"]`);
          node.querySelectorAll<SVGGElement>("[data-hand-shape]").forEach((candidate) => {
            candidate.setAttribute("display", candidate === shape ? "inline" : "none");
          });
          const curlSign = mirrored ? -1 : 1;
          shape?.querySelectorAll<SVGGElement>("[data-hand-finger]").forEach((piece) => {
            const finger = Number(piece.getAttribute("data-hand-finger"));
            const pivotX = HAND_BASE_X[finger]! * (mirrored ? -1 : 1);
            const pivotY = HAND_BASE_Y[finger]!;
            piece.setAttribute("transform", `rotate(${(hand.curls[finger] ?? 0) * curlSign} ${pivotX} ${pivotY})`);
          });
        }
      }
    };

    const tick = (now: number) => {
      if (visible && now - last >= 33) { draw(now - start); last = now; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const observer = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => { visible = entries[0]?.isIntersecting ?? true; }, { threshold: 0 })
      : null;
    observer?.observe(svg);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      if (dozes) {
        window.removeEventListener("pointermove", follow);
        window.removeEventListener("pointerdown", wake);
        window.removeEventListener("keydown", wake);
      }
    };
  }, [life, mood, seed, crown, size]);

  const eye = (side: 1 | -1, index: "left" | "right") => {
    const centre = side === -1 ? LEFT_EYE : RIGHT_EYE;
    const width = EYE_WIDTH * 100;
    const height = EYE_LENGTH * 100;
    return (
      <g data-eye={index} transform={`translate(${50 + centre.x} ${50 + centre.y}) rotate(${FACE_TILT_DEG + EYE_TILT_DEG})`}>
        <rect data-eye-rect={index} x={-width / 2} y={-height / 2} width={width} height={height} rx={width / 2} fill={face.eye} />
      </g>
    );
  };

  return (
    <svg
      ref={svgRef}
      width={`${size}px`}
      height={`${size}px`}
      viewBox="0 0 100 100"
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className={cn("block shrink-0 overflow-visible", className)}
      data-preset-face={preset ?? presetFaceForColor(color)}
    >
      <defs>
        <radialGradient id={gradient} cx="32%" cy="22%" r="82%">
          <stop offset="0" stopColor={face.light} />
          <stop offset="0.55" stopColor={face.body} />
          <stop offset="1" stopColor={face.edge} />
        </radialGradient>
        <clipPath id={clip}><circle cx="50" cy="50" r="50" /></clipPath>
        {showsHands && (
          <radialGradient id={handGradient} gradientUnits="userSpaceOnUse" cx="-0.34" cy="-0.55" r="2.2">
            <stop offset="0" stopColor={mixHex(face.body, "#FFFFFF", 0.18)} />
            <stop offset="0.55" stopColor={face.body} />
            <stop offset="1" stopColor={mixHex(face.body, "#000000", 0.16)} />
          </radialGradient>
        )}
      </defs>
      <g data-face-breath>
        <circle cx="50" cy="50" r="50" fill={`url(#${gradient})`} />
        <g clipPath={`url(#${clip})`}>
          {eye(-1, "left")}
          {eye(1, "right")}
        </g>
        {showsHands && <PresetHands gradient={handGradient} edge={handEdge} />}
        {crown && <Crown testId="chief-badge" />}
      </g>
    </svg>
  );
}