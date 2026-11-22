import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { engineReady } from "./EngineLibrary";

/** Providers whose accounts are listed together on one card, each signed in on its own. */
export type AccountGroup = "claude" | "chatgpt";

type AccountState = "signedIn" | "signedOut" | "unknown" | "unavailable";

function accountState(instance: InstanceInfo): AccountState {
  if (instance.snapshot.state !== "available") return "unavailable";
  return instance.snapshot.authenticated === true ? "signedIn" : instance.snapshot.authenticated === false ? "signedOut" : "unknown";
}

/** What an account's menu offers. Only accounts added here can be removed; each provider's first account stays. */
export function accountActions(group: AccountGroup, instance: InstanceInfo): { signOut: boolean; remove: boolean } {
  return {
    signOut: accountState(instance) === "signedIn" && instance.authentication?.signOut === true && instance.snapshot.account?.method !== "api-key",
    remove: group === "claude" ? instance.instanceId !== "claude" && instance.claudeAccount?.isDefault !== true : instance.instanceId.startsWith("chatgpt-"),
  };
}

/** Ready while any account can run a turn: the same rule a single provider card uses. */
export function accountsReady(accounts: InstanceInfo[]): boolean {
  return accounts.some(engineReady);
}

/** Names a new account and hands its id back, so the caller can start its sign-in at once. */
export function AddAccount({ label, endpoint, extra, folder: offerFolder = false, describedBy, onAdded }: {
  label: string;
  endpoint: string;
  extra?: Record<string, unknown>;
  folder?: boolean;
  describedBy?: string;
  onAdded: (instanceId: string) => void;
}) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (saving || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const body = { displayName: name.trim(), ...extra, ...(offerFolder && folder.trim() ? { configDir: folder.trim() } : {}) };
      const created = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
      if (Array.isArray(created.instances)) dispatch({ type: "instances", instances: created.instances });
      setOpen(false);
      setName("");
      setFolder("");
      if (typeof created.instanceId === "string") onAdded(created.instanceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} aria-describedby={describedBy} className="flex min-h-8 w-fit items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
        <Plus size={14} />{label}
      </button>
    );
  }
  return (
    <form data-add-account={endpoint} className="space-y-2.5 rounded-xl border border-hairline/50 bg-app p-3" onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("accounts.nameLabel")}
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("accounts.namePlaceholder")} maxLength={80} autoFocus required disabled={saving} aria-describedby={describedBy}
          className="rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] font-normal text-ink outline-none focus:border-accent-border disabled:opacity-50" />
      </label>
      {offerFolder && (
        <details className="text-[12px] text-ink-secondary">
          <summary className="cursor-pointer select-none hover:text-ink">{t("accounts.folderToggle")}</summary>
          <input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="~/.claude-work" maxLength={4096} spellCheck={false} disabled={saving}
            aria-label={t("accounts.folderToggle")}
            className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent-border disabled:opacity-50" />
          <p className="mt-1 leading-relaxed">{t("accounts.folderHint")}</p>
        </details>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => { setOpen(false); setError(null); }} disabled={saving} className="ui-button ui-button-md">{t("common.cancel")}</button>
        <button type="submit" disabled={saving || !name.trim()} className="ui-button ui-button-md ui-button-primary">
          {saving && <Loader2 size={13} className="animate-spin" />}{t("accounts.addSubmit")}
        </button>
      </div>
    </form>
  );
}

/** One card for a provider's accounts: who is signed in, one button for whoever is not, and one way to add another. */
