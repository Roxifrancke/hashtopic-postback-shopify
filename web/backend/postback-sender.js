import { getSettings } from "./db.js";

const MAX_ATTEMPTS = 5;
// Retry delays in seconds: immediate(0), +5m, +30m, +2h, +24h
const RETRY_DELAYS = [0, 300, 1800, 7200, 86400];

/**
 * Build postback payload from a Shopify order object
 */
export function buildPayload(shop, order, settings) {
  const clickId = order.note_attributes?.find(
    (a) => a.name === "_ht_click_id"
  )?.value ?? null;

  const itemsCount = (order.line_items || []).reduce(
    (sum, item) => sum + (item.quantity || 0),
    0
  );

return {
  click_id: clickId || null,
  order_id: String(order.id),
  order_total: parseFloat(order.total_price || 0),
  currency: order.currency || "USD",
  test: Boolean(settings?.test_mode),
  metadata: {
    event: "purchase",
    event_time: new Date().toISOString(),
    order_number: String(order.name || order.order_number || order.id),
    order_status: order.financial_status || "paid",
    shipping_total: parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0),
    tax_total: parseFloat(order.total_tax || 0),
    discount_total: parseFloat(order.total_discounts || 0),
    items_count: itemsCount,
    customer: {
      email: order.email || order.customer?.email || null,
      phone: order.phone || order.customer?.phone || null,
    },
    store: {
      platform: "shopify",
      site_url: `https://${shop}`,
    },
  },
};
}

/**
 * Build a test payload (no real order needed)
 */
export function buildTestPayload(shop, settings) {
  return {
    click_id: `test_click_${Math.random().toString(36).slice(2, 10)}`,
    order_id: "0",
    order_total: 99.99,
    currency: "USD",
    test: true,
    metadata: {
      event: "purchase",
      event_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      order_number: "TEST-0",
      order_status: "paid",
      shipping_total: 5.0,
      tax_total: 8.5,
      discount_total: 0.0,
      items_count: 1,
      customer: {
        email: null,
        phone: null,
      },
      store: {
        platform: "shopify",
        site_url: `https://${shop}`,
      },
    },
  };
}

/**
 * Send payload via HTTP POST. Returns { success, httpCode, error }
 */
export async function sendPayload(payload, settings) {
  const { webhook_url, webhook_secret, debug } = settings;

  if (!webhook_url) {
    return { success: false, httpCode: 0, error: "Webhook URL not configured." };
  }

  const body = JSON.stringify(payload);

  if (debug) {
    const redacted = { ...payload, customer: { email: maskEmail(payload.customer?.email), phone: "***" } };
    console.log("[HT Debug] Sending payload:", JSON.stringify(redacted));
  }

  let httpCode = 0;
  let error = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": webhook_secret || "",
        "User-Agent": `MyStorefrontPostbackShopify/1.0; https://${payload.store?.site_url || ""}`,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    httpCode = res.status;

    if (debug) {
      console.log(`[HT Debug] Response HTTP ${httpCode}`);
    }

    if (httpCode >= 200 && httpCode < 300) {
      return { success: true, httpCode, error: null };
    }

    error = `Webhook returned HTTP ${httpCode}`;
    return { success: false, httpCode, error };
  } catch (err) {
    error = err.name === "AbortError" ? "Request timed out after 10s" : String(err.message || err);
    if (debug) console.error("[HT Debug] Send error:", error);
    return { success: false, httpCode, error };
  }
}

/**
 * Calculate next retry time based on attempt number
 */
export function nextRetryAt(attempt) {
  const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
  if (delay === 0) return null; // Immediate – no scheduling needed, caller retries inline
  const d = new Date(Date.now() + delay * 1000);
  return d.toISOString();
}

export { MAX_ATTEMPTS, RETRY_DELAYS };

function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return local.slice(0, 1) + "***@" + domain;
}
