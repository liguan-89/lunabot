// The phone's flat-portrait rig, ported from BotFace.kt's BotFaceRig. It is pure: time in, a pose out, so the renderer
// can tick a canvas or an SVG without React re-rendering, and the schedule can be tested on its own.
//
// A face with only a blink reads as a screensaver. Blinks cluster at the end of a jittered period, the gaze saccades
// every few seconds and drifts while it rests, an idle face tips and squints between saccades, a rare wink gives it a
// sense of humour, and an alive portrait breathes (grows a little while it narrows a little).

export type FaceLife = "still" | "glance" | "alive";
export type FaceMood = "idle" | "thinking" | "working" | "speaking" | "listening" | "drowsy";

export interface FacePose {
  openLeft: number;
  openRight: number;
  gazeX: number;
  gazeY: number;
  scale: number;
  squash: number;
  /** Degrees the whole face tips. */
  roll: number;
  /** Where a finger asked the eyes to look, in screen axes and face radii. */
  lookX: number;
  lookY: number;
}

export const RESTING_POSE: FacePose = { openLeft: 1, openRight: 1, gazeX: 0, gazeY: 0, scale: 1, squash: 0, roll: 0, lookX: 0, lookY: 0 };

interface FaceGesture {
  roll?: number;
  squint?: number;
  lookX?: number;
  lookY?: number;
}

const GESTURES: FaceGesture[] = [
  {},
  {},
  { roll: -4.5 },
  { roll: 4.5 },
  { squint: 0.74 },
  { squint: 1.12 },
  { lookX: -0.05, lookY: -0.03 },
  { lookX: 0.05, lookY: 0.02 },
  { roll: -3, lookY: -0.03 },
  { roll: 3, lookY: 0.03 },
];

const BLINK_MILLIS = 320;
const WINK_MILLIS = 620;
const LOOK_MILLIS = 1_800;
const LOOK_HOLD_MILLIS = 260;
const LOOK_STRENGTH = 0.13;

/** A cheap integer hash: the same seed must schedule the same face. */
export function mix(value: number): number {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b | 0);
  h ^= h >>> 16;
  return h | 0;
}

/** Where the gaze rests between saccades: mostly on the person looking at it. */
const anchor = (seed: number, index: number): [number, number] => {
  switch ((mix(seed * 131 + index) >>> 10) & 7) {
    case 0:
    case 1:
    case 2: return [0, 0];
    case 3: return [-0.045, 0.010];
    case 4: return [0.050, 0.015];
    case 5: return [-0.030, -0.025];
    case 6: return [0.035, -0.020];
    default: return [0.010, 0.035];
  }
};

/** How closed one blink is at `since` milliseconds after it started. */
export function blinkPulse(since: number): number {
  if (since < 0 || since > BLINK_MILLIS) return 0;
  if (since < 80) return since / 80;
  if (since < 110) return 1;
  const u = (since - 110) / (BLINK_MILLIS - 110);
  return 1 - u * u * (3 - 2 * u);
}

/** A wink is quicker and held longer than a blink: a deliberate gesture, not a lid falling. */
export function winkPulse(since: number): number {
  if (since < 0 || since > WINK_MILLIS) return 0;
  if (since < 70) return since / 70;
  if (since < 230) return 1;
  const u = (since - 230) / (WINK_MILLIS - 230);
  return 1 - u * u * (3 - 2 * u);
}

/** Where a finger asks the eyes to look, in face radii, on screen axes. */
export function lookAt(centreX: number, centreY: number, pointerX: number, pointerY: number, ageMillis: number): [number, number] {
  if (ageMillis < 0 || ageMillis > LOOK_MILLIS) return [0, 0];
  const dx = pointerX - centreX;
  const dy = pointerY - centreY;
  const distance = Math.hypot(dx, dy);
  if (distance < 24) return [0, 0];
  const weight = ageMillis <= LOOK_HOLD_MILLIS
    ? 1
    : (() => {
      const left = (LOOK_MILLIS - ageMillis) / (LOOK_MILLIS - LOOK_HOLD_MILLIS);
      return left * left;
    })();
  const reach = Math.min(distance / 160, 1);
  const amount = LOOK_STRENGTH * weight * reach;
  return [(dx / distance) * amount, (dy / distance) * amount];
}

/** The whole schedule: blink, gaze, gestures, mood, breath. */
export function facePose(now: number, seed: number, mood: FaceMood = "idle", life: FaceLife = "glance"): FacePose {
  if (life === "still") return { ...RESTING_POSE };

  const base = mood === "thinking" || mood === "working" ? 5_400
    : mood === "listening" ? 6_200
      : mood === "drowsy" ? 9_600
        : life === "glance" ? 8_400 : 4_300;
  const period = base + ((mix(seed) >>> 8) % 900);
  const phase = (mix(seed + 17) >>> 8) % period;
  const t = now + phase;
  const cycle = Math.floor(t / period);
  const local = t - cycle * period;

  const jitter = (mix(seed * 31 + cycle) >>> 8) % 800;
  const first = period - 340 - jitter;
  const double = (mix(seed * 97 + cycle) >>> 9) % 6 === 0;
  const second = double ? first + 330 : Number.NEGATIVE_INFINITY;

  const closed = (since: number) => Math.max(blinkPulse(local - since), blinkPulse(local - second));
  let openLeft = 1 - closed(first);
  let openRight = 1 - closed(first + 18);

  const gazePeriod = 2_900 + ((mix(seed + 5) >>> 8) % 1_700);
  const gazeIndex = Math.floor(t / gazePeriod);
  const gazeLocal = t % gazePeriod;
  const from = anchor(seed, gazeIndex - 1);
  const to = anchor(seed, gazeIndex);
  const move = Math.min(1, Math.max(0, gazeLocal / 95));
  const eased = move * move * (3 - 2 * move);
  let gazeX = from[0] + (to[0] - from[0]) * eased + 0.005 * Math.sin(t / 1_900);
  let gazeY = from[1] + (to[1] - from[1]) * eased + 0.004 * Math.sin(t / 2_300);

  let roll = 0;
  if (mood === "idle") {
    const gesturePeriod = 2_200 + ((mix(seed + 13) >>> 8) % 1_800);
    const gestureIndex = Math.floor(t / gesturePeriod);
    const gestureLocal = t % gesturePeriod;
    const gesture = GESTURES[(mix(seed * 17 + gestureIndex) >>> 9) % GESTURES.length]!;
    const active = gestureLocal < 260 ? gestureLocal / 260
      : gestureLocal < 640 ? 1
        : gestureLocal < 900 ? 1 - (gestureLocal - 640) / 260
          : 0;
    const amount = active * active * (3 - 2 * active);
    if (amount > 0) {
      gazeX += (gesture.lookX ?? 0) * amount;
      gazeY += (gesture.lookY ?? 0) * amount;
      roll = (gesture.roll ?? 0) * amount;
      const squint = 1 + ((gesture.squint ?? 1) - 1) * amount;
      openLeft *= squint;
      openRight *= squint;
    }
  }

  if (life === "alive" && mood === "idle") roll += 0.8 * Math.sin(t / 7_300);

  if (mood === "idle") {
    const winkPeriod = 13_000 + ((mix(seed + 71) >>> 8) % 9_000);
    const closedByWink = winkPulse(t % winkPeriod);
    if (closedByWink > 0) openRight *= 1 - 0.88 * closedByWink;
  }

  switch (mood) {
    case "thinking":
      gazeY -= 0.050;
      gazeX += 0.010 * Math.sin(t / 700);
      openLeft *= 0.88;
      openRight *= 0.92;
      break;
    case "working":
      gazeY -= 0.035;
      openLeft *= 0.92;
      openRight *= 0.94;
      break;
    case "speaking":
      gazeX *= 0.5;
      gazeY -= 0.010;
      break;
    case "listening":
      gazeX *= 0.35;
      gazeY *= 0.35;
      openLeft *= 1.08;
      openRight *= 1.08;
      break;
    case "drowsy": {
      gazeY += 0.045;
      roll += 2.2 * Math.sin(t / 4_100);
      const lid = 0.55 + 0.30 * (0.5 + 0.5 * Math.sin(t / 2_600));
      openLeft *= lid;
      openRight *= lid;
      break;
    }
    case "idle":
      break;
  }

  const breath = life === "alive" ? Math.sin(t / 3_400) : 0;
  const depth = mood === "drowsy" ? 1.5 : 1;
  return {
    openLeft: Math.max(0.04, openLeft),
    openRight: Math.max(0.04, openRight),
    gazeX,
    gazeY,
    scale: 1 + 0.012 * depth * breath,
    squash: 0.009 * depth * Math.sin(t / 3_400 - 0.7),
    roll,
    lookX: 0,
    lookY: 0,
  };
}

/** The pose while a finger holds the face's gaze; the rig's own gaze is added by the renderer. */
export function withLook(pose: FacePose, look: [number, number]): FacePose {
  return { ...pose, lookX: look[0], lookY: look[1] };
}

/** The mascot state a bot is already in, seen as attention rather than as a mouth. */
export function moodForState(state: string | null | undefined): FaceMood {
  switch (state) {
    case "working":
    case "searching": return "working";
    case "thinking":
    case "confused":
    case "curious": return "thinking";
    case "listening":
    case "dictating": return "listening";
    case "sleeping":
    case "drowsy": return "drowsy";
    case "writing":
    case "sending": return "speaking";
    default: return "idle";
  }
}

/** A stable seed for a bot: its id, never its colour, so two bots with one palette do not blink in unison. */
export function seedOf(text: string | null | undefined): number {
  let hash = 0;
  for (const character of text ?? "") hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return hash;
}