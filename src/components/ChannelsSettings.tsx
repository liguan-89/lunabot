import { useEffect, useState, type FormEvent } from "react";
import { Loader2, MessageSquare } from "lucide-react";

import type { EmailStatus } from "../../shared/email";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { Card } from "./SettingsPrimitives";
import { Select } from "./Select";

type ChannelKey = "feishu" | "dingtalk" | "wecom" | "botMail" | "sms" | "wechat";

interface FieldSpec {
  key: string;
  label: LocaleKey;
  /** A credential typed once and never echoed back; a blank input keeps the stored value. */
  secret?: boolean;
  /** The mailbox picker: the address must be one of the connected Email accounts. */
  mailbox?: boolean;
}

const FIELD_SPECS: Record<ChannelKey, readonly FieldSpec[]> = {
  feishu: [{ key: "appId", label: "settings.channels.field.appId" }, { key: "appSecret", label: "settings.channels.field.appSecret", secret: true }],
  dingtalk: [{ key: "appKey", label: "settings.channels.field.appKey" }, { key: "appSecret", label: "settings.channels.field.appSecret", secret: true }],
  wecom: [
    { key: "corpId", label: "settings.channels.field.corpId" }, { key: "corpSecret", label: "settings.channels.field.corpSecret", secret: true },
    { key: "token", label: "settings.channels.field.token", secret: true }, { key: "encodingAesKey", label: "settings.channels.field.encodingAesKey", secret: true },
    { key: "agentId", label: "settings.channels.field.agentId" },
  ],
  botMail: [{ key: "address", label: "settings.channels.field.address", mailbox: true }],
  sms: [{ key: "owners", label: "settings.channels.field.smsOwners" }],
  wechat: [],
};

const NAME_KEYS: Record<ChannelKey, LocaleKey> = {
  feishu: "settings.channels.feishu.name",
  dingtalk: "settings.channels.dingtalk.name",
  wecom: "settings.channels.wecom.name",
  botMail: "settings.channels.botMail.name",
  sms: "settings.channels.sms.name",
  wechat: "settings.channels.wechat.name",
};
const FIELD = "w-full min-w-0 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60";

export function ChannelsSettings() {
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const [open, setOpen] = useState<ChannelKey | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState<ChannelKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emails, setEmails] = useState<string[] | null>(null);

  const config = state.config;
  const bots = state.bots;

  useEffect(() => {
    if (!ownerOrAdmin || emails !== null) return;
    api<EmailStatus>("/api/email")
      .then((status) => setEmails((status.accounts ?? []).map((account) => account.address)))
      .catch(() => setEmails([]));
  }, [ownerOrAdmin, emails]);

  if (!ownerOrAdmin) return <Card title={t("settings.channels.title")} subtitle={t("settings.channels.adminOnly")} />;

  const statusOf = (key: ChannelKey) => (config?.[key] ?? {}) as { configured?: boolean; botId?: string } & Record<string, unknown>;

  const startEdit = (key: ChannelKey) => {
    if (open === key) { setOpen(null); return; }
    setError(null);
    const status = statusOf(key);
    const next: Record<string, string> = { botId: status.botId ?? bots[0]?.id ?? "" };
    for (const spec of FIELD_SPECS[key]) {
      if (spec.secret) continue;
      const stored = status[spec.key];
      next[spec.key] = typeof stored === "string" ? stored : Array.isArray(stored) ? (stored as string[]).join(", ") : "";
    }
    setValues(next);
    setOpen(key);
  };

  const save = async (event: FormEvent, key: ChannelKey) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      for (const spec of FIELD_SPECS[key]) {
        const value = values[spec.key]?.trim() ?? "";
        if (spec.secret && !value) continue;
        body[spec.key] = value;
      }
      body.botId = values.botId ?? "";
      const next = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ [key]: body }) });
      dispatch({ type: "configStatus", config: next });
      setOpen(null);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("settings.channels.saveError"));
    } finally { setBusy(false); }
  };

  const disconnect = async (key: ChannelKey) => {
    if (confirmOff !== key) { setConfirmOff(key); return; }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { botId: "" };
      for (const spec of FIELD_SPECS[key]) body[spec.key] = "";
      const next = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ [key]: body }) });
      dispatch({ type: "configStatus", config: next });
      setConfirmOff(null);
      setOpen(null);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("settings.channels.saveError"));
    } finally { setBusy(false); }
  };

  const fieldValue = (spec: FieldSpec) => values[spec.key] ?? "";

  return (
    <Card title={t("settings.channels.title")} subtitle={t("settings.channels.subtitle")}>
      <div className="flex flex-col gap-2" aria-busy={busy} data-channels>
        {(Object.keys(FIELD_SPECS) as ChannelKey[]).map((key) => {
          const status = statusOf(key);
          const botName = bots.find((bot) => bot.id === status.botId)?.name;
          const expanded = open === key;
          return (
            <div key={key} className="rounded-lg bg-inset/40 px-3 py-2.5" data-channel={key}>
              <div className="flex min-w-0 items-center gap-2">
                <MessageSquare size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
                <div className="min-w-0 flex-1">
                  <div dir="auto" className="truncate text-[13px] font-medium text-ink">{t(NAME_KEYS[key])}</div>
                  <div className="truncate text-[12px] text-ink-secondary">
                    {status.configured === true
                      ? t("settings.channels.connectedTo", { bot: botName ?? status.botId ?? "?" })
                      : t("settings.channels.off")}
                  </div>
                </div>
                {status.configured === true && (
                  <button type="button" className="ui-button ui-button-sm" disabled={busy} onClick={() => void disconnect(key)}>
                    {confirmOff === key ? t("settings.channels.disconnectConfirm") : t("settings.channels.disconnect")}
                  </button>
                )}
                <button type="button" className="ui-button ui-button-sm" disabled={busy} onClick={() => startEdit(key)}>
                  {expanded ? t("settings.channels.collapse") : t("settings.channels.edit")}
                </button>
              </div>
              {expanded && (
                <form className="mt-2.5 flex flex-col gap-2" onSubmit={(event) => void save(event, key)} data-channel-form={key}>
                  {FIELD_SPECS[key].map((spec) => {
                    const label = t(spec.label);
                    if (spec.mailbox) {
                      const options = [...new Set([...(emails ?? []), fieldValue(spec)].filter(Boolean))];
                      return (
                        <div key={spec.key}>
                          <Select value={fieldValue(spec)} onChange={(event) => setValues({ ...values, [spec.key]: event.target.value })}
                            required aria-label={label} className="w-full" data-channel-field={spec.key}>
                            <option value="" disabled>{label}</option>
                            {options.map((address) => <option key={address} value={address}>{address}</option>)}
                          </Select>
                          {emails !== null && emails.length === 0 && (
                            <p className="mt-1 text-[12px] text-ink-tertiary">{t("settings.channels.mailboxEmpty")}</p>
                          )}
                        </div>
                      );
                    }
                    return (
                      <input key={spec.key} value={fieldValue(spec)} onChange={(event) => setValues({ ...values, [spec.key]: event.target.value })}
                        required={!spec.secret || status.configured !== true} autoComplete="off" spellCheck={false} maxLength={spec.secret ? 500 : 320}
                        type={spec.secret ? "password" : "text"} aria-label={label}
                        placeholder={spec.secret && status.configured === true ? t("settings.channels.keepSecret") : label}
                        className={FIELD} data-channel-field={spec.key} />
                    );
                  })}
                  <div className="flex items-center gap-2">
                    <Select value={values.botId ?? ""} onChange={(event) => setValues({ ...values, botId: event.target.value })}
                      required aria-label={t("settings.channels.bot")} className="flex-1" data-channel-field="botId">
                      <option value="" disabled>{t("settings.channels.bot")}</option>
                      {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                    </Select>
                    <button type="submit" className="ui-button ui-button-sm ui-button-primary" disabled={busy}>
                      {busy && <Loader2 size={13} className="animate-spin" />}{t("settings.channels.save")}
                    </button>
                  </div>
                  {key === "wecom" && <p className="text-[12px] leading-relaxed text-ink-tertiary">{t("settings.channels.wecomHint")}</p>}
                  {key === "sms" && <p className="text-[12px] leading-relaxed text-ink-tertiary">{t("settings.channels.smsHint")}</p>}
                  {key === "wechat" && <p className="text-[12px] leading-relaxed text-ink-tertiary">{t("settings.channels.wechatHint")}</p>}
                </form>
              )}
            </div>
          );
        })}
        <p className="text-[12px] leading-relaxed text-ink-tertiary">{t("settings.channels.note")}</p>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      </div>
    </Card>
  );
}
