import { Loader2, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { api } from "@/state/store";
import type { PackageSummary } from "../../shared/package-format";

import { ConfirmDialog } from "./ConfirmDialog";
import { TEAM_GLYPHS } from "./TeamImportDetails";

export interface TemplateEntry {
  slug: string;
  savedAt: string;
  summary: PackageSummary;
}

function templateDay(savedAt: string): string | null {
  if (!savedAt) return null;
  const date = new Date(savedAt);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(intlLocale());
}

export function MyTemplates({ onPreview, onDialog }: {
  onPreview: (document: unknown) => void;
  /** The delete confirmation is open over Templates, so Templates must leave its keys alone. */
  onDialog: (open: boolean) => void;
}) {
  const [entries, setEntries] = useState<TemplateEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TemplateEntry | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns the template list.
      const list = (await api("/api/templates")) as { templates: TemplateEntry[] };
      setEntries(list.templates);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (entry: TemplateEntry) => {
    setBusy(entry.slug);
    setError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns the stored package document.
      const stored = (await api(`/api/templates/${entry.slug}`)) as { document: unknown };
      onPreview(stored.document);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const closeConfirm = () => {
    setConfirming(null);
    onDialog(false);
  };

  const remove = async (entry: TemplateEntry) => {
    closeConfirm();
    setBusy(entry.slug);
    setError("");
    try {
      await api(`/api/templates/${entry.slug}`, { method: "DELETE" });
      setEntries((current) => current?.filter((row) => row.slug !== entry.slug) ?? current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (entries !== null && entries.length === 0 && !error) return null;
  return (
    <section className="mb-8" aria-labelledby="my-templates-title">
      <h3 id="my-templates-title" className="mb-3 text-[12px] font-medium text-ink-secondary">{t("templates.mine")}</h3>
      {entries === null && !error && (
        <div className="flex items-center gap-2 py-4 text-[13px] text-ink-secondary">
          <Loader2 size={14} className="animate-spin" /> {t("templates.loading")}
        </div>
      )}
      {entries === null && error && (
        <div className="rounded-xl bg-danger/10 p-4 text-[13px] text-danger">
          <p>{error}</p>
          <button onClick={() => void load()} className="mt-3 rounded-full bg-raised px-3.5 py-2 text-ink hover:bg-raised-hover">{t("common.tryAgain")}</button>
        </div>
      )}
      {entries !== null && (
        <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
          {entries.map((entry, index) => {
            const day = templateDay(entry.savedAt);
            const meta = [
              entry.summary.counts.bots > 0 && t("templates.botCount", { count: entry.summary.counts.bots }),
              day && t("templates.mineSaved", { date: day }),
            ].filter(Boolean).join(" · ");
            return (
              <article key={entry.slug} className="flex min-h-[84px] items-center gap-3 border-b border-hairline/35 px-1 py-4">
                <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}>
                  <Users size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="truncate text-[14px] font-medium text-ink">{entry.summary.name}</h4>
                  {(entry.summary.tagline || entry.summary.botNames.length > 0) && (
                    <p className="mt-0.5 truncate text-[13px] text-ink-secondary">{entry.summary.tagline || entry.summary.botNames.join(", ")}</p>
                  )}
                  {meta && <p className="mt-1 truncate text-[12px] text-ink-tertiary">{meta}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => void install(entry)}
                    disabled={busy !== null}
                    aria-label={t("templates.installAria", { name: entry.summary.name })}
                    className="flex min-w-[72px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
                  >
                    {busy === entry.slug && <Loader2 size={13} className="animate-spin" />}
                    {busy === entry.slug ? t("templates.loadingShort") : t("templates.install")}
                  </button>
                  <button
                    onClick={() => {
                      setConfirming(entry);
                      onDialog(true);
                    }}
                    disabled={busy !== null}
                    aria-label={t("templates.deleteAria", { name: entry.summary.name })}
                    className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {entries !== null && error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
      <ConfirmDialog
        open={confirming !== null}
        title={t("templates.deleteTitle", { name: confirming?.summary.name ?? "" })}
        body={t("templates.deleteBody")}
        confirmLabel={t("common.delete")}
        icon={<Trash2 size={18} />}
        onCancel={closeConfirm}
        onConfirm={() => {
          if (confirming) void remove(confirming);
        }}
      />
    </section>
  );
}
