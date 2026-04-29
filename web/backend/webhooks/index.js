import {
  getSettings,
  upsertDelivery,
  markDeliverySent,
  markDeliveryFailed,
  getDeliveriesForShop,
  getAccessToken,
} from "../db.js";
import {
  buildPayload,
  buildRefundPayload,
  sendPayload,
  nextRetryAt,
  extractClickId,
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
  // click_id (line item property OR note attribute) the postback function
  // will reject with 400 ("Missing required fields"), so there's no point
  // creating a delivery record or wasting retry attempts on it.
  const clickId = extractClickId(order);
  if (!clickId) {
    if (settings.debug) {
      console.log(`[MS] Order ${order.id} on ${shop} has no click_id — not an affiliate order, skipping.`);
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

/**
 * Fetch the parent order via the Shopify Admin API so we can pull
 * note_attributes (which the refund webhook payload does not include).
 * Returns null on any failure — the caller falls back to a payload
 * built without click_id / customer info.
 */
async function fetchOrder(shop, orderId) {
  try {
    const accessToken = await getAccessToken(shop);
    if (!accessToken) {
      console.warn(`[MS] No admin token for ${shop} — cannot fetch order ${orderId} for refund`);
      return null;
    }
    const apiVersion = "2025-04";
    const url = `https://${shop}/admin/api/${apiVersion}/orders/${orderId}.json`;
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      console.warn(`[MS] Order fetch failed for ${shop}/${orderId}: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json.order || null;
  } catch (err) {
    console.error(`[MS] Order fetch error for ${shop}/${orderId}:`, err.message || err);
    return null;
  }
}

async function processRefund(shop, refund) {
  const settings = await getSettings(shop);
  if (!settings?.webhook_url) {
    console.log(`[MS] No webhook URL configured for ${shop}, skipping refund.`);
    return;
  }

  // Fetch parent order to pull click_id (line item property or note attribute).
  const order = await fetchOrder(shop, refund.order_id);

  // No click_id → not an affiliate order, no commission to claw back.
  const clickId = extractClickId(order);
  if (!clickId) {
    if (settings.debug) {
      console.log(`[MS] Refund ${refund.id} on ${shop} has no click_id on parent order — skipping.`);
    }
    return;
  }

  // Use a refund-specific delivery key so it doesn't collide with the
  // original purchase delivery for the same order_id.
  const deliveryKey = `refund_${refund.id}`;
  const delivery = await upsertDelivery(shop, deliveryKey, order?.name || String(refund.order_id));

  if (delivery.status === "sent") {
    console.log(`[MS] Refund ${refund.id} already sent for ${shop}, skipping.`);
    return;
  }
  if (delivery.attempts >= MAX_RETRY) {
    console.log(`[MS] Refund ${refund.id} max attempts reached for ${shop}.`);
    return;
  }

  const payload = buildRefundPayload(shop, order, refund, settings);
  const result = await sendPayload(payload, settings);

  if (result.success) {
    await markDeliverySent(delivery.id, result.httpCode);
    console.log(`[MS] Refund postback sent for refund ${refund.id} on ${shop} (HTTP ${result.httpCode})`);
  } else {
    const attempt = delivery.attempts + 1;
    const retryAt = attempt < MAX_RETRY ? nextRetryAt(attempt) : null;
    await markDeliveryFailed(delivery.id, result.httpCode, result.error, retryAt);
    console.error(`[MS] Refund postback failed for refund ${refund.id} on ${shop}: ${result.error}`);
  }
}

const refundsCreate = async (topic, shop, body, webhookId) => {
  try {
    const refund = JSON.parse(body);
    await processRefund(shop, refund);
  } catch (err) {
    console.error("[MS] Error in refunds/create handler:", err);
  }
};

export default { ordersPaid, ordersUpdated, refundsCreate, processOrder, processRefund };
