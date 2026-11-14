// Saved payment cards: sealed under a key of their own beside the file (the VaultStore pattern), so a
// PAN/CVC never sits in plaintext and never leaves this computer through backups or workspace files.
// What routes and tools may read is the wire view (shared/payment-card.ts): display fields only.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { loginUsableBy } from "../shared/logins.ts";
import { normalizePaymentCard, type CardBrand, type PaymentCardInput, type PaymentCardView } from "../shared/payment-card.ts";
import { writeFileAtomic } from "./atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "./browser-sites.ts";

export const PAYMENT_CARDS_FILE = "payment-cards.json.enc";
export const PAYMENT_CARDS_KEY_FILE = "payment-cards-key";
export const PAYMENT_CARDS_MAX = 20;

const botsSchema = z.union([z.literal("all"), z.array(z.string().min(1).max(200)).max(100)]);

const diskCardSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  brand: z.string().min(1).max(20),
  last4: z.string().regex(/^\d{4}$/),
  pan: z.string().regex(/^\d{13,19}$/),
  cvc: z.string().regex(/^\d{3,4}$/),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2000).max(2099),
  holder: z.string().max(120).optional(),
  bots: botsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
}).strict();

const fileSchema = z.object({ version: z.literal(1), cards: z.array(diskCardSchema).max(PAYMENT_CARDS_MAX) });

type StoredCard = z.infer<typeof diskCardSchema>;
type StoreFile = z.infer<typeof fileSchema>;
const EMPTY: StoreFile = { version: 1, cards: [] };

/** The fields fillCard needs: the one place a PAN and CVC leave the store. */
export interface PaymentCardSecrets {
  pan: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  holder?: string;
}

const view = (card: StoredCard): PaymentCardView => {
  const { pan: _pan, cvc: _cvc, ...rest } = card;
  return { ...rest, brand: rest.brand as CardBrand };
};

export class PaymentCards {
  private readonly file: string;
  private readonly keyFile: string;
  private readonly now: () => number;
  private cache: StoreFile | null = null;
  private unreadableWarned = false;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, PAYMENT_CARDS_FILE);
    this.keyFile = join(options.dataDir, PAYMENT_CARDS_KEY_FILE);
    this.now = options.now ?? Date.now;
  }

  private key(create: boolean): string | null {
    try {
      const existing = readFileSync(this.keyFile, "utf8").trim();
      if (/^[0-9a-f]{64}$/u.test(existing)) return existing;
    } catch {
    }
    if (!create) return null;
    const key = randomBytes(32).toString("hex");
    mkdirSync(join(this.keyFile, ".."), { recursive: true });
    writeFileAtomic(this.keyFile, `${key}\n`, { mode: 0o600 });
    return key;
  }

  private read(): StoreFile {
    if (this.cache) return this.cache;
    let data = EMPTY;
    if (existsSync(this.file)) {
      const key = this.key(false);
      try {
        if (!key) throw new Error("missing key");
        data = fileSchema.parse(JSON.parse(decryptBrowserState(readFileSync(this.file), key)));
      } catch {
        // Never log an unreadable file's contents.
        if (!this.unreadableWarned) console.warn("payment cards: the saved cards file could not be opened; it will be replaced on the next save");
        this.unreadableWarned = true;
      }
    }
    this.cache = data;
    return data;
  }

  private write(data: StoreFile): void {
    const parsed = fileSchema.parse(data);
    const key = this.key(true)!;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, encryptBrowserState(JSON.stringify(parsed), key), { mode: 0o600 });
    this.cache = parsed;
  }

  list(botId?: string): PaymentCardView[] {
    return this.read().cards.filter((card) => !botId || loginUsableBy(card, botId)).map(view);
  }

  /** The fill values for one card a bot may use. Server-only: never crosses a route. */
  secrets(id: string, botId: string): PaymentCardSecrets | null {
    const card = this.read().cards.find((row) => row.id === id && loginUsableBy(row, botId));
    if (!card) return null;
    return { pan: card.pan, cvc: card.cvc, expMonth: card.expMonth, expYear: card.expYear, ...(card.holder ? { holder: card.holder } : {}) };
  }

  add(input: PaymentCardInput): { ok: true; card: PaymentCardView } | { ok: false; problem: string } {
    const normalized = normalizePaymentCard(input);
    if (!normalized.ok) return normalized;
    const data = this.read();
    if (data.cards.length >= PAYMENT_CARDS_MAX) return { ok: false, problem: "limit" };
    const { pan, cvc, ...rest } = normalized.value;
    const at = this.now();
    const same = data.cards.find((card) => card.pan === pan);
    if (same) {
      const updated: StoredCard = { ...same, ...rest, pan, cvc, updatedAt: at };
      this.write({ ...data, cards: data.cards.map((card) => (card.id === same.id ? updated : card)) });
      return { ok: true, card: view(updated) };
    }
    const card: StoredCard = { id: randomUUID(), ...rest, pan, cvc, createdAt: at, updatedAt: at };
    this.write({ ...data, cards: [...data.cards, card] });
    return { ok: true, card: view(card) };
  }

  remove(id: string): boolean {
    const data = this.read();
    if (!data.cards.some((card) => card.id === id)) return false;
    this.write({ ...data, cards: data.cards.filter((card) => card.id !== id) });
    return true;
  }

  markUsed(id: string): void {
    const data = this.read();
    const card = data.cards.find((row) => row.id === id);
    if (!card) return;
    this.write({ ...data, cards: data.cards.map((row) => (row.id === id ? { ...row, lastUsedAt: this.now() } : row)) });
  }
}
