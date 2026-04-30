const MAX_ATTEMPTS = 5;
// Retry delays in seconds: immediate(0), +5m, +30m, +2h, +24h
const RETRY_DELAYS = [0, 300, 1800, 7200, 86400];

// Property/attribute names that may carry click_id, in priority order.
//
// New names (v1.4+) are MyStorefront-branded so the value is recognisable
// in the Shopify admin order page. The leading underscore on the line item
// property is what hides it from the customer-facing cart/checkout — it's
// kept in the admin display.
//
// Legacy names are still recognised so any in-flight orders/carts placed
// before the v1.4 deploy don't lose attribution. They can be removed once
// no v1.3-or-earlier carts are in flight (~30 days post-deploy, matching
// cookie TTL).
const LINE_ITEM_PROP_NAMES = [
  "_MyStorefront click_id", // current
  "click_id",                // legacy v1.2/v1.3 main script
  "_click_id",               // legacy v1.3 fallback
];
const NOTE_ATTR_NAMES = [
  "MyStorefront click_id", // current
  "click_id",              // legacy
];

/**
 * Extract click_id from a Shopify order, checking sources in priority order.
 *
 * Priority:
 *   1. line_items[].properties — primary, set via product form hidden input.
 *      Survives Buy It Now / Shop Pay / fast checkout where cart attributes
 *      may not be set. Tries each known property name (current + legacy).
 *   2. note_attributes — cart attribute path, retained as backward-compat
 *      fallback for stores on the older flow.
 *   3. null — not an affiliate order.
 *
 * Returns the trimmed string value, or null. Empty strings are treated as null
 * so a stale empty property doesn't suppress the note_attributes fallback.
 */
export function extractClickId(order) {
  if (!order) return null;

  // 1. Primary: line item properties. First non-empty wins.
  const lineItems = order.line_items || [];
  for (const item of lineItems) {
    const props = item?.properties;
    if (!props) continue;

    // Shopify webhooks deliver line item properties as an array of
    // { name, value } objects. Some Admin API responses (and our own test
    // fixtures) may use a plain object — handle both.
    if (Array.isArray(props)) {
      for (const propName of LINE_ITEM_PROP_NAMES) {
        const hit = props.find((p) => p?.name === propName);
        const value = hit?.value;
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    } else if (typeof props === "object") {
      for (const propName of LINE_ITEM_PROP_NAMES) {
        const value = props[propName];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }

  // 2. Fallback: note_attributes (cart attribute path).
  const noteAttrs = order.note_attributes;
  if (Array.isArray(noteAttrs)) {
    for (const attrName of NOTE_ATTR_NAMES) {
      const hit = noteAttrs.find((a) => a?.name === attrName);
      const value = hit?.value;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  // 3. No click_id anywhere.
  return null;
}

/**
 * Build postback payload from a Shopify order object
 */
export function buildPayload(shop, order, settings) {
  const clickId = extractClickId(order);

  const lineItems = (order.line_items || []).map((item) => ({
    product_id: item.product_id != null ? String(item.product_id) : null,
    variant_id: item.variant_id != null ? String(item.variant_id) : null,
    sku: item.sku || null,
    title: item.title || null,
    quantity: item.quantity || 0,
    price: parseFloat(item.price || 0),
    total_discount: parseFloat(item.total_discount || 0),
  }));

  const itemsCount = lineItems.reduce(
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
    line_items: lineItems,
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
      line_items: [
        {
          product_id: "test_product_1",
          variant_id: "test_variant_1",
          sku: "TEST-SKU-1",
          title: "Test Product",
          quantity: 1,
          price: 86.49,
          total_discount: 0,
        },
      ],
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
 * Build a refund (clawback) payload from a Shopify refund object.
 *
 * Shape mirrors a purchase payload but with:
 *   - event = "refund"
 *   - order_total as a NEGATIVE number (the refunded amount, signed)
 *   - refund_id and refund_reference fields so MyStorefront can dedupe
 *   - line_items containing only the refunded items
 *
 * MyStorefront should treat this as a clawback against the original
 * commission. Partial refunds reduce commission proportionally; full
 * refunds zero it out.
 *
 * The `order` argument is the parent order fetched via the Admin API
 * (so we can pull click_id from note_attributes — refund webhooks don't
 * include it directly).
 */
export function buildRefundPayload(shop, order, refund, settings) {
  const clickId = extractClickId(order);

  const refundLineItems = (refund.refund_line_items || []).map((rli) => {
    const li = rli.line_item || {};
    return {
      product_id: li.product_id != null ? String(li.product_id) : null,
      variant_id: li.variant_id != null ? String(li.variant_id) : null,
      sku: li.sku || null,
      title: li.title || null,
      quantity: rli.quantity || 0,
      price: parseFloat(li.price || 0),
      subtotal: parseFloat(rli.subtotal || 0),
      total_tax: parseFloat(rli.total_tax || 0),
    };
  });

  // Sum refund amount across transactions (in case of split refunds).
  const refundTotal = (refund.transactions || [])
    .filter((t) => t.kind === "refund" && t.status === "success")
    .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

  // Fall back to summing refund_line_items if no transactions present.
  const fallbackTotal = refundLineItems.reduce(
    (sum, li) => sum + (li.subtotal || 0) + (li.total_tax || 0),
    0
  );

  const signedTotal = -1 * Math.abs(refundTotal || fallbackTotal);

  const itemsCount = refundLineItems.reduce(
    (sum, li) => sum + (li.quantity || 0),
    0
  );

  return {
    click_id: clickId || null,
    order_id: String(order?.id ?? refund.order_id),
    refund_id: String(refund.id),
    order_total: signedTotal,
    currency: order?.currency || "USD",
    test: Boolean(settings?.test_mode),
    metadata: {
      event: "refund",
      event_time: new Date().toISOString(),
      order_number: String(order?.name || order?.order_number || order?.id || refund.order_id),
      refund_reference: String(refund.id),
      refund_note: refund.note || null,
      items_count: itemsCount,
      line_items: refundLineItems,
      customer: {
        email: order?.email || order?.customer?.email || null,
        phone: order?.phone || order?.customer?.phone || null,
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

    if (debug) {
      console.log("[HT Debug] Sending postback:", JSON.stringify({
        webhook_url,
        webhook_secret: maskSecret(webhook_secret),
        click_id: payload.click_id,
        order_id: payload.order_id,
      }));
    }

    const res = await fetch(webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${webhook_secret || ""}`,
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

function maskSecret(secret) {
  if (!secret) return null;
  if (secret.length <= 8) return "***";
  return secret.slice(0, 4) + "***" + secret.slice(-2);
}
