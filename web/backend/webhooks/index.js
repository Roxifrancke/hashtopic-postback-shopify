import {
  getSettings,
  upsertDelivery,
  markDeliverySent,
  markDeliveryFailed,
  getDeliveriesForShop,
} from "../db.js";
import {
  buildPayload,
  sendPayload,
  nextRetryAt,
  MAX_ATTEMPTS,
} from "../postback-sender.js";

const MAX_RETRY = MAX_ATTEMPTS;

async function processOrder(shop, order) {
  const settings = await getSettings(shop);
  if (!settings?.webhook_url) {
    console.log(`[MS] No webhook URL configured for ${shop}, skipping.`);
    return;
  }

  const paidStatuses = settings.paid_statuses || ["paid"];
  const financialStatus = order.financial_status || "";

  // Check if this order status is in paid statuses
  if (!paidStatuses.includes(financialStatus)) {
    return;
  }

  // Skip orders that were not driven by an affiliate click. Without a
  // _ht_click_id note attribute the postback function will reject with 400
  // ("Missing required fields"), so there's no point creating a delivery
  // record or wasting retry attempts on it.
  const clickId = order.note_attributes?.find(
    (a) => a.name === "_ht_click_id"
  )?.value;
  if (!clickId) {
    if (settings.debug) {
      console.log(`[MS] Order ${order.id} on ${shop} has no _ht_click_id — not an affiliate order, skipping.`);
    }
    return;
  }

  const delivery = await upsertDelivery(shop, String(order.id), order.name);

  // Already sent? Skip.
  if (delivery.status === "sent") {
    console.log(`[MS] Order ${order.id} already sent for ${shop}, skipping.`);
    return;
  }

  // Max attempts reached?
  if (delivery.attempts >= MAX_RETRY) {
    console.log(`[MS] Order ${order.id} max attempts reached for ${shop}.`);
    return;
  }

  const payload = buildPayload(shop, order, settings);
  const result = await sendPayload(payload, settings);

  if (result.success) {
    await markDeliverySent(delivery.id, result.httpCode);
    console.log(`[MS] Postback sent for order ${order.id} on ${shop} (HTTP ${result.httpCode})`);
  } else {
    const attempt = delivery.attempts + 1;
    const retryAt = attempt < MAX_RETRY ? nextRetryAt(attempt) : null;
    await markDeliveryFailed(delivery.id, result.httpCode, result.error, retryAt);
    console.error(`[MS] Postback failed for order ${order.id} on ${shop}: ${result.error}`);
  }
}

const ordersPaid = async (topic, shop, body, webhookId) => {
  try {
    const order = JSON.parse(body);
    await processOrder(shop, order);
  } catch (err) {
    console.error("[MS] Error in orders/paid handler:", err);
  }
};

const ordersUpdated = async (topic, shop, body, webhookId) => {
  try {
    const order = JSON.parse(body);
    // Only process if financial_status changed to a paid state
    const settings = await getSettings(shop);
    if (!settings) return;
    const paidStatuses = settings.paid_statuses || ["paid"];
    if (paidStatuses.includes(order.financial_status)) {
      await processOrder(shop, order);
    }
  } catch (err) {
    console.error("[MS] Error in orders/updated handler:", err);
  }
};

export default { ordersPaid, ordersUpdated, processOrder };
