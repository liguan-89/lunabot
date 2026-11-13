// Plan usage was read from Claude Code and Codex logins. Those engines are gone; the report stays
// loadable and empty so the Usage page and its routines render no rows instead of failing.
import type { InstanceConfigMap } from "./contracts.ts";

export type PlanDriver = "claude" | "codex" | "grok" | "opencode";

export interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

/** Money in the provider's minor units: 4631 with exponent 2 is 46.31. */
export interface PlanSpend {
  usedMinor: number;
  limitMinor: number;
  currency: string;
  exponent: number;
}

export interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
  spend?: PlanSpend;
}

export interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

export interface PlanProviderRow {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProviderRow[];
}

export interface PlanAccount {
  id: string;
  name: string;
  driver: PlanDriver;
  environment: Record<string, string | undefined>;
  configDir?: string;
  noUsage?: true;
}

export async function loadPlanUsage(_input: { accounts: PlanAccount[]; refresh?: boolean }): Promise<PlanUsageReport> {
  return { fetchedAt: new Date().toISOString(), providers: [] };
}

export function planAccountsFromInstances(_configs: InstanceConfigMap): PlanAccount[] {
  return [];
}

export function claudeHasExtraUsageRoom(..._args: unknown[]): boolean {
  return false;
}