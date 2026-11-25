// Automatic spoken replies can start on the desktop and a paired phone from the same stream. These leases are advisory
// coordination between the two clients, not playback state: a crashed client disappears at expiry instead of locking a turn.

export const SPEECH_LISTENER_TTL_MS = 15_000;
export const SPEECH_CLAIM_TTL_MS = 30_000;

export type SpeechClaimant = { kind: "desktop" } | { kind: "phone"; deviceId: string };

interface ListenerRow {
  deviceId: string;
  expiresAt: number;
}

interface ClaimRow {
  owner: string;
  expiresAt: number;
}

const ownerKey = (claimant: SpeechClaimant): string => claimant.kind === "desktop" ? "desktop" : `phone:${claimant.deviceId}`;

export class SpeechArbitration {
  private readonly listeners = new Map<string, ListenerRow>();
  private readonly claims = new Map<string, ClaimRow>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  phoneListener(deviceId: string, active = true): void {
    if (!active) {
      this.listeners.delete(deviceId);
      return;
    }
    this.listeners.set(deviceId, { deviceId, expiresAt: this.now() + SPEECH_LISTENER_TTL_MS });
  }

  phoneListening(): boolean {
    this.prune();
    return this.listeners.size > 0;
  }

  claim(threadId: string, turnId: string | undefined, claimant: SpeechClaimant): { ok: true; key: string } | { ok: false; reason: "phone-listening" | "claimed" } {
    this.prune();
    const owner = ownerKey(claimant);
    if (claimant.kind === "desktop" && this.listeners.size > 0) return { ok: false, reason: "phone-listening" };
    const key = `${threadId}\n${turnId ?? ""}`;
    const existing = this.claims.get(key);
    if (existing && existing.owner !== owner) return { ok: false, reason: "claimed" };
    this.claims.set(key, { owner, expiresAt: this.now() + SPEECH_CLAIM_TTL_MS });
    return { ok: true, key };
  }

  private prune(): void {
    const at = this.now();
    for (const [id, row] of this.listeners) if (row.expiresAt <= at) this.listeners.delete(id);
    for (const [key, row] of this.claims) if (row.expiresAt <= at) this.claims.delete(key);
  }
}
