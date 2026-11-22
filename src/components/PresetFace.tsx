// The app's portrait: eighteen selectable styles (orb, neko, liquid, synth, spirit, minibot, bunny, astro, prism,
// bear, retro, fox, frog, owl, ghost, camera, cloud, classic) — synced with Android's BotFace.kt.
//
// BotFaceRig (src/lib/preset-face-rig.ts) schedules blinks, gaze, idle gestures and breath; this component ticks it
// on requestAnimationFrame and writes the pose straight to the SVG nodes, so a row of faces animates without React
// re-rendering any of them. The crown is drawn in the same SVG and leans with pose.roll and the gaze.
import { useEffect, useId, useRef } from "react";

import { useAvatarStyle, type AvatarStyleId } from "@/lib/avatar-style";
import { cn } from "@/lib/cn";
import type { MausState } from "@/lib/mascot";
import { facePose, lookAt, withLook, type FaceLife, type FaceMood } from "@/lib/preset-face-rig";
import { handsPose, Hands, handIsMirrored, HAND_BASE_X, HAND_BASE_Y, HAND_RADIUS, HAND_TIP_X, HAND_TIP_Y } from "@/lib/preset-hands-rig";
import { mascotFaceInk, type MascotFaceColor } from "../../shared/bot-avatar";
import { isPresetStyleBody, type BotBodyId } from "../../shared/bot-body";

type PresetKey =
  | "black"
  | "white"
  | "silver"
  | "blue"
  | "cyan"
  | "orange"
  | "yellow"
  | "purple"
  | "pink"
  | "green"
  | "teal"
  | "mint"
  | "red"
  | "coral"
  | "grey";

const FACES: Record<PresetKey, { light: string; body: string; edge: string; eye: string; warm?: boolean }> = {
  black:  { light: "#373A40", body: "#191B1F", edge: "#0A0B0D", eye: "#F8FAFC" },
  white:  { light: "#FFFFFF", body: "#F5F2EC", edge: "#DCD6CC", eye: "#1C1C1E", warm: true },
  silver: { light: "#EEF1F6", body: "#D5DCE6", edge: "#B4BECA", eye: "#1C1E24" },
  grey:   { light: "#C7CCD4", body: "#9FA6B2", edge: "#7E8591", eye: "#181A1F" },
  blue:   { light: "#DCEBFF", body: "#B6D4FA", edge: "#8CB6EC", eye: "#182233" },
  cyan:   { light: "#D6F5FA", body: "#A5E3EE", edge: "#7AC8D8", eye: "#13262B" },
  teal:   { light: "#D3F3EE", body: "#9EDCD2", edge: "#74BFB4", eye: "#132624" },
  green:  { light: "#D8F2E2", body: "#A8DFBE", edge: "#7DC49B", eye: "#16291E" },
  mint:   { light: "#DFF7EB", body: "#B3E8CE", edge: "#89CFAF", eye: "#162920" },
  yellow: { light: "#FFF4D1", body: "#F7DF94", edge: "#E2C063", eye: "#2B2313", warm: true },
  orange: { light: "#FFE7D4", body: "#F7C49B", edge: "#E19E6E", eye: "#2E1E14", warm: true },
  coral:  { light: "#FFE0DA", body: "#F6B7AC", edge: "#DE8F82", eye: "#2E1917", warm: true },
  red:    { light: "#FDE0E0", body: "#F2B5B7", edge: "#D98C91", eye: "#2D1719", warm: true },
  pink:   { light: "#FCE2F0", body: "#F2BEDB", edge: "#DA98BE", eye: "#2B1824", warm: true },
  purple: { light: "#ECE3FF", body: "#CFC0F8", edge: "#AC98E5", eye: "#201833" },
};

/** Maps every bot palette colour cleanly to its unified PresetFace swatch. */
export function presetFaceForColor(color: string | null | undefined): PresetKey {
  switch (color?.toLowerCase()) {
    case "blue": return "blue";
    case "cyan": return "cyan";
    case "orange": return "orange";
    case "yellow": return "yellow";
    case "red": return "red";
    case "coral": return "coral";
    case "green": return "green";
    case "teal": return "teal";
    case "mint": return "mint";
    case "purple":
    case "violet": return "purple";
    case "pink": return "pink";
    case "silver": return "silver";
    case "grey":
    case "gray": return "grey";
    case "white":
    case "cream":
    case "sand":
    case "chrome": return "white";
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
  if (style === "synth" || style === "minibot" || style === "astro" || style === "retro" || style === "camera") {
    const y = style === "retro" ? -9 : style === "synth" ? -5 : style === "astro" ? -2 : style === "camera" ? 5 : -1.5;
    const x = style === "camera" ? 9.5 : style === "astro" ? 13 : 12.5;
    return {
      left: { x: -x, y },
      right: { x, y },
      width: style === "camera" ? 8.2 : style === "astro" ? 9.4 : 9.2,
      height: style === "camera" ? 14.5 : style === "retro" ? 15.5 : style === "astro" ? 16.5 : 16,
      faceTilt: 0,
      eyeTilt: 0,
      cosTilt: 1,
      sinTilt: 0,
      visor: true,
    };
  }
  if (style === "frog") {
    return {
      left: { x: -21, y: -18 },
      right: { x: 21, y: -18 },
      width: 10.6,
      height: 13,
      faceTilt: 0,
      eyeTilt: 0,
      cosTilt: 1,
      sinTilt: 0,
      visor: false,
    };
  }
  if (style === "fox" || style === "cloud") {
    return {
      left: { x: -13.5, y: 4 },
      right: { x: 13.5, y: 4 },
      width: 10.2,
      height: 17.5,
      faceTilt: 0,
      eyeTilt: 0,
      cosTilt: 1,
      sinTilt: 0,
      visor: false,
    };
  }
  if (style === "owl") {
    return {
      left: { x: -14, y: -2 },
      right: { x: 14, y: -2 },
      width: 10.4,
      height: 17.5,
      faceTilt: 0,
      eyeTilt: 0,
      cosTilt: 1,
      sinTilt: 0,
      visor: false,
    };
  }
  if (style === "wisp") {
    return {
      left: { x: -12.5, y: -4 },
      right: { x: 12.5, y: -4 },
      width: 10.2,
      height: 17.5,
      faceTilt: 0,
      eyeTilt: 0,
      cosTilt: 1,
      sinTilt: 0,
      visor: false,
    };
  }
  if (style === "bunny") {
    return {
      left: { x: -13.5, y: 5 },
      right: { x: 13.5, y: 5 },
      width: 10.2,
      height: 17.5,
      faceTilt: 0,
      eyeTilt: 0,
      cosTilt: 1,
      sinTilt: 0,
      visor: false,
    };
  }
  if (style === "bear") {
    return {
      left: { x: -14.5, y: -3 },
      right: { x: 14.5, y: -3 },
      width: 10.2,
      height: 17,
      faceTilt: 0,
      eyeTilt: 0,
      cosTilt: 1,
      sinTilt: 0,
      visor: false,
    };
  }
  if (style === "prism") {
    return {
      left: { x: -13.5, y: 0 },
      right: { x: 13.5, y: 0 },
      width: 10.4,
      height: 18,
      faceTilt: 0,
      eyeTilt: 0,
      cosTilt: 1,
      sinTilt: 0,
      visor: false,
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
  face: { light: string; body: string; edge: string; eye: string; warm?: boolean };
  gradient: string;
  opalGradient: string;
  specularGradient: string;
  bounceGradient: string;
  blushGradient: string;
  clip: string;
}) {
  const light = isLightBody(face.body);
  const rimStroke = light ? "rgba(24,24,28,0.14)" : "rgba(255,255,255,0.22)";
  const innerEarFill = face.warm ? mixHex(face.edge, "#F497AE", 0.45) : mixHex(face.edge, "#FFFFFF", 0.52);

  switch (style) {
    case "orb":
      return (
        <>
          <circle cx="50" cy="50" r="45" fill={`url(#${gradient})`} />
          <g clipPath={`url(#${clip})`}>
            {/* Soft neutral studio bounce + diffused porcelain specular + tone-matched cheek glow */}
            <circle cx="50" cy="50" r="45" fill={`url(#${bounceGradient})`} />
            <ellipse cx="36" cy="28" rx="23" ry="16" transform="rotate(-22 36 28)" fill={`url(#${specularGradient})`} />
            <circle cx="26" cy="57" r="12.5" fill={`url(#${blushGradient})`} />
            <circle cx="74" cy="57" r="12.5" fill={`url(#${blushGradient})`} />
          </g>
          <circle cx="50" cy="50" r="45" fill="none" stroke={rimStroke} strokeWidth="1.5" />
        </>
      );

    case "neko":
      return (
        <>
          {/* Sculpted cat ears */}
          <path d="M19 37 L15 13 C14.5 9 19 7.5 22 10 L40 24 Z" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M81 37 L85 13 C85.5 9 81 7.5 78 10 L60 24 Z" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" strokeLinejoin="round" />
          {/* Harmonious inner ears */}
          <path d="M22 31 L19.5 17 L33 25 Z" fill={innerEarFill} opacity={light ? 0.5 : 0.36} />
          <path d="M78 31 L80.5 17 L67 25 Z" fill={innerEarFill} opacity={light ? 0.5 : 0.36} />
          {/* Rounded porcelain cat head */}
          <ellipse cx="50" cy="55" rx="43" ry="39" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.4" />
          <ellipse cx="36" cy="34" rx="19" ry="11" transform="rotate(-14 36 34)" fill={`url(#${specularGradient})`} />
          {/* Tiny nose + tone-matched cheek glow */}
          <path d="M47 61 Q50 64 53 61 Q50 59.5 47 61 Z" fill={face.eye} opacity="0.72" />
          <circle cx="27" cy="60" r="11.5" fill={`url(#${blushGradient})`} />
          <circle cx="73" cy="60" r="11.5" fill={`url(#${blushGradient})`} />
        </>
      );

    case "liquid":
      return (
        <>
          <circle cx="50" cy="50" r="45" fill={`url(#${opalGradient})`} stroke="rgba(255,255,255,0.42)" strokeWidth="1.6" />
          <circle cx="50" cy="50" r="41" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
          <path d="M22 35 C30 19, 54 15, 70 24" fill="none" stroke="rgba(255,255,255,0.65)" strokeWidth="4.2" strokeLinecap="round" />
          <path d="M30 76 C44 83, 64 79, 76 66" fill="none" stroke={mixHex(face.light, "#FFFFFF", 0.6)} strokeWidth="3.2" strokeLinecap="round" opacity="0.48" />
        </>
      );

    case "synth":
      return (
        <>
          {/* Dieter Rams / Teenage Engineering pocket synth chassis */}
          <rect x="8" y="9" width="84" height="82" rx="20" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.6" />
          {/* Top-right coral status dial */}
          <circle cx="78" cy="20" r="4" fill="#FF5A36" stroke="rgba(0,0,0,0.25)" strokeWidth="0.9" />
          {/* Recessed obsidian LCD visor */}
          <rect x="18" y="27" width="64" height="36" rx="11" fill="#101216" stroke="rgba(255,255,255,0.16)" strokeWidth="1.2" />
          <rect x="21" y="30" width="58" height="11" rx="5.5" fill="rgba(255,255,255,0.06)" />
          {/* Speaker micro-grille dots */}
          {[33, 41.5, 50, 58.5, 67].map((cx) => (
            <circle key={cx} cx={cx} cy="75" r="2" fill={light ? "rgba(28,28,30,0.28)" : "rgba(255,255,255,0.32)"} />
          ))}
        </>
      );

    case "spirit":
      return (
        <>
          {/* Plump organic moon-spirit pebble normalized to match optical size of orb/classic */}
          <path
            d="M22 22 C18 10, 29 6, 36 16 C43 13, 57 13, 64 16 C71 6, 82 10, 78 22 C91 32, 95 48, 92 66 C89 85, 72 95, 50 95 C28 95, 11 85, 8 66 C5 48, 9 32, 22 22 Z"
            fill={`url(#${gradient})`}
            stroke={rimStroke}
            strokeWidth="1.4"
          />
          <ellipse cx="36" cy="30" rx="20" ry="12" transform="rotate(-12 36 30)" fill={`url(#${specularGradient})`} />
          <circle cx="24" cy="59" r="13" fill={`url(#${blushGradient})`} />
          <circle cx="76" cy="59" r="13" fill={`url(#${blushGradient})`} />
          {/* Floating champagne-gold crescent moon */}
          <path d="M87 6 A7.5 7.5 0 1 0 95 16 A5.8 5.8 0 1 1 87 6 Z" fill="#E8C77B" stroke="#B68E35" strokeWidth="0.6" />
        </>
      );

    case "minibot":
      return (
        <>
          {/* Floating brushed-gold halo ring */}
          <ellipse cx="50" cy="10" rx="21" ry="4.2" fill="none" stroke="#E2B95F" strokeWidth="3" />
          <ellipse cx="50" cy="9.3" rx="20" ry="3.5" fill="none" stroke="#F8E1A0" strokeWidth="1" opacity="0.85" />
          {/* Matte ceramic squircle head */}
          <rect x="8" y="17" width="84" height="75" rx="25" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.5" />
          {/* Side ear pods */}
          <rect x="3" y="44" width="6" height="22" rx="3" fill={face.edge} />
          <rect x="91" y="44" width="6" height="22" rx="3" fill={face.edge} />
          {/* Recessed obsidian glass visor */}
          <rect x="18" y="30" width="64" height="38" rx="15" fill="#0F1117" stroke="rgba(255,255,255,0.18)" strokeWidth="1.2" />
          <path d="M26 36 Q50 32 74 36" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="2.4" strokeLinecap="round" />
        </>
      );

    case "bunny":
      return (
        <>
          {/* Sculpted tall rounded rabbit ears */}
          <ellipse cx="32" cy="25" rx="10" ry="20" transform="rotate(-11 32 25)" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" />
          <ellipse cx="68" cy="25" rx="10" ry="20" transform="rotate(11 68 25)" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" />
          {/* Harmonious inner ears */}
          <ellipse cx="32" cy="26" rx="5" ry="13" transform="rotate(-11 32 26)" fill={innerEarFill} opacity={light ? 0.5 : 0.36} />
          <ellipse cx="68" cy="26" rx="5" ry="13" transform="rotate(11 68 26)" fill={innerEarFill} opacity={light ? 0.5 : 0.36} />
          {/* Plump porcelain bunny head */}
          <ellipse cx="50" cy="59" rx="40" ry="35" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.4" />
          <ellipse cx="37" cy="40" rx="18" ry="10" transform="rotate(-14 37 40)" fill={`url(#${specularGradient})`} />
          <ellipse cx="50" cy="64.5" rx="3.4" ry="2.2" fill={face.eye} opacity="0.68" />
          <circle cx="26" cy="64" r="11" fill={`url(#${blushGradient})`} />
          <circle cx="74" cy="64" r="11" fill={`url(#${blushGradient})`} />
        </>
      );

    case "astro":
      return (
        <>
          {/* Side metallic comm-pods */}
          <rect x="3" y="42" width="7" height="20" rx="3.5" fill={face.edge} stroke={rimStroke} strokeWidth="0.8" />
          <rect x="90" y="42" width="7" height="20" rx="3.5" fill={face.edge} stroke={rimStroke} strokeWidth="0.8" />
          {/* Space-age rounded ceramic helmet */}
          <circle cx="50" cy="50" r="44" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.5" />
          <ellipse cx="38" cy="20" rx="18" ry="8" transform="rotate(-14 38 20)" fill={`url(#${specularGradient})`} />
          {/* Wide panoramic obsidian dome visor */}
          <rect x="16" y="25" width="68" height="44" rx="22" fill="#0E1118" stroke="rgba(255,255,255,0.22)" strokeWidth="1.3" />
          <path d="M27 33 Q46 27 68 32" fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth="3" strokeLinecap="round" />
          {/* Lower chin comm-vent pill */}
          <rect x="42" y="77" width="16" height="3.6" rx="1.8" fill={light ? "rgba(24,24,28,0.22)" : "rgba(255,255,255,0.26)"} />
        </>
      );

    case "prism":
      return (
        <>
          {/* Softly rounded octagonal crystal gem silhouette */}
          <path
            d="M34 8 L66 8 Q73 8 78 13 L87 22 Q92 27 92 34 L92 66 Q92 73 87 78 L78 87 Q73 92 66 92 L34 92 Q27 92 22 87 L13 78 Q8 73 8 66 L8 34 Q8 27 13 22 L22 13 Q27 8 34 8 Z"
            fill={`url(#${gradient})`}
            stroke={rimStroke}
            strokeWidth="1.5"
          />
          {/* Translucent geometric crystal facets */}
          <path d="M22 13 L66 8 L50 32 L13 54 L8 34 Q8 27 13 22 Z" fill="#FFFFFF" opacity={light ? 0.3 : 0.15} />
          <path d="M92 48 L92 66 Q92 73 87 78 L78 87 Q73 92 66 92 L46 92 L64 68 Z" fill={face.edge} opacity={light ? 0.28 : 0.34} />
          <path d="M18 68 L68 18 L79 26 L29 76 Z" fill="#FFFFFF" opacity={light ? 0.16 : 0.09} />
          <path
            d="M35.5 12 L64.5 12 Q70 12 74 16 L84 26 Q88 30 88 35.5 L88 64.5 Q88 70 84 74 L74 84 Q70 88 64.5 88 L35.5 88 Q30 88 26 84 L16 74 Q12 70 12 64.5 L12 35.5 Q12 30 16 26 L26 16 Q30 12 35.5 12 Z"
            fill="none"
            stroke="rgba(255,255,255,0.42)"
            strokeWidth="1.1"
          />
        </>
      );

    case "bear":
      return (
        <>
          {/* Symmetrical round plush bear ears */}
          <circle cx="22" cy="23" r="15.5" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.3" />
          <circle cx="78" cy="23" r="15.5" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.3" />
          <circle cx="22" cy="23" r="8.2" fill={innerEarFill} opacity={light ? 0.52 : 0.36} />
          <circle cx="78" cy="23" r="8.2" fill={innerEarFill} opacity={light ? 0.52 : 0.36} />
          {/* Plump matte ceramic bear head */}
          <ellipse cx="50" cy="54" rx="43" ry="39.5" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.4" />
          <ellipse cx="36" cy="31" rx="19" ry="10.5" transform="rotate(-14 36 31)" fill={`url(#${specularGradient})`} />
          {/* Soft lightened ceramic muzzle + harmonized nose */}
          <ellipse cx="50" cy="64" rx="16.5" ry="11.5" fill={mixHex(face.light, "#FFFFFF", 0.55)} opacity={light ? 0.72 : 0.22} />
          <path d="M45.5 60.5 Q50 58.8 54.5 60.5 Q52.5 65.5 50 65.5 Q47.5 65.5 45.5 60.5 Z" fill={face.eye} opacity="0.82" />
          <circle cx="25" cy="61" r="11.5" fill={`url(#${blushGradient})`} />
          <circle cx="75" cy="61" r="11.5" fill={`url(#${blushGradient})`} />
        </>
      );

    case "retro":
      return (
        <>
          {/* Classic compact CRT desktop computer chassis */}
          <rect x="9" y="8" width="82" height="84" rx="17" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.6" />
          <path d="M22 13 H78" stroke="rgba(255,255,255,0.45)" strokeWidth="2" strokeLinecap="round" opacity={light ? 0.7 : 0.28} />
          {/* Recessed dark phosphor CRT screen */}
          <rect x="18" y="18" width="64" height="46" rx="10" fill="#121A17" stroke="rgba(255,255,255,0.18)" strokeWidth="1.2" />
          <path d="M24 23 Q50 19.5 76 23" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="2.2" strokeLinecap="round" />
          {/* Lower-left floppy/vent slot + lower-right emerald status LED */}
          <rect x="22" y="74.5" width="28" height="4.2" rx="2.1" fill={light ? "rgba(24,24,28,0.24)" : "rgba(255,255,255,0.28)"} />
          <circle cx="74" cy="76.6" r="3.4" fill="#34D399" stroke="rgba(0,0,0,0.2)" strokeWidth="0.8" />
        </>
      );

    case "fox":
      return (
        <>
          {/* Tall sculpted pointed fox ears */}
          <path d="M20 44 L13 10 C12.5 7 17 6 20 8.5 L42 26 Z" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M80 44 L87 10 C87.5 7 83 6 80 8.5 L58 26 Z" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M22 36 L17.5 14.5 L35 26 Z" fill={innerEarFill} opacity={light ? 0.52 : 0.36} />
          <path d="M78 36 L82.5 14.5 L65 26 Z" fill={innerEarFill} opacity={light ? 0.52 : 0.36} />
          {/* Softly tapered ceramic fox head with cheek tufts */}
          <path
            d="M14 54 C14 34, 30 24, 50 24 C70 24, 86 34, 86 54 C86 63, 93 66, 86 73 C77 82, 62 91, 50 91 C38 91, 23 82, 14 73 C7 66, 14 63, 14 54 Z"
            fill={`url(#${gradient})`}
            stroke={rimStroke}
            strokeWidth="1.4"
          />
          <ellipse cx="37" cy="38" rx="17" ry="9.5" transform="rotate(-14 37 38)" fill={`url(#${specularGradient})`} />
          {/* Lightened lower cheek fur contour */}
          <path d="M16 69 Q30 62 46 72 Q32 84 16 69 Z" fill={mixHex(face.light, "#FFFFFF", 0.55)} opacity={light ? 0.55 : 0.16} />
          <path d="M84 69 Q70 62 54 72 Q68 84 84 69 Z" fill={mixHex(face.light, "#FFFFFF", 0.55)} opacity={light ? 0.55 : 0.16} />
          <path d="M46 65 Q50 63.5 54 65 Q52 69 50 69 Q48 69 46 65 Z" fill={face.eye} opacity="0.82" />
          <circle cx="27" cy="63" r="10.5" fill={`url(#${blushGradient})`} />
          <circle cx="73" cy="63" r="10.5" fill={`url(#${blushGradient})`} />
        </>
      );

    case "frog":
      return (
        <>
          {/* Two symmetrical rounded dome eye-bumps */}
          <circle cx="29" cy="32" r="16.5" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.3" />
          <circle cx="71" cy="32" r="16.5" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.3" />
          {/* Plump wide ceramic frog head */}
          <ellipse cx="50" cy="59" rx="43" ry="33" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.4" />
          {/* Smooth join fill over eye domes */}
          <circle cx="29" cy="33" r="15" fill={`url(#${gradient})`} />
          <circle cx="71" cy="33" r="15" fill={`url(#${gradient})`} />
          <ellipse cx="48" cy="42" rx="20" ry="9" fill={`url(#${specularGradient})`} />
          <circle cx="24" cy="61" r="11.5" fill={`url(#${blushGradient})`} />
          <circle cx="76" cy="61" r="11.5" fill={`url(#${blushGradient})`} />
        </>
      );

    case "owl":
      return (
        <>
          {/* Sculpted owl ear-tuft horns */}
          <path d="M21 30 L15 11 C15 8.5 19.5 8 22.5 11 L35 21 Z" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M79 30 L85 11 C85 8.5 80.5 8 77.5 11 L65 21 Z" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" strokeLinejoin="round" />
          {/* Plump ceramic owl head */}
          <ellipse cx="50" cy="55" rx="41" ry="38" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.4" />
          {/* Soft lightened heart-shaped facial disc */}
          <path
            d="M50 38 C42 29, 21 32, 21 50 C21 67, 36 77, 50 80 C64 77, 79 67, 79 50 C79 32, 58 29, 50 38 Z"
            fill={mixHex(face.light, "#FFFFFF", 0.55)}
            opacity={light ? 0.65 : 0.18}
          />
          <ellipse cx="36" cy="32" rx="16" ry="9" transform="rotate(-14 36 32)" fill={`url(#${specularGradient})`} />
          {/* Warm champagne-gold diamond beak */}
          <path d="M50 53 L54.8 59.5 L50 65.5 L45.2 59.5 Z" fill="#DFB664" stroke="#A88233" strokeWidth="0.8" strokeLinejoin="round" />
        </>
      );

    case "wisp":
      return (
        <>
          {/* Minimalist floating ceramic ghost with 3-wave scalloped hem */}
          <path
            d="M16 46 C16 20, 31 10, 50 10 C69 10, 84 20, 84 46 L86 78 C86 87, 79 91, 73 86 C68 81, 63 81, 59 87 C55 92, 45 92, 41 87 C37 81, 32 81, 27 86 C21 91, 14 87, 14 78 Z"
            fill={`url(#${gradient})`}
            stroke={rimStroke}
            strokeWidth="1.4"
          />
          <ellipse cx="38" cy="27" rx="16" ry="10" transform="rotate(-18 38 27)" fill={`url(#${specularGradient})`} />
          <circle cx="29" cy="55" r="10.5" fill={`url(#${blushGradient})`} />
          <circle cx="71" cy="55" r="10.5" fill={`url(#${blushGradient})`} />
        </>
      );

    case "camera":
      return (
        <>
          {/* Coral-orange shutter button + top viewfinder hump */}
          <rect x="17" y="15" width="13" height="6" rx="3" fill="#FF6B4A" stroke="rgba(0,0,0,0.18)" strokeWidth="0.8" />
          <path d="M33 22 L37 13 Q39 10 43 10 L57 10 Q61 10 63 13 L67 22 Z" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.3" strokeLinejoin="round" />
          {/* Matte ceramic rangefinder body */}
          <rect x="8" y="21" width="84" height="68" rx="16" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.6" />
          {/* Metallic lens barrel ring + recessed obsidian lens */}
          <circle cx="50" cy="55" r="26.5" fill={face.edge} stroke={rimStroke} strokeWidth="1.1" />
          <circle cx="50" cy="55" r="23" fill="#0F1117" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
          <path d="M36 44 Q48 35 62 41" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="2.6" strokeLinecap="round" />
        </>
      );

    case "cloud":
      return (
        <>
          {/* Sculpted puffy five-lobe ceramic cloud */}
          <path
            d="M25 81 C13 81, 6 72, 6 61 C6 51, 13 43, 22 41 C22 30, 31 22, 42 22 C45 14, 53 10, 62 12 C72 14, 79 22, 80 33 C89 35, 95 44, 95 54 C95 66, 86 76, 75 78 C71 84, 62 87, 52 87 C43 87, 35 84, 31 81 Z"
            fill={`url(#${gradient})`}
            stroke={rimStroke}
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <ellipse cx="43" cy="30" rx="17" ry="9" transform="rotate(-12 43 30)" fill={`url(#${specularGradient})`} />
          <circle cx="29" cy="60" r="11" fill={`url(#${blushGradient})`} />
          <circle cx="71" cy="60" r="11" fill={`url(#${blushGradient})`} />
        </>
      );

    case "classic":
    default:
      return <circle cx="50" cy="50" r="45" fill={`url(#${gradient})`} stroke={rimStroke} strokeWidth="1.2" />;
  }
}

export function PresetFace({ color, preset, avatarStyle, bodyId, faceColor, expression, size = 44, label, className, life = "glance", mood = "idle", seed = 0 }: {
  color?: string | null;
  preset?: PresetKey;
  avatarStyle?: AvatarStyleId;
  bodyId?: BotBodyId | null;
  faceColor?: MascotFaceColor | null;
  expression?: MausState;
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
  const activeStyle: AvatarStyleId = avatarStyle ?? (isPresetStyleBody(bodyId) ? bodyId : storedStyle);
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
  const customInk = mascotFaceInk(faceColor);
  const eyeFill = spec.visor ? (activeStyle === "retro" ? "#E6FFF5" : "#F5F9FF") : (customInk ?? face.eye);
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
          <stop offset="0" stopColor={mixHex(face.light, "#FFFFFF", 0.42)} />
          <stop offset="0.42" stopColor={face.body} />
          <stop offset="0.75" stopColor={mixHex(face.body, face.light, 0.35)} />
          <stop offset="1" stopColor={face.edge} />
        </linearGradient>
        <radialGradient id={specularGradient} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity={light ? "0.72" : "0.42"} />
          <stop offset="0.55" stopColor="#FFFFFF" stopOpacity={light ? "0.22" : "0.11"} />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={bounceGradient} cx="50%" cy="88%" r="52%">
          <stop offset="0" stopColor={mixHex(face.light, "#FFFFFF", 0.55)} stopOpacity={light ? "0.26" : "0.16"} />
          <stop offset="1" stopColor={mixHex(face.light, "#FFFFFF", 0.55)} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={blushGradient} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor={face.warm ? "#EB8B9E" : (light ? "#D495B8" : mixHex(face.light, "#FFFFFF", 0.45))} stopOpacity={face.warm ? (light ? "0.22" : "0.16") : (light ? "0.18" : "0.14")} />
          <stop offset="0.55" stopColor={face.warm ? "#EB8B9E" : (light ? "#D495B8" : mixHex(face.light, "#FFFFFF", 0.45))} stopOpacity={face.warm ? (light ? "0.08" : "0.05") : (light ? "0.06" : "0.04")} />
          <stop offset="1" stopColor={face.warm ? "#EB8B9E" : (light ? "#D495B8" : mixHex(face.light, "#FFFFFF", 0.45))} stopOpacity="0" />
        </radialGradient>
        <clipPath id={clip}><circle cx="50" cy="50" r="45" /></clipPath>
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
          {expression === "sleeping" ? (
            <>
              <path d={`M${50 + spec.left.x - 6} ${50 + spec.left.y + 1} Q${50 + spec.left.x} ${50 + spec.left.y + 6} ${50 + spec.left.x + 6} ${50 + spec.left.y + 1}`} fill="none" stroke={eyeFill} strokeWidth="3.4" strokeLinecap="round" />
              <path d={`M${50 + spec.right.x - 6} ${50 + spec.right.y + 1} Q${50 + spec.right.x} ${50 + spec.right.y + 6} ${50 + spec.right.x + 6} ${50 + spec.right.y + 1}`} fill="none" stroke={eyeFill} strokeWidth="3.4" strokeLinecap="round" />
            </>
          ) : (
            <>
              {eye(-1, "left")}
              {eye(1, "right")}
            </>
          )}
        </g>
        {showsHands && <PresetHands gradient={handGradient} edge={handEdge} />}
      </g>
    </svg>
  );
}
