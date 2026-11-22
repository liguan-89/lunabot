import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { registerPresence } from "../../lib/presence";
import { t } from "../../lib/i18n";

/** Enrolls this device's platform authenticator so high-risk approvals can demand a fingerprint or face. */
export function PresenceCard({ webauthn, onEnrolled }: { webauthn?: { required: boolean; enrolled: number }; onEnrolled(enrolled: number): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enrolled = webauthn?.enrolled ?? 0;
  if (!webauthn?.required && enrolled === 0 && typeof navigator !== "undefined" && !navigator.credentials) return null;
  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await registerPresence();
      onEnrolled(result.enrolled);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section data-keys-section="presence" className="rounded-xl bg-card p-4 in-data-[settings-look=simple]:rounded-[16px] in-data-[settings-look=simple]:border-[0.5px] in-data-[settings-look=simple]:border-(--settings-edge) in-data-[settings-look=simple]:bg-menu in-data-[settings-look=simple]:py-3.5">
      <div className="flex items-start gap-3">
        <Fingerprint size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium leading-5 text-ink">{t("keys.presence.title")}</div>
          <div className="text-[13px] leading-[18px] text-ink-secondary">
            {webauthn?.required ? t("keys.presence.hintRequired") : t("keys.presence.hint")}
          </div>
          {error && <div className="mt-1 text-[13px] leading-[18px] text-danger">{error}</div>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {enrolled > 0 && <span className="text-[12px] leading-4 text-ink-secondary">{t("keys.presence.enrolled", { count: enrolled })}</span>}
          <button type="button" data-presence-register className="ui-button" disabled={busy} onClick={() => void register()}>
            {t(enrolled > 0 ? "keys.presence.registerAnother" : "keys.presence.register")}
          </button>
        </div>
      </div>
    </section>
  );
}
