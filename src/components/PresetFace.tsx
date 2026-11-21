// The app's portrait: seven selectable styles (classic disc, moon-glass orb, porcelain neko, iridescent liquid,
// pocket synth, moon spirit, ceramic mini-bot) — ported from Android's BotFace.kt.
//
// BotFaceRig (src/lib/preset-face-rig.ts) schedules blinks, gaze, idle gestures and breath; this component ticks it
// on requestAnimationFrame and writes the pose straight to the SVG nodes, so a row of faces animates without React
// re-rendering any of them. The crown is drawn in the same SVG and leans with pose.roll and the gaze.
import { useEffect, useId, useRef } from "react";

import { useAvatarStyle, type AvatarStyleId } from "@/lib/avatar-style";
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

type EyeSpec = {
  left: { x: number; y: number };
  right: { x: number; y: number };
  width: number;
  height: number;
  faceTilt: number;
  eyeTilt: number;
  cosTilt: number;
  sinTilt: number;
  visor: boolean;
};

function eyeSpecFor(style: AvatarStyleId): EyeSpec {
  if (style === "classic") {
    return {
      left: LEFT_EYE,
      right: RIGHT_EYE,
      width: EYE_WIDTH * 100,
      height: EYE_LENGTH * 100,
      faceTilt: FACE_TILT_DEG,
      eyeTilt: EYE_TILT_DEG,
      cosTilt: COS_TILT,
      sinTilt: SIN_TILT,
      visor: false,
    };
  }
  if (style === "synth" || style === "minibot") {
    return {
      left: { x: -12.5, y: style === "synth" ? -5 : -1.5 },
      right: { x: 12.5, y: style === "synth" ? -5 : -1.5 },
      width: 9.2,
      height: 16,
      faceTilt: 0,
      eyeTilt: 0,
      cosTilt: 1,
      sinTilt: 0,
      visor: true,
    };
  }
  return {
    left: { x: -14.5, y: style === "neko" ? 2 : -1 },
    right: { x: 14.5, y: style === "neko" ? 2 : -1 },
    width: 10.6,
    height: 18.5,
    faceTilt: 0,
    eyeTilt: 0,
    cosTilt: 1,
    sinTilt: 0,
    visor: false,
  };
}



const EDGE_UNIT = 0.11;

const hexRgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff] as const;
};
const mixHex = (from: string, to: string, amount: number) => {
  const a = hexRgb(from);
  const b = hexRgb(to);
  return `#${[0, 1, 2].map((index) => Math.round(a[index]! + (b[index]! - a[index]!) * amount).toString(16).padStart(2, "0")).join("")}`;
};

const isLightBody = (body: string) => {
  const [r, g, b] = hexRgb(body);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
};

const handEdgeFor = (body: string) => (isLightBody(body) ? mixHex(body, "#000000", 0.16) : mixHex(body, "#FFFFFF", 0.22));

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

function FaceBody({
  style,
  face,
  gradient,
  opalGradient,
  specularGradient,
  bounceGradient,
  blushGradient,
  clip,
}: {
  style: AvatarStyleId;
  face: { light: string; body: string; edge: string; eye: string };
  gradient: string;
  opalGradient: string;
  specularGradient: string;
  bounceGradient: string;
  blushGradient: string;
  clip: string;
}) {
  const light = isLightBody(face.body);
  const rimStroke = light ? "rgba(28,28,30,0.12)" : "rgba(255,255,255,0.22)";

  switch (style) {
    case "orb":
      return (
        <>
          <circle cx="50" cy="50" r="49" fill={`url(#${gradient})`} />
          <g clipPath={`url(#${clip})`}>
            {/* Soft radial warm subsurface bounce + diffused porcelain specular + feathered blush */}
            <circle cx="50" cy="50" r="49" fill={`url(#${bounceGradient})`} />
            <ellipse cx="35" cy="26" rx="25" ry="18" transform="rotate(-22 35 26)" fill={`url(#${specularGradient})`} />
            <circle cx="24" cy="58" r="13.5" fill={`url(#${blushGradient})`} />
            <circle cx="76" cy="58" r="13.5" fill={`url(#${blushGradient})`} />
          </g>
          <circle cx="50" cy="50" r="49" fill="none" stroke={rimStroke} strokeWidth="1.5" />
        </>
      );

    case "neko":
      return (
        <>
          {/* Sculpted cat ears */}
          <path d="M18 36 L14 11 C13.5 7 18 5.5 21 8 L40 22 Z" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M82 36 L86 11 C86.5 7 82 5.5 79 8 L60 22 Z" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" strokeLinejoin="round" />
          {/* Soft blush inner ears */}
          <path d="M21 30 L18.5 15 L33 24 Z" fill="#F4A3B4" opacity={light ? 0.55 : 0.45} />
          <path d="M79 30 L81.5 15 L67 24 Z" fill="#F4A3B4" opacity={light ? 0.55 : 0.45} />
          {/* Rounded porcelain cat head */}
          <ellipse cx="50" cy="55" rx="45" ry="41" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.4" />
          <ellipse cx="36" cy="33" rx="20" ry="12" transform="rotate(-14 36 33)" fill={`url(#${specularGradient})`} />
          {/* Tiny nose + feathered blush */}
          <path d="M47 61.5 Q50 64.5 53 61.5 Q50 60 47 61.5 Z" fill={face.eye} opacity="0.72" />
          <circle cx="26" cy="61" r="12" fill={`url(#${blushGradient})`} />
          <circle cx="74" cy="61" r="12" fill={`url(#${blushGradient})`} />
        </>
      );

    case "liquid":
      return (
        <>
          <circle cx="50" cy="50" r="49" fill={`url(#${opalGradient})`} stroke="rgba(255,255,255,0.42)" strokeWidth="1.6" />
          <circle cx="50" cy="50" r="44.5" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
          <path d="M20 34 C28 16, 54 12, 72 22" fill="none" stroke="rgba(255,255,255,0.65)" strokeWidth="4.5" strokeLinecap="round" />
          <path d="M28 78 C44 86, 66 82, 78 68" fill="none" stroke={mixHex(face.light, "#A5F3FC", 0.5)} strokeWidth="3.5" strokeLinecap="round" opacity="0.55" />
        </>
      );

    case "synth":
      return (
        <>
          {/* Dieter Rams / Teenage Engineering pocket synth chassis */}
          <rect x="4" y="6" width="92" height="88" rx="22" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.6" />
          {/* Top-right coral status dial */}
          <circle cx="80" cy="18" r="4.2" fill="#FF5A36" stroke="rgba(0,0,0,0.25)" strokeWidth="0.9" />
          {/* Recessed obsidian LCD visor */}
          <rect x="15" y="25" width="70" height="39" rx="12" fill="#101216" stroke="rgba(255,255,255,0.16)" strokeWidth="1.2" />
          <rect x="18" y="28" width="64" height="12" rx="6" fill="rgba(255,255,255,0.06)" />
          {/* Speaker micro-grille dots */}
          {[32, 41, 50, 59, 68].map((cx) => (
            <circle key={cx} cx={cx} cy="77" r="2.1" fill={light ? "rgba(28,28,30,0.28)" : "rgba(255,255,255,0.32)"} />
          ))}
        </>
      );

    case "spirit":
      return (
        <>
          {/* Plump organic moon-spirit pebble with soft ear nubs */}
          <path
            d="M25 26 C21 15, 31 11, 37 20 C44 17, 56 17, 63 20 C69 11, 79 15, 75 26 C87 35, 92 49, 89 65 C86 83, 70 93, 50 93 C30 93, 14 83, 11 65 C8 49, 13 35, 25 26 Z"
            fill={`url(#${gradient})`}
            stroke={rimStroke}
            strokeWidth="1.4"
          />
          <ellipse cx="37" cy="33" rx="19" ry="11" transform="rotate(-12 37 33)" fill={`url(#${specularGradient})`} />
          <circle cx="26" cy="59" r="12.5" fill={`url(#${blushGradient})`} />
          <circle cx="74" cy="59" r="12.5" fill={`url(#${blushGradient})`} />
          {/* Floating champagne-gold crescent moon */}
          <path d="M84 8 A7.5 7.5 0 1 0 92 18 A5.8 5.8 0 1 1 84 8 Z" fill="#E8C77B" stroke="#B68E35" strokeWidth="0.6" />
        </>
      );

    case "minibot":
      return (
        <>
          {/* Floating brushed-gold halo ring */}
          <ellipse cx="50" cy="11" rx="22" ry="4.5" fill="none" stroke="#E2B95F" strokeWidth="3.2" />
          <ellipse cx="50" cy="10.3" rx="21" ry="3.8" fill="none" stroke="#F8E1A0" strokeWidth="1" opacity="0.85" />
          {/* Matte ceramic squircle head */}
          <rect x="7" y="18" width="86" height="75" rx="26" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.5" />
          {/* Side ear pods */}
          <rect x="2" y="44" width="6" height="22" rx="3" fill={face.edge} />
          <rect x="92" y="44" width="6" height="22" rx="3" fill={face.edge} />
          {/* Recessed obsidian glass visor */}
          <rect x="17" y="30" width="66" height="39" rx="16" fill="#0F1117" stroke="rgba(255,255,255,0.18)" strokeWidth="1.2" />
          <path d="M25 36 Q50 32 75 36" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="2.5" strokeLinecap="round" />
        </>
      );

    case "classic":
    default:
      return <circle cx="50" cy="50" r="50" fill={`url(#${gradient})`} />;
  }
}

export function PresetFace({ color, preset, avatarStyle, size = 44, label, className, life = "glance", mood = "idle", seed = 0 }: {
  color?: string | null;
  preset?: PresetKey;
  avatarStyle?: AvatarStyleId;
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
  const storedStyle = useAvatarStyle();
  const activeStyle = avatarStyle ?? storedStyle;
  const spec = eyeSpecFor(activeStyle);
  const face = FACES[preset ?? presetFaceForColor(color)];
  const light = isLightBody(face.body);
  const gradient = `preset-face-${id}`;
  const opalGradient = `preset-opal-${id}`;
  const specularGradient = `preset-spec-${id}`;
  const bounceGradient = `preset-bounce-${id}`;
  const blushGradient = `preset-blush-${id}`;
  const clip = `preset-clip-${id}`;
  const handGradient = `preset-hand-${id}`;
  const handEdge = handEdgeFor(face.body);
  const eyeFill = spec.visor ? "#F5F9FF" : face.eye;
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

    if (!breath || !eyes[0] || !eyes[1] || !rects[0] || !rects[1]) return;

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
      const gazeScale = spec.visor ? 34 : 50;
      const gazeX = poseGazeX * gazeScale * spec.cosTilt - poseGazeY * gazeScale * spec.sinTilt + poseLookX * gazeScale;
      const gazeY = poseGazeX * gazeScale * spec.sinTilt + poseGazeY * gazeScale * spec.cosTilt + poseLookY * gazeScale;
      const base = side === -1 ? spec.left : spec.right;
      const offsetX = base.x + gazeX;
      const offsetY = base.y + gazeY;
      const roll = (poseRoll * Math.PI) / 180;
      const cosRoll = Math.cos(roll);
      const sinRoll = Math.sin(roll);
      const x = offsetX * cosRoll - offsetY * sinRoll;
      const y = offsetX * sinRoll + offsetY * cosRoll;
      const height = Math.max(spec.height * open, spec.width * 0.34);
      eyes[index]!.setAttribute("transform", `translate(${50 + x} ${50 + y}) rotate(${spec.faceTilt + spec.eyeTilt + poseRoll})`);
      rects[index]!.setAttribute("y", String(-height / 2));
      rects[index]!.setAttribute("height", String(height));
    };

    const draw = (now: number) => {
      const asleep = life === "alive" && mood === "idle" && performance.now() - lastTouch > 45_000;
      const effectiveMood = asleep ? "drowsy" : mood;
      const look = showsHands && pointer
        ? lookAt(size / 2, size / 2, pointer.x, pointer.y, performance.now() - pointer.at)
        : [0, 0] as const;
      const pose = withLook(facePose(now, seed, effectiveMood, life), [look[0], look[1]]);
      breath.setAttribute("transform", `translate(50 50) scale(${pose.scale * (1 - pose.squash)} ${pose.scale * (1 + pose.squash)}) translate(-50 -50)`);
      moveEye(-1, pose.openLeft, 0, pose.roll, pose.gazeX, pose.gazeY, pose.lookX, pose.lookY);
      moveEye(1, pose.openRight, 1, pose.roll, pose.gazeX, pose.gazeY, pose.lookX, pose.lookY);

      if (hands) {
        handsPose(now, seed, effectiveMood, life, pose.roll, hands);
        for (const side of HAND_SIDES) {
          const hand = side === "left" ? hands.left : hands.right;
          const node = svg.querySelector<SVGGElement>(`[data-hand="${side}"]`);
          if (!node) continue;
          node.setAttribute("opacity", String(hand.alpha));
          node.setAttribute("transform", `translate(${50 + hand.x * 50} ${50 + hand.y * 50}) rotate(${hand.angle}) scale(${9.2 * hand.scale})`);
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
  }, [life, mood, seed, size, activeStyle, spec]);

  const eye = (side: 1 | -1, index: "left" | "right") => {
    const centre = side === -1 ? spec.left : spec.right;
    return (
      <g data-eye={index} transform={`translate(${50 + centre.x} ${50 + centre.y}) rotate(${spec.faceTilt + spec.eyeTilt})`}>
        <rect data-eye-rect={index} x={-spec.width / 2} y={-spec.height / 2} width={spec.width} height={spec.height} rx={spec.width / 2} fill={eyeFill} />
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
      data-avatar-style={activeStyle}
    >
      <defs>
        <radialGradient id={gradient} cx="32%" cy="22%" r="82%">
          <stop offset="0" stopColor={face.light} />
          <stop offset="0.55" stopColor={face.body} />
          <stop offset="1" stopColor={face.edge} />
        </radialGradient>
        <linearGradient id={opalGradient} x1="12%" y1="8%" x2="88%" y2="92%">
          <stop offset="0" stopColor={mixHex(face.light, "#FFFFFF", 0.35)} />
          <stop offset="0.38" stopColor={face.body} />
          <stop offset="0.72" stopColor={mixHex(face.body, "#A78BFA", 0.28)} />
          <stop offset="1" stopColor={mixHex(face.edge, "#38BDF8", 0.25)} />
        </linearGradient>
        <radialGradient id={specularGradient} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity={light ? "0.75" : "0.44"} />
          <stop offset="0.55" stopColor="#FFFFFF" stopOpacity={light ? "0.24" : "0.12"} />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={bounceGradient} cx="50%" cy="88%" r="52%">
          <stop offset="0" stopColor={mixHex(face.light, "#FFE0A3", 0.55)} stopOpacity={light ? "0.34" : "0.18"} />
          <stop offset="1" stopColor={mixHex(face.light, "#FFE0A3", 0.55)} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={blushGradient} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#FF9A7A" stopOpacity={light ? "0.32" : "0.22"} />
          <stop offset="0.55" stopColor="#FF9A7A" stopOpacity={light ? "0.12" : "0.07"} />
          <stop offset="1" stopColor="#FF9A7A" stopOpacity="0" />
        </radialGradient>
        <clipPath id={clip}><circle cx="50" cy="50" r="49" /></clipPath>
        {showsHands && (
          <radialGradient id={handGradient} gradientUnits="userSpaceOnUse" cx="-0.34" cy="-0.55" r="2.2">
            <stop offset="0" stopColor={mixHex(face.body, "#FFFFFF", 0.18)} />
            <stop offset="0.55" stopColor={face.body} />
            <stop offset="1" stopColor={mixHex(face.body, "#000000", 0.16)} />
          </radialGradient>
        )}
      </defs>
      <g data-face-breath>
        <FaceBody
          style={activeStyle}
          face={face}
          gradient={gradient}
          opalGradient={opalGradient}
          specularGradient={specularGradient}
          bounceGradient={bounceGradient}
          blushGradient={blushGradient}
          clip={clip}
        />
        <g clipPath={activeStyle === "classic" ? `url(#${clip})` : undefined}>
          {eye(-1, "left")}
          {eye(1, "right")}
        </g>
        {showsHands && <PresetHands gradient={handGradient} edge={handEdge} />}
      </g>
    </svg>
  );
}
