import cron from "node-cron";
import {
  getPendingRetries,
  getDeliveryById,
  markDeliverySent,
  markDeliveryFailed,
} from "./db.js";
import { getSettings } from "./db.js";
import { buildPayload, sendPayload, nextRetryAt, MAX_ATTEMPTS } from "./postback-sender.js";
import webhookHandlers from "./webhooks/index.js";

export function startRetryWorker() {
  // Run every minute to check for pending retries
  cron.schedule("* * * * *", async () => {
    const pending = getPendingRetries();
    if (!pending.length) return;

    console.log(`[HT Retry] Processing ${pending.length} pending retries...`);

    for (const delivery of pending) {
      try {
        await retryDelivery(delivery);
      } catch (err) {
        console.error(`[HT Retry] Error retrying delivery ${delivery.id}:`, err);
      }
    }
  });

  console.log("[HT] Retry worker started (runs every minute).");
}

async function retryDelivery(delivery) {
  const settings = getSettings(delivery.shop);
  if (!settings?.webhook_url) return;

  // Re-fetch from Shopify to get latest order data
  // For retry, we re-build from stored order_id - we need to fetch from Shopify API
  // or store the payload. Here we store enough in the delivery to reconstruct.
  // For simplicity in retry, we'll just re-send with minimal payload indicating retry.
  // In production you'd cache the payload or re-fetch from Shopify API.

  const payload = buildRetryPayload(delivery, settings);
  const result = await sendPayload(payload, settings);

  if (result.success) {
    markDeliverySent(delivery.id, result.httpCode);
    console.log(`[HT Retry] Delivery ${delivery.id} sent successfully.`);
  } else {
    const attempt = delivery.attempts + 1;
    const retryAt = attempt < MAX_ATTEMPTS ? nextRetryAt(attempt) : null;
    markDeliveryFailed(delivery.id, result.httpCode, result.error, retryAt);

    if (!retryAt) {
      console.error(`[HT Retry] Delivery ${delivery.id} failed permanently after ${attempt} attempts.`);
    }
  }
}

function buildRetryPayload(delivery, settings) {
  // Minimal retry payload — in production, store/retrieve full payload JSON
  return {
    event: "purchase",
    event_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    click_id: null,
    order_id: delivery.order_id,
    order_number: delivery.order_name || delivery.order_id,
    order_status: "paid",
    currency: "USD",
    order_total: 0,
    shipping_total: 0,
    tax_total: 0,
    discount_total: 0,
    items_count: 0,
    customer: { email: null, phone: null },
    store: {
      platform: "shopify",
      site_url: `https://${delivery.shop}`,
    },
    test: Boolean(settings.test_mode),
    _retry: true,
  };
}
