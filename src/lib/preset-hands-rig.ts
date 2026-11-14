// The phone's hands, ported from BotHands.kt. A circle with two eyes can blink and look around, but it cannot say what
// it is feeling; these can: a hand under the chin while it thinks, a palm up in a shrug, a wave, sleepy cheeks. They are
// spring-driven, because a hand that lerps reads as a cut-out being slid around the face.
//
// Every value is in portrait radii: (0, 0) is the disc's centre, positive x is the viewer's right. Only an alive
// portrait gets hands; a 24px row hand would be a smudge and a list of waving faces is a crowd.
import { mix, type FaceMood, type FaceLife } from "./preset-face-rig";

const CURLS = 5;
const HAND_RISE = 0.34;
const POSITION_STIFFNESS = 90;
const POSITION_DAMPING = 13;
const ANGLE_STIFFNESS = 70;
const ANGLE_DAMPING = 11;
const ALPHA_RATE = 9;
const CURL_RATE = 16;
const TWO_PI = Math.PI * 2;

export class Hand {
  x = 0;
  y = 0;
  angle = 0;
  scale = 1;
  alpha = 0;
  palmOut = false;
  curls = new Float32Array(CURLS);
  private targetX = 0;
  private targetY = 0;
  private targetAngle = 0;
  private targetScale = 1;
  private targetAlpha = 0;
  private targetCurls = new Float32Array(CURLS);
  private velocityX = 0;
  private velocityY = 0;
  private velocityAngle = 0;
  private velocityScale = 0;

  aim(x: number, y: number, angle: number, scale = 1, visible = true, palmOut = false): void {
    this.targetX = x;
    this.targetY = y + HAND_RISE * (1 - this.alpha);
    this.targetAngle = angle;
    this.targetScale = scale;
    this.targetAlpha = visible ? 1 : 0;
    this.palmOut = palmOut;
  }

  aimHidden(): void {
    this.targetX = this.x;
    this.targetY = this.y;
    this.targetAngle = this.angle;
    this.targetScale = this.scale;
    this.targetAlpha = 0;
    this.clearCurls();
  }

  aimCurl(finger: number, degrees: number): void {
    if (finger >= 0 && finger < CURLS) this.targetCurls[finger] = degrees;
  }

  clearCurls(): void {
    this.targetCurls.fill(0);
  }

  /** The first frame: start where the pose asks, not at the origin. */
  snap(): void {
    this.x = this.targetX;
    this.y = this.targetY;
    this.angle = this.targetAngle;
    this.scale = this.targetScale;
    this.alpha = this.targetAlpha;
    this.curls.set(this.targetCurls);
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityAngle = 0;
    this.velocityScale = 0;
  }

  step(dt: number): void {
    this.velocityX += (POSITION_STIFFNESS * (this.targetX - this.x) - POSITION_DAMPING * this.velocityX) * dt;
    this.velocityY += (POSITION_STIFFNESS * (this.targetY - this.y) - POSITION_DAMPING * this.velocityY) * dt;
    this.x += this.velocityX * dt;
    this.y += this.velocityY * dt;
    this.velocityAngle += (ANGLE_STIFFNESS * (this.targetAngle - this.angle) - ANGLE_DAMPING * this.velocityAngle) * dt;
    this.angle += this.velocityAngle * dt;
    this.velocityScale += (ANGLE_STIFFNESS * (this.targetScale - this.scale) - ANGLE_DAMPING * this.velocityScale) * dt;
    this.scale += this.velocityScale * dt;
    const alphaRate = Math.min(1, dt * ALPHA_RATE);
    this.alpha += (this.targetAlpha - this.alpha) * alphaRate;
    const curlRate = Math.min(1, dt * CURL_RATE);
    for (let index = 0; index < CURLS; index += 1) this.curls[index] += (this.targetCurls[index]! - this.curls[index]!) * curlRate;
    if (![this.x, this.y, this.angle, this.scale].every(Number.isFinite)) this.snap();
  }

  /** The breathing drift every visible hand carries, added to whatever the gesture asked for. */
  driftBy(dx: number, dy: number, dAngle: number): void {
    if (this.targetAlpha <= 0) return;
    this.targetX += dx;
    this.targetY += dy;
    this.targetAngle += dAngle;
  }

  /** The head's tilt reaches the hand through the spring, a fraction of the way. */
  leanBy(degrees: number): void {
    if (this.targetAlpha > 0) this.targetAngle += degrees;
  }
}

export class Hands {
  shown = false;
  left = new Hand();
  right = new Hand();
  private lastMillis: number | null = null;

  start(shown: boolean): void {
    this.shown = shown;
    if (!shown) {
      this.left = new Hand();
      this.right = new Hand();
      this.lastMillis = null;
    }
  }

  tick(now: number): number | null {
    if (this.lastMillis === null) {
      this.lastMillis = now;
      return null;
    }
    const dt = Math.min(0.1, (now - this.lastMillis) / 1000);
    this.lastMillis = now;
    return dt;
  }

  step(dt: number): void {
    this.left.step(dt);
    this.right.step(dt);
  }

  snap(): void {
    this.left.snap();
    this.right.snap();
  }
}

const wiggle = (hand: Hand, now: number, amplitude: number, speed: number) => {
  for (let finger = 0; finger < 4; finger += 1) hand.aimCurl(finger, amplitude * Math.sin(now / speed + finger * 0.65));
  hand.aimCurl(4, amplitude * 0.4 * Math.sin(now / (speed * 1.4) + 1.7));
};

const drift = (hand: Hand, now: number, phase: number) => {
  hand.driftBy(
    0.010 * Math.sin(now / 3_900 + phase),
    0.012 * Math.sin(now / 3_100 + phase * 1.7),
    2 * Math.sin(now / 4_700 + phase * 0.6),
  );
};

const active = (local: number, duration: number) => local >= 0 && local < duration;

const wave = (local: number, now: number, out: Hands) => {
  if (!active(local, 2_800)) return;
  out.right.aim(0.91, -0.02, 15 * Math.sin((local / 1000) * TWO_PI * 2.05), 1.04, true, true);
  wiggle(out.right, local + now, 9, 95);
};

const shrug = (local: number, now: number, out: Hands) => {
  if (!active(local, 2_500)) return;
  const lift = 0.03 * Math.sin((local / 1000) * TWO_PI * 1.4);
  out.left.aim(-0.88, 0.32 + lift, -34, 1, true, true);
  out.right.aim(0.88, 0.32 + lift, 34, 1, true, true);
  wiggle(out.left, now, 3, 130);
  wiggle(out.right, now, 3, 130);
};

const cheer = (local: number, now: number, out: Hands) => {
  if (!active(local, 3_000)) return;
  const sway = 0.02 * Math.sin(local / 800);
  out.left.aim(-0.72 + sway, -0.42, -10, 1, true, true);
  out.right.aim(0.72 - sway, -0.42, 10, 1, true, true);
  wiggle(out.left, now, 6, 85);
  wiggle(out.right, now, 6, 85);
};

const cheeks = (local: number, now: number, out: Hands) => {
  if (!active(local, 2_600)) return;
  const bounce = 0.015 * Math.sin((local / 1000) * TWO_PI * 1.6);
  out.left.aim(-0.62, 0.55 + bounce, 16);
  out.right.aim(0.62, 0.55 + bounce, -16);
  wiggle(out.left, now, 4, 150);
  wiggle(out.right, now, 4, 150);
};

const ponder = (local: number, out: Hands) => {
  if (!active(local, 3_100)) return;
  const tap = 0.5 + 0.5 * Math.sin((local / 1000) * TWO_PI * 1.15);
  out.right.aim(0.18, 0.84 - 0.018 * tap, -28);
  out.right.aimCurl(0, 12 * tap);
  out.right.aimCurl(1, -3);
  out.right.aimCurl(2, 2);
  out.right.aimCurl(3, 4);
};

const idle = (now: number, seed: number, out: Hands) => {
  const slot = 8_000 + ((mix(seed + 31) >>> 8) % 5_000);
  const offset = (mix(seed + 71) >>> 8) % slot;
  const time = now + offset;
  const local = time % slot;
  switch ((mix(seed * 97 + Math.floor(time / slot)) >>> 9) % 10) {
    case 4:
    case 9: wave(local, now, out); break;
    case 5: shrug(local, now, out); break;
    case 6: cheer(local, now, out); break;
    case 7: cheeks(local, now, out); break;
    case 8: ponder(local, out); break;
    default: break;
  }
};

/** What the hands are doing at `now`, with the same spring state carried between frames. */
export function handsPose(now: number, seed: number, mood: FaceMood, life: FaceLife, rollDegrees: number, out: Hands): Hands {
  out.start(life === "alive");
  if (!out.shown) return out;
  const dt = out.tick(now);

  out.left.aimHidden();
  out.right.aimHidden();

  switch (mood) {
    case "thinking": {
      const tap = 0.5 + 0.5 * Math.sin((now / 1000) * TWO_PI * 1.15);
      out.right.aim(0.18, 0.84 - 0.018 * tap, -28);
      out.right.aimCurl(0, 12 * tap);
      out.right.aimCurl(1, -3);
      out.right.aimCurl(2, 2);
      out.right.aimCurl(3, 4);
      break;
    }
    case "working": {
      const beat = Math.sin((now / 1000) * TWO_PI * 3.1);
      out.left.aim(-0.55, 0.72 - 0.03 * Math.max(0, beat), 10);
      out.right.aim(0.55, 0.72 - 0.03 * Math.max(0, -beat), -10);
      out.left.aimCurl(0, -8 * Math.max(0, beat));
      out.left.aimCurl(1, -4 * Math.max(0, beat));
      out.right.aimCurl(0, -8 * Math.max(0, -beat));
      out.right.aimCurl(1, -4 * Math.max(0, -beat));
      break;
    }
    case "speaking": {
      const beat = Math.sin((now / 1000) * TWO_PI * 1.3);
      out.right.aim(0.72, 0.30 + 0.02 * beat, -12 + 8 * beat, 1, true, true);
      wiggle(out.right, now, 4, 110);
      break;
    }
    case "listening":
      out.right.aim(0.84, 0.10, 8);
      out.right.aimCurl(0, -4);
      out.right.aimCurl(4, -3);
      break;
    case "drowsy": {
      const breathe = Math.sin((now / 1000) * TWO_PI * 0.27);
      out.right.aim(0.44, 0.56 + 0.012 * breathe, -20 + 2 * breathe);
      const loose = 4 + 2 * breathe;
      out.right.aimCurl(0, -loose * 0.6);
      out.right.aimCurl(1, -loose * 0.3);
      out.right.aimCurl(2, loose * 0.3);
      out.right.aimCurl(3, loose * 0.7);
      out.right.aimCurl(4, loose * 0.5);
      break;
    }
    case "idle":
      idle(now, seed, out);
      break;
  }

  drift(out.left, now, 0);
  drift(out.right, now, 2.1);
  out.left.leanBy(rollDegrees * 0.35);
  out.right.leanBy(rollDegrees * 0.35);

  if (dt === null) out.snap();
  else out.step(dt);
  return out;
}

/** The phone's hand table, in palm radii; `left` mirrors x. Index, middle, ring, pinky, thumb. */
export const HAND_BASE_X = [-0.70, -0.24, 0.24, 0.70, -0.72];
export const HAND_TIP_X = [-0.74, -0.26, 0.28, 0.78, -1.42];
export const HAND_BASE_Y = [-0.52, -0.58, -0.56, -0.46, 0.16];
export const HAND_TIP_Y = [-1.56, -1.78, -1.64, -1.30, -0.62];
export const HAND_RADIUS = [0.155, 0.160, 0.155, 0.145, 0.175];
/** A palm facing the viewer is the hand seen from the other side: the mirrored table. */
export const handIsMirrored = (leftHand: boolean, palmOut: boolean): boolean => leftHand !== palmOut;