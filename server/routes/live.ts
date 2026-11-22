// The provider key is never read or written here; without one a start answers 409 `needsKey`. A phone can never send device-revoked.
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { LiveProvider, LiveSettings } from "../../shared/wire.ts";
import { azureLiveDeployment, azureOpenAiRoot, LiveSessionError, MAX_SDP_BYTES, qwenLiveDeployment, qwenRealtimeRoot, volcAppId, volcLiveModel, type QwenProbeResult, type VolcProbeResult } from "../live-call.ts";
import { LiveCallBusyError, type LiveCallController } from "../live-call-controller.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";
import type { RequestAuth } from "../request-auth.ts";
import { LIVE_RELAY_PATH, type LiveRelayOptions, type LiveRelays } from "../live-relay.ts";
import type { Upgrades } from "./upgrades.ts";

export interface LiveRouteDeps {
  calls: Pick<LiveCallController, "start" | "end" | "current" | "deviceRevoked">;
  /** The computer dropped this device: its capability record goes too. Same request as the Live call's end, because
   * both answer the one question the sidecar is reporting — this phone is gone. */
  phoneRevoked?(deviceId: string): void;
  resolveTarget(botId: string, threadId: string | undefined): { botId: string; botName: string; threadId: string } | null;
  settings(): LiveSettings;
  saveSettings(patch: { provider?: LiveProvider; azureEndpoint?: string; azureDeployment?: string; qwenEndpoint?: string; qwenModel?: string; volcAppId?: string; volcModel?: string; voice?: string; readTypedReplies?: boolean; idleMinutes?: number }): Promise<LiveSettings>;
  /** Connects the realtime socket with the saved key and reports what `session.created` answered. Admin scope only: it proves the key works. */
  probeQwen?(): Promise<QwenProbeResult>;
  /** Drives the Doubao dialogue socket through StartConnection + StartSession and reports the answer. Admin scope only: it proves the app's credentials work. */
  probeVolc?(): Promise<VolcProbeResult>;
  upgrades?: Pick<Upgrades, "route" | "pending">;
  relays?: Pick<LiveRelays, "accept">;
  /** Resolves the provider socket target for a browser relay call; `error` refuses with that message and status. */
  relay?(auth: RequestAuth, botId: string | null, threadId?: string | null, client?: string | null): { options: LiveRelayOptions } | { error: string; status?: number };
}

const id = z.string().regex(/^[\w-]{1,120}$/);
const sessionBody = z.object({
  botId: id,
  threadId: id.optional(),
  // Not trimmed: the SDP offer goes to OpenAI byte for byte.
  sdp: z.string().min(1).refine((sdp) => Buffer.byteLength(sdp) <= MAX_SDP_BYTES),
  client: z.enum(["desktop", "web", "ios", "android"]),
}).strict();
const endBody = z.object({ callId: z.string().min(1).max(120) }).strict();
// Strict, so `key` is refused rather than ignored: the key is saved only through the credential store or PUT /api/config.
const settingsBody = z.object({
  provider: z.enum(["openai", "azure", "qwen", "volc"]).optional(),
  // "" clears the field. Anything else must be an https Azure OpenAI host, since the key is sent there.
  azureEndpoint: z.string().trim().max(300).refine((url) => url === "" || azureOpenAiRoot(url) !== null).optional(),
  azureDeployment: z.string().trim().max(64).refine((name) => name === "" || azureLiveDeployment(name) === name).optional(),
  // "" clears the field. Anything else must be an https base, since the key is sent to its origin's realtime socket.
  qwenEndpoint: z.string().trim().max(300).refine((url) => url === "" || qwenRealtimeRoot(url) !== null).optional(),
  qwenModel: z.string().trim().max(64).refine((name) => name === "" || qwenLiveDeployment(name) === name).optional(),
  // "" clears the field. The App ID is digits and the model a version like "1.2.1.1".
  volcAppId: z.string().trim().max(32).refine((id) => id === "" || volcAppId(id) === id).optional(),
  volcModel: z.string().trim().max(32).refine((name) => name === "" || volcLiveModel(name) === name).optional(),
  voice: z.string().trim().max(40).regex(/^[a-z]*$/).optional(),
  readTypedReplies: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(60).optional(),
}).strict();

const DEVICE_ID = /^[\w-]{1,128}$/;

/** The companion sends its own id for the phone that authenticated, never one the phone chose. */
function companionDevice(req: IncomingMessage): string | undefined {
  if (req.headers["x-lunabot-companion"] !== "1") return undefined;
  const device = req.headers["x-lunabot-companion-device"];
  return typeof device === "string" && DEVICE_ID.test(device) ? device : undefined;
}

async function bodyOf(req: IncomingMessage, readBody: RouteContext["readBody"]): Promise<unknown> {
  try {
    return await readBody(req);
  } catch {
    return undefined;
  }
}

export function createLiveRoutes(deps: LiveRouteDeps): RouteHandler {
  deps.upgrades?.route((path) => path === LIVE_RELAY_PATH);
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/live/")) return PASS;

    if (method === "GET" && path === LIVE_RELAY_PATH) {
      const pending = deps.upgrades?.pending(req);
      if (!pending || !deps.relays || !deps.relay) return PASS;
      const target = deps.relay(auth, url.searchParams.get("botId"), url.searchParams.get("threadId"), url.searchParams.get("client"));
      if ("error" in target) return json(res, target.status ?? 403, { error: target.error });
      if (pending.socket.destroyed) return;
      pending.release();
      deps.relays.accept({ req, socket: pending.socket, head: pending.head }, target.options);
      res.detachSocket(pending.socket);
      return;
    }

    if (method === "POST" && path === "/api/live/session") {
      const parsed = sessionBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The call request was not valid." });
      const target = deps.resolveTarget(parsed.data.botId, parsed.data.threadId);
      if (!target) return json(res, 404, { error: "That bot or chat does not exist." });
      try {
        const device = companionDevice(req);
        const { call, sdp } = await deps.calls.start({ auth, ...(device ? { device } : {}), ...target, client: parsed.data.client, sdp: parsed.data.sdp });
        return json(res, 201, { call, transport: { type: "webrtc", sdp } });
      } catch (error) {
        if (error instanceof LiveCallBusyError) return json(res, 409, { error: error.message, activeCall: error.call });
        if (error instanceof LiveSessionError) {
          return json(res, error.status, error.status === 409 ? { error: error.message, needsKey: true } : { error: error.message });
        }
        throw error;
      }
    }

    if (method === "POST" && path === "/api/live/call/end") {
      const parsed = endBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The request was not valid." });
      const call = await deps.calls.end(parsed.data.callId);
      return call ? json(res, 200, { call }) : json(res, 404, { error: "That call is not running." });
    }

    if (method === "GET" && path === "/api/live/call") return json(res, 200, { call: deps.calls.current() });

    if (method === "POST" && path === "/api/live/device-revoked") {
      if (req.headers["x-lunabot-companion"] !== "1") return json(res, 403, { error: "Only the phone companion can report an unpaired phone." });
      const device = companionDevice(req);
      if (!device) return json(res, 400, { error: "The unpaired phone was not named." });
      const call = deps.calls.deviceRevoked(device);
      deps.phoneRevoked?.(device);
      return json(res, 200, { call });
    }

    if (method === "PATCH" && path === "/api/live/settings") {
      const parsed = settingsBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        if (field === "azureEndpoint") return json(res, 400, { error: "The Azure endpoint must be the https address of an Azure OpenAI resource, like https://my-resource.openai.azure.com." });
        if (field === "azureDeployment") return json(res, 400, { error: "The Azure deployment name may use letters, digits, '-', '_' and '.', up to 64 characters." });
        if (field === "qwenEndpoint") return json(res, 400, { error: "The Qwen endpoint must be the gateway's https address, like https://dashscope.aliyuncs.com." });
        if (field === "qwenModel") return json(res, 400, { error: "The Qwen realtime model name may use letters, digits, '-', '_' and '.', up to 64 characters." });
        if (field === "volcAppId") return json(res, 400, { error: "The Doubao speech app's App ID is its digits, like 6255978659." });
        if (field === "volcModel") return json(res, 400, { error: "The Doubao dialogue model is a version like 1.2.1.1 (O2.0) or 2.2.0.0 (SC2.0)." });
        return json(res, 400, { error: "Those Live settings are not valid." });
      }
      if (!Object.keys(parsed.data).length) return json(res, 400, { error: "nothing to save" });
      return json(res, 200, { live: await deps.saveSettings(parsed.data) });
    }

    if (method === "POST" && path === "/api/live/qwen/probe") {
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only an admin can test the Live call connection." });
      if (!deps.probeQwen) return json(res, 404, { error: "No Qwen realtime provider is set up." });
      return json(res, 200, { probe: await deps.probeQwen() });
    }

    if (method === "POST" && path === "/api/live/volc/probe") {
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only an admin can test the Live call connection." });
      if (!deps.probeVolc) return json(res, 404, { error: "No Doubao realtime provider is set up." });
      return json(res, 200, { probe: await deps.probeVolc() });
    }

    return PASS;
  };
}
