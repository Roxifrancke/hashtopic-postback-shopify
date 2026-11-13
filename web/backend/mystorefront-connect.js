import { randomBytes } from "crypto";
import { getSettings, saveSettings, saveMystorefrontLinkStatus } from "./db.js";

// Links this shop to its MyStorefront brand automatically. MyStorefront finds
// the brand by its webhook secret, pings this app with the shop's key, then
// saves the shop domain and key on its side. Safe to call repeatedly.
const RECHECK_MS = 60 * 60 * 1000;
const inFlight = new Map();

export function connectToMystorefront(shop, { onlyIfStale = false } = {}) {
  if (!shop) return Promise.resolve({ status: "no_shop" });
  if (inFlight.has(shop)) return inFlight.get(shop);
  const p = runConnect(shop, onlyIfStale).finally(() => inFlight.delete(shop));
  inFlight.set(shop, p);
  return p;
}

async function runConnect(shop, onlyIfStale) {
  const connectUrl = (process.env.MYSTOREFRONT_CONNECT_URL || "").trim();
  const appUrl = (process.env.SHOPIFY_APP_URL || "").trim().replace(/\/+$/, "");
  if (!connectUrl || !appUrl) return { status: "not_configured" };

  let settings = await getSettings(shop);
  if (!settings?.webhook_secret) return { status: "no_secret" };

  if (onlyIfStale && settings.mystorefront_linked_at && !settings.mystorefront_link_error) {
    const age = Date.now() - new Date(settings.mystorefront_linked_at).getTime();
    if (age < RECHECK_MS) return { status: "recently_linked" };
  }

  if (!settings.mystorefront_api_key) {
    settings = await saveSettings(shop, { mystorefront_api_key: randomBytes(16).toString("hex") });
  }

  let res;
  let body = {};
  try {
    res = await fetch(connectUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.webhook_secret}`,
      },
      body: JSON.stringify({
        shop_domain: shop,
        mystorefront_api_key: settings.mystorefront_api_key,
        plugin_base_url: appUrl,
      }),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    await saveMystorefrontLinkStatus(shop, { linked: false, error: "unreachable" });
    return { status: "failed", error: "unreachable" };
  }

  if (res.ok && body?.ok === true) {
    await saveMystorefrontLinkStatus(shop, { linked: true, error: "" });
    return { status: body.status || "connected" };
  }

  const error = typeof body?.error === "string" ? body.error : `http_${res.status}`;
  await saveMystorefrontLinkStatus(shop, { linked: false, error });
  return { status: "failed", error };
}
