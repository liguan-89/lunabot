import type { AppConfig } from "../config.ts";

/** What /api/config reports for each chat channel: whether it answers and as which bot. Secrets stay write-only. */
export function channelStatuses(cfg: AppConfig) {
  return {
    feishu: { configured: Boolean(cfg.feishu?.appId && cfg.feishu.appSecret && cfg.feishu.botId), botId: cfg.feishu?.botId ?? "", appId: cfg.feishu?.appId ?? "" },
    dingtalk: { configured: Boolean(cfg.dingtalk?.appKey && cfg.dingtalk.appSecret && cfg.dingtalk.botId), botId: cfg.dingtalk?.botId ?? "", appKey: cfg.dingtalk?.appKey ?? "" },
    wecom: { configured: Boolean(cfg.wecom?.corpId && cfg.wecom.corpSecret && cfg.wecom.token && cfg.wecom.encodingAesKey && cfg.wecom.agentId && cfg.wecom.botId), botId: cfg.wecom?.botId ?? "", corpId: cfg.wecom?.corpId ?? "", agentId: cfg.wecom?.agentId ?? "" },
    botMail: { configured: Boolean(cfg.botMail?.address && cfg.botMail.botId), address: cfg.botMail?.address ?? "", botId: cfg.botMail?.botId ?? "" },
    sms: { configured: Boolean(cfg.sms?.botId), botId: cfg.sms?.botId ?? "", owners: cfg.sms?.owners ?? [] },
    wechat: { configured: Boolean(cfg.wechat?.botId), botId: cfg.wechat?.botId ?? "" },
  };
}
