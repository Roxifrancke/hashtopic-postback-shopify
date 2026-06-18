import cron from "node-cron";
import {
  getPendingRetries,
  markDeliverySent,
  markDeliveryFailed,
  purgeOldDeliveries,
  getSettings,
} from "./db.js";
import { sendPayload, nextRetryAt, MAX_ATTEMPTS } from "./postback-sender.js";

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

  // Nightly retention purge: drop completed delivery rows older than 90 days.
  cron.schedule("0 3 * * *", async () => {
    try {
      const n = await purgeOldDeliveries(90);
      if (n > 0) console.log(`[MS Retention] Purged ${n} delivery rows older than 90 days.`);
    } catch (err) {
      console.error("[MS Retention] Purge failed:", err);
    }
  });

  console.log("[MS] Retry worker started (retries: every minute; retention: daily 03:00 UTC).");
}

async function retryDelivery(delivery) {
  const settings = await getSettings(delivery.shop);
  if (!settings?.webhook_url) return;

  // Resend the exact payload we built on the first attempt. Delivery rows
  // created before payloads were persisted can't be faithfully retried, so we
  // fail them rather than send a meaningless placeholder (which the upstream
  // would reject for having no click_id anyway).
  if (!delivery.payload) {
    await markDeliveryFailed(
      delivery.id,
      0,
      "No stored payload to retry (legacy delivery row)",
      null
    );
    console.error(
      `[MS Retry] Delivery ${delivery.id} has no stored payload — marked failed.`
    );
    return;
  }

  let payload;
  try {
    payload = JSON.parse(delivery.payload);
  } catch {
    await markDeliveryFailed(delivery.id, 0, "Corrupt stored payload", null);
    return;
  }

  const result = await sendPayload(payload, settings);

  if (result.success) {
    await markDeliverySent(delivery.id, result.httpCode);
    console.log(`[MS Retry] Delivery ${delivery.id} sent successfully.`);
  } else {
    const attempt = delivery.attempts + 1;
    const retryAt = attempt < MAX_ATTEMPTS ? nextRetryAt(attempt) : null;
    await markDeliveryFailed(delivery.id, result.httpCode, result.error, retryAt);

    if (!retryAt) {
      console.error(
        `[MS Retry] Delivery ${delivery.id} failed permanently after ${attempt} attempts.`
      );
    }
  }
}
