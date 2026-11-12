const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_-]{8,64}$/;
const INSTALL_NAME = "TK1688 API";

function subscriptionOf(list, subscriptionId) {
  if (!list || !Array.isArray(list.subscriptions)) return null;
  return list.subscriptions.find((subscription) => subscription?.subscription_id === subscriptionId) ?? null;
}

function installRecord(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.subscription_id !== "string" || typeof value.instance_id !== "string") return null;
  if (!Number.isSafeInteger(value.expires_at) || value.expires_at <= 0) return null;
  return {
    subscription_id: value.subscription_id,
    instance_id: value.instance_id,
    expires_at: value.expires_at,
    models: Array.isArray(value.models) ? value.models.filter((model) => typeof model === "string") : [],
    url: typeof value.url === "string" ? value.url : "",
  };
}

/** The TK1688 subscription bridge: OAuth and tokens stay in main; the page gets plans, state and an installed engine's id. */
export function installMarketIpc({ ipcMain, localOnly, client, openBrowser, localRequest, providerStore, origin, apiBase, now = Date.now, log = () => {} }) {
  const handle = (channel, handler) => ipcMain.handle(channel, localOnly(channel, handler));

  async function readInstall() {
    try { return installRecord(await providerStore.read()); } catch { return null; }
  }

  async function installProvider(subscriptionId) {
    if (!SUBSCRIPTION_ID.test(subscriptionId)) throw new Error("Choose a subscription.");
    const installed = await readInstall();
    if (installed?.subscription_id === subscriptionId && installed.expires_at * 1000 > now()) {
      return { instanceId: installed.instance_id, models: installed.models, expiresAt: installed.expires_at, url: installed.url || apiBase, installed: true };
    }
    const subscription = subscriptionOf(await client().subscriptions(), subscriptionId);
    if (!subscription) throw new Error("That subscription is not on this TK1688 account.");
    if (subscription.status === "expired" || subscription.status === "canceled" || subscription.expires_at * 1000 <= now()) {
      throw new Error("Renew this subscription before installing its key.");
    }
    let revealed;
    try {
      revealed = subscription.token === null ? await client().rotateToken(subscriptionId) : await client().revealToken(subscriptionId);
    } catch (error) {
      const rotateInstead = error?.code === "token_already_revealed" || error?.code === "subscription_not_found" || error?.status === 404;
      if (!rotateInstead) throw error;
      revealed = await client().rotateToken(subscriptionId);
    }
    const models = revealed.models.length ? revealed.models : subscription.models;
    const response = await localRequest("/api/instances/openai-compat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: INSTALL_NAME, url: apiBase, key: revealed.token, ...(models.length ? { models } : {}) }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.instanceId !== "string") {
      const said = typeof body?.error === "string" ? body.error : "Could not add TK1688 as an engine.";
      throw new Error(said);
    }
    const saved = { subscription_id: subscriptionId, instance_id: body.instanceId, expires_at: revealed.expires_at, models, url: apiBase, installed_at: now() };
    try { await providerStore.write(saved); } catch (error) { log(`market: could not save the installed engine (${error?.message ?? error})`); }
    return { instanceId: body.instanceId, models, expiresAt: revealed.expires_at, url: apiBase, installed: true };
  }

  handle("market:state", () => client().state());
  handle("market:plans", () => client().plans());
  handle("market:subscriptions", () => client().subscriptions());
  handle("market:sign-in", () => client().signIn());
  handle("market:cancel-sign-in", () => client().cancelSignIn());
  handle("market:sign-out", () => client().signOut());
  handle("market:checkout", async (_event, planCode, paymentMethod) => {
    const checkout = await client().checkout(String(planCode ?? ""), String(paymentMethod ?? "epay"));
    if (checkout.url) await openBrowser(checkout.url);
    return checkout;
  });
  handle("market:checkout-status", (_event, checkoutId) => client().checkoutStatus(String(checkoutId ?? "")));
  handle("market:install", (_event, subscriptionId) => installProvider(String(subscriptionId ?? "")));
  handle("market:installed", async () => {
    const record = await readInstall();
    return record ? { subscriptionId: record.subscription_id, instanceId: record.instance_id, expiresAt: record.expires_at } : null;
  });
  handle("market:manage", () => openBrowser(`${origin}/subscriptions`));
}