export declare const MARKET_ORIGIN: string;
export declare const MARKET_API_ORIGIN: string;
export declare const MARKET_CLIENT_ID: string;
export declare const MARKET_SCOPES: readonly string[];

export interface MarketUser {
  id: number;
  username?: string;
  display_name?: string;
}

export type MarketStatus = "signed-out" | "connecting" | "signed-in";

export interface MarketSessionState {
  status: MarketStatus;
  message?: string;
  user?: MarketUser;
}

export type MarketBillingPeriod = "month" | "quarter" | "year";
export type MarketPaymentMethod = "epay" | "balance";

export interface MarketPlan {
  plan_code: string;
  tier_code: string;
  title: string;
  subtitle?: string;
  billing_period: MarketBillingPeriod;
  months: 1 | 3 | 12;
  price_usd: number;
  list_price_usd: number;
  discount_percent: 0 | 10 | 20;
  currency: "USD";
  token_quota: number;
  quota_usd: number;
  days: number;
  models: string[];
  payment_methods: MarketPaymentMethod[];
  sort_order: number;
}

export type MarketSubscriptionStatus = "active" | "expiring" | "expired" | "canceled";

export interface MarketSubscriptionToken {
  id: number;
  masked: string;
  created_at: number;
}

export interface MarketSubscription {
  subscription_id: string;
  plan_code: string;
  plan_title: string;
  status: MarketSubscriptionStatus;
  started_at: number;
  expires_at: number;
  quota_total: number;
  quota_used: number;
  quota_remaining: number;
  models: string[];
  /** null when a legacy row's Token row is gone; rotate rebuilds it. */
  token: MarketSubscriptionToken | null;
}

export type MarketCheckoutState = "pending_payment" | "paid" | "active" | "failed" | "expired" | "canceled";

export interface MarketCheckout {
  checkout_id: string;
  status: MarketCheckoutState;
  /** The one-time pay page; absent when the order settled without a checkout (balance). */
  url?: string;
  expires_at?: number;
}

export interface MarketCheckoutStatus {
  checkout_id: string;
  status: MarketCheckoutState;
  subscription_id?: string;
  paid_at?: number;
  expires_at: number;
}

export interface MarketToken {
  token: string;
  token_id: number;
  expires_at: number;
  models: string[];
}

export interface MarketInstall {
  instanceId: string;
  models: string[];
  expiresAt: number;
  url: string;
  installed: true;
}

export interface MarketInstalled {
  subscriptionId: string;
  instanceId: string;
  expiresAt: number;
}

export interface MarketClient {
  start(): Promise<MarketSessionState>;
  state(): MarketSessionState;
  signIn(): Promise<MarketSessionState>;
  signOut(): Promise<MarketSessionState>;
  plans(): Promise<{ contractVersion: 1; plans: MarketPlan[] }>;
  subscriptions(): Promise<{ contractVersion: 1; subscriptions: MarketSubscription[] }>;
  checkout(planCode: string, paymentMethod?: MarketPaymentMethod): Promise<MarketCheckout>;
  checkoutStatus(checkoutId: string): Promise<MarketCheckoutStatus>;
  waitForCheckout(checkoutId: string, options?: { intervalMs?: number; timeoutMs?: number }): Promise<MarketCheckoutStatus>;
  revealToken(subscriptionId: string): Promise<MarketToken>;
  rotateToken(subscriptionId: string): Promise<MarketToken>;
}

export interface MarketBridge {
  state(): Promise<MarketSessionState>;
  plans(): Promise<{ contractVersion: 1; plans: MarketPlan[] }>;
  subscriptions(): Promise<{ contractVersion: 1; subscriptions: MarketSubscription[] }>;
  signIn(): Promise<MarketSessionState>;
  signOut(): Promise<MarketSessionState>;
  checkout(planCode: string, paymentMethod?: MarketPaymentMethod): Promise<MarketCheckout>;
  checkoutStatus(checkoutId: string): Promise<MarketCheckoutStatus>;
  install(subscriptionId: string): Promise<MarketInstall>;
  installed(): Promise<MarketInstalled | null>;
  manage(): Promise<void>;
  onState(callback: (state: MarketSessionState) => void): () => void;
}

export interface MarketPkce {
  verifier: string;
  challenge: string;
  state: string;
}

export declare class MarketError extends Error {
  code: string;
  status: number;
  requestId: string;
}

export declare function marketOrigin(value?: string, fixture?: boolean): string;
export declare function marketTarget(env?: Record<string, string | undefined>): { origin: string; apiOrigin: string; fixture: boolean };
export declare function createPkce(): MarketPkce;
export declare function createMarketStore(options: {
  file: string;
  encryption: {
    available(): boolean | Promise<boolean>;
    encrypt(value: string): Buffer | Promise<Buffer>;
    decrypt(value: Buffer): string | { result: string } | Promise<string>;
  };
}): { read(): Promise<unknown>; write(value: unknown): Promise<void> };
export declare function createMarketClient(options: {
  store: { read(): Promise<unknown>; write(value: unknown): Promise<void> };
  openBrowser: (url: string) => Promise<void> | void;
  origin?: string;
  apiOrigin?: string;
  clientId?: string;
  scopes?: readonly string[];
  fixture?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  onState?: (state: MarketSessionState) => void;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  waitMs?: number;
}): MarketClient;