import type { CompanionAccountState } from "../types/ogb";
import type { CompanionState } from "./companion-types";

export type AccountBridge = NonNullable<NonNullable<Window["ogb"]>["companionAccount"]>;
type StateBridge<T> = { state: () => Promise<T> };

export const companionAccountBridge = (): AccountBridge | null =>
  // SAFETY: Electron exposes only these account operations and never sends credentials to the renderer.
  (globalThis as { ogb?: { companionAccount?: AccountBridge } }).ogb?.companionAccount ?? null;

export const loadCompanionBridgeState = async (
  companion: StateBridge<CompanionState> | null,
  remote: StateBridge<CompanionAccountState> | null,
): Promise<{ companion: CompanionState | null; account: CompanionAccountState | null }> => {
  const [companionResult, accountResult] = await Promise.allSettled([
    companion ? Promise.resolve().then(() => companion.state()) : Promise.resolve(null),
    remote ? Promise.resolve().then(() => remote.state()) : Promise.resolve(null),
  ]);
  return {
    companion: companionResult.status === "fulfilled" ? companionResult.value : null,
    account: accountResult.status === "fulfilled" ? accountResult.value : null,
  };
};

export const shouldHydrateCompanionEmail = (
  userEdited: boolean,
  account: CompanionAccountState,
): boolean => !userEdited && Boolean(account.email);

export const companionAccountActionError = (
  account: CompanionAccountState | null,
  actionError: string | null,
): string | null => {
  if (actionError) return actionError;
  return account?.status === "signed-out" ? account.message ?? null : null;
};