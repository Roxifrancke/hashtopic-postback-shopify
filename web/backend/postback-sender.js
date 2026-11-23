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
  "__MyStorefront click_id", // private (hidden on /cart)
  "_MyStorefront click_id", // previous
  "click_id",                // legacy v1.2/v1.3 main script
  "_click_id",               // legacy v1.3 fallback
];
const NOTE_ATTR_NAMES = [
  "__MyStorefront click_id", // private cart attribute
  "MyStorefront click_id", // legacy visible cart attribute
  "click_id",              // legacy
];

/**
 * Resolve the referral from an order-level cart attribute first, falling back
 * to a line-item property for accelerated checkouts without cart attributes.
 *
 * IMPORTANT: The source of a click ID is NOT a timestamp. If the cart and
 * line-item values differ, this deterministic fallback does not establish
 * last-click attribution. That requires validating the click IDs and their
 * timestamps in the attribution backend. Do not infer recency from their names.
 */
export const PLUGIN_VERSION = "1.7.0";

// The Web Pixel sees event times; cart attributes and line properties can
// carry their own capture times. Names alone are NEVER evidence of recency.
export function extractClickCandidates(order) {
  if (!order) return [];
  const result = [];
  const add = (id, at, source) => {
    if (typeof id !== "string" || !id.trim()) return;
    const time = Number(at);
    result.push({ click_id:id.trim(), at:Number.isFinite(time)&&time>0?time:null, source });
  };
  const notes = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const noteValue = (key) => notes.find((a)=>a?.name===key)?.value;
  const noteTime = noteValue("MyStorefront click_at") || noteValue("__MyStorefront click_at");
  for (const name of NOTE_ATTR_NAMES) add(noteValue(name),noteTime,"cart");
  for (const item of order.line_items || []) {
    const props = item?.properties || [];
    const value = (key) => Array.isArray(props)
      ? props.find((p)=>p?.name===key)?.value : props[key];
    const time = value("_MyStorefront click_at") || value("__MyStorefront click_at");
    for (const name of LINE_ITEM_PROP_NAMES) add(value(name),time,"line_item");
  }
  return result;
}

export function resolveOrderClick(order, pixel = null) {
  const cart=extractClickCandidates(order);
  const pixelHistory=Array.isArray(pixel?.history)?pixel.history:[];
  const seen=[...cart,...pixelHistory.map((x)=>({
    click_id:x.click_id,at:Number(x.at),source:"web_pixel",
  }))].filter((x)=>typeof x.click_id==="string"&&x.click_id.trim());
  const newest=seen.filter((x)=>Number.isFinite(x.at)&&x.at>0)
    .sort((a,b)=>b.at-a.at)[0];
  const fallback=cart[0] || seen[0] || null;
  const chosen=newest || fallback;
  const allTimes=seen.length>0 && seen.every((x)=>Number.isFinite(x.at)&&x.at>0);
  const sorted=[...new Set(seen.map((x)=>x.click_id))];
  // Conflicting IDs without timestamps cannot establish a provable last touch.
  const recencyComplete=allTimes && Boolean(newest) &&
    (pixel?.history_complete===true || sorted.length===1);
  return {
    click_id:chosen?.click_id||null,
    interaction_click_ids:sorted,
    recency_complete:recencyComplete,
    journey_id:pixel?.journey_id||null,
    pixel_present:Boolean(pixel),
  };
}
export function extractClickId(order) {
  return order?.__mystorefront_attribution?.click_id ||
    resolveOrderClick(order).click_id;
}

/**
 * Everything taken off a line, including its share of order-level codes.
 * Shopify spreads an "amount off order" code across lines in
 * discount_allocations. total_discount only covers line-level discounts, so
 * on its own it undercounts and the eligible subtotal comes out higher than
 * the order total (MyStorefront then rejects the postback with 422).
 */
function lineDiscount(item) {
  const lineGross = parseFloat(item?.price || 0) * (item?.quantity || 0);
  const allocations = Array.isArray(item?.discount_allocations) ? item.discount_allocations : [];
  if (allocations.length > 0) {
    const sum = allocations.reduce(
      (total, a) => total + parseFloat(a?.amount ?? a?.amount_set?.shop_money?.amount ?? 0),
      0,
    );
    return Math.min(Math.round(sum * 100) / 100, Math.round(lineGross * 100) / 100);
  }
  return parseFloat(item?.total_discount || 0);
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
    total_discount: lineDiscount(item),
  }));

  const itemsCount = lineItems.reduce(
    (sum, item) => sum + (item.quantity || 0),
    0
  );

  // Product merchandise after item discounts only. Shipping, shipping tax,
  // product tax and fees do not earn affiliate commission.
  const commissionableSubtotal = Math.max(0, Math.round(lineItems.reduce(
    (sum, item) => sum + item.price * item.quantity - item.total_discount, 0
  ) * 100) / 100);

return {
  click_id: clickId || null,
  order_id: String(order.id),
  order_total: parseFloat(order.total_price || 0),
  eligible_product_subtotal: commissionableSubtotal,
  currency: order.currency || "USD",
  test: Boolean(settings?.test_mode) || order?.test === true,
  metadata: {
    event: "purchase",
    attribution_evidence: {
      complete: order?.__mystorefront_attribution?.recency_complete === true &&
        typeof order.checkout_token === "string" &&
        Array.isArray(order.discount_codes) && typeof order.test === "boolean",
      discount_codes_complete: Array.isArray(order.discount_codes),
      verified_test_status: order.test === true ? "test" :
        order.test === false ? "live" : "unknown",
      checkout_at: order.processed_at || order.created_at || null,
      interaction_click_ids: order?.__mystorefront_attribution?.interaction_click_ids || [],
      discount_codes: Array.isArray(order.discount_codes)
        ? order.discount_codes.map((x)=>x.code).filter((x)=>typeof x==="string") : [],
      // A paid order confirms that Shopify accepted its applied discount(s).
      // The platform separately checks code ownership, expiry and brand rules.
      creator_code_policy_passed: order.financial_status === "paid",
      journey_id: order?.__mystorefront_attribution?.journey_id || null,
    },
    event_time: new Date().toISOString(),
    order_number: String(order.name || order.order_number || order.id),
    order_status: order.financial_status || "paid",
    gross_order_total: parseFloat(order.total_price || 0),
    commission_basis: "discounted_products_excluding_shipping_and_tax",
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
      plugin_version: PLUGIN_VERSION,
      order_is_test: order?.test === true,
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
        plugin_version: PLUGIN_VERSION,
        order_is_test: true,
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
export function buildCancellationPayload(shop, order, settings) {
  return {
    click_id: extractClickId(order) || null,
    order_id: String(order.id),
    cancellation_id: "cancel:" + order.id,
    order_total: parseFloat(order.total_price || 0),
    currency: order.currency || "USD",
    test: Boolean(settings?.test_mode) || order?.test === true,
    metadata: {
      event: "cancel",
      event_time: order.cancelled_at || new Date().toISOString(),
      order_number: String(order.name || order.order_number || order.id),
      order_status: "cancelled",
      store: {
        platform: "shopify",
        plugin_version: PLUGIN_VERSION,
        order_is_test: order?.test === true,
        site_url: "https://" + shop,
      },
    },
  };
}

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

  // Refund only the merchandise component. Refund transactions may contain
  // shipping and tax, neither of which was commissionable on purchase.
  // Shopify refund_line_items.subtotal is the post-discount merchandise refund.
  const refundedProducts = Math.round(refundLineItems.reduce(
    (sum, li) => sum + Math.abs(li.subtotal || 0), 0
  ) * 100) / 100;
  const signedTotal = refundedProducts > 0 ? -refundedProducts : 0;

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
    test: Boolean(settings?.test_mode) || order?.test === true,
    metadata: {
      event: "refund",
      commission_basis: "discounted_products_excluding_shipping_and_tax",
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
