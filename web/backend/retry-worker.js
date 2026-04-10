import cron from "node-cron";
import {
  getPendingRetries,
  getDeliveryById,
  markDeliverySent,
  markDeliveryFailed,
} from "./db.js";
import { getSettings } from "./db.js";
import { sendPayload, nextRetryAt, MAX_ATTEMPTS } from "./postback-sender.js";
import webhookHandlers from "./webhooks/index.js";

export function startRetryWorker() {
  // Run every minute to check for pending retries
  cron.schedule("* * * * *", async () => {
    const pending = await getPendingRetries();
    if (!pending.length) return;

    console.log(`[MS Retry] Processing ${pending.length} pending retries...`);

    for (const delivery of pending) {
      try {
        await retryDelivery(delivery);
      } catch (err) {
        console.error(`[MS Retry] Error retrying delivery ${delivery.id}:`, err);
      }
    }
  });

  console.log("[MS] Retry worker started (runs every minute).");
}

async function retryDelivery(delivery) {
  const settings = await getSettings(delivery.shop);
  if (!settings?.webhook_url) return;

  const payload = buildRetryPayload(delivery, settings);
  const result = await sendPayload(payload, settings);

  if (result.success) {
    await markDeliverySent(delivery.id, result.httpCode);
    console.log(`[MS Retry] Delivery ${delivery.id} sent successfully.`);
  } else {
    const attempt = delivery.attempts + 1;
    const retryAt = attempt < MAX_ATTEMPTS ? nextRetryAt(attempt) : null;
    await markDeliveryFailed(delivery.id, result.httpCode, result.error, retryAt);

    if (!retryAt) {
      console.error(`[MS Retry] Delivery ${delivery.id} failed permanently after ${attempt} attempts.`);
    }
  }
}

function buildRetryPayload(delivery, settings) {
  return {
    click_id: null,
    order_id: delivery.order_id,
    order_total: 0,
    currency: "USD",
    test: Boolean(settings.test_mode),
    metadata: {
      event: "purchase",
      event_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      order_number: delivery.order_name || delivery.order_id,
      order_status: "paid",
      shipping_total: 0,
      tax_total: 0,
      discount_total: 0,
      items_count: 0,
      customer: { email: null, phone: null },
      store: {
        platform: "shopify",
        site_url: `https://${delivery.shop}`,
      },
      _retry: true,
    },
  };
}
