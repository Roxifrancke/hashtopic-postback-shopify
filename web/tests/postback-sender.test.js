// Integration tests for the attribution chain.
//
// Run with: npm test  (uses Node's built-in test runner, no extra deps)
//
// Covers the critical revenue path:
//   1. click_id arrives via URL → cart attribute (simulated)
//   2. Order webhook fires → note_attributes contains click_id
//   3. buildPayload extracts click_id correctly into the postback
//   4. Refund webhook fires → buildRefundPayload produces a negative-total
//      clawback payload with the correct click_id, refund_id, and line items

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPayload,
  buildRefundPayload,
  buildTestPayload,
  extractClickId,
  nextRetryAt,
} from "../backend/postback-sender.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeOrder(overrides = {}) {
  return {
    id: 4567890,
    name: "#1042",
    order_number: 1042,
    total_price: "150.00",
    currency: "ZAR",
    financial_status: "paid",
    total_tax: "19.50",
    total_discounts: "10.00",
    total_shipping_price_set: { shop_money: { amount: "20.00" } },
    email: "buyer@example.com",
    customer: { email: "buyer@example.com", phone: "+27821234567" },
    note_attributes: [
      { name: "click_id", value: "abc123xyz" },
      { name: "other_field", value: "ignored" },
    ],
    line_items: [
      {
        product_id: 111,
        variant_id: 222,
        sku: "SKU-A",
        title: "Product A",
        quantity: 2,
        price: "50.00",
        total_discount: "5.00",
      },
      {
        product_id: 333,
        variant_id: 444,
        sku: "SKU-B",
        title: "Product B",
        quantity: 1,
        price: "30.00",
        total_discount: "0.00",
      },
    ],
    ...overrides,
  };
}

function makeRefund(overrides = {}) {
  return {
    id: 9988776655,
    order_id: 4567890,
    note: "Customer changed mind",
    transactions: [
      { kind: "refund", status: "success", amount: "55.00" },
    ],
    refund_line_items: [
      {
        quantity: 1,
        subtotal: "50.00",
        total_tax: "5.00",
        line_item: {
          product_id: 111,
          variant_id: 222,
          sku: "SKU-A",
          title: "Product A",
          price: "50.00",
        },
      },
    ],
    ...overrides,
  };
}

// ── Step 3: buildPayload extracts click_id from note_attributes ─────────────

test("buildPayload — extracts click_id from order note_attributes", () => {
  const payload = buildPayload("test-shop.myshopify.com", makeOrder(), {});
  assert.equal(payload.click_id, "abc123xyz");
});

test("buildPayload — click_id is null when note_attributes is missing", () => {
  const payload = buildPayload("test-shop.myshopify.com", makeOrder({ note_attributes: [] }), {});
  assert.equal(payload.click_id, null);
});

test("buildPayload — click_id is null when note_attributes is undefined", () => {
  const order = makeOrder();
  delete order.note_attributes;
  const payload = buildPayload("test-shop.myshopify.com", order, {});
  assert.equal(payload.click_id, null);
});

test("buildPayload — order_total parsed as a number", () => {
  const payload = buildPayload("test-shop.myshopify.com", makeOrder(), {});
  assert.equal(payload.order_total, 150.0);
  assert.equal(typeof payload.order_total, "number");
});

test("buildPayload — items_count sums line_item quantities", () => {
  const payload = buildPayload("test-shop.myshopify.com", makeOrder(), {});
  assert.equal(payload.metadata.items_count, 3); // 2 + 1
});

test("buildPayload — line_items included with per-item detail", () => {
  const payload = buildPayload("test-shop.myshopify.com", makeOrder(), {});
  assert.equal(payload.metadata.line_items.length, 2);
  assert.deepEqual(payload.metadata.line_items[0], {
    product_id: "111",
    variant_id: "222",
    sku: "SKU-A",
    title: "Product A",
    quantity: 2,
    price: 50.0,
    total_discount: 5.0,
  });
});

test("buildPayload — IDs serialised as strings (Shopify uses bigint IDs)", () => {
  const payload = buildPayload("test-shop.myshopify.com", makeOrder(), {});
  assert.equal(typeof payload.order_id, "string");
  assert.equal(typeof payload.metadata.line_items[0].product_id, "string");
});

test("buildPayload — test flag honours settings.test_mode", () => {
  const liveSettings = { test_mode: false };
  const testSettings = { test_mode: true };
  assert.equal(buildPayload("shop.myshopify.com", makeOrder(), liveSettings).test, false);
  assert.equal(buildPayload("shop.myshopify.com", makeOrder(), testSettings).test, true);
});

test("buildPayload — currency falls back to USD if missing", () => {
  const payload = buildPayload("shop.myshopify.com", makeOrder({ currency: null }), {});
  assert.equal(payload.currency, "USD");
});

test("buildPayload — site_url uses shop domain", () => {
  const payload = buildPayload("rori-store.myshopify.com", makeOrder(), {});
  assert.equal(payload.metadata.store.site_url, "https://rori-store.myshopify.com");
  assert.equal(payload.metadata.store.platform, "shopify");
});

// ── buildTestPayload ────────────────────────────────────────────────────────

test("buildTestPayload — returns a well-formed test payload", () => {
  const payload = buildTestPayload("shop.myshopify.com", { test_mode: false });
  assert.equal(payload.test, true);
  assert.equal(payload.metadata.event, "purchase");
  assert.ok(payload.click_id.startsWith("test_click_"));
  assert.ok(Array.isArray(payload.metadata.line_items));
  assert.equal(payload.metadata.line_items.length, 1);
});

// ── Refund (clawback) payload tests ─────────────────────────────────────────

test("buildRefundPayload — order_total is negative", () => {
  const payload = buildRefundPayload(
    "shop.myshopify.com",
    makeOrder(),
    makeRefund(),
    {}
  );
  assert.equal(payload.order_total, -55.0);
  assert.ok(payload.order_total < 0, "Refund total must be negative for clawback");
});

test("buildRefundPayload — extracts click_id from parent order", () => {
  const payload = buildRefundPayload(
    "shop.myshopify.com",
    makeOrder(),
    makeRefund(),
    {}
  );
  assert.equal(payload.click_id, "abc123xyz");
});

test("buildRefundPayload — includes refund_id and refund_reference for dedupe", () => {
  const payload = buildRefundPayload(
    "shop.myshopify.com",
    makeOrder(),
    makeRefund(),
    {}
  );
  assert.equal(payload.refund_id, "9988776655");
  assert.equal(payload.metadata.refund_reference, "9988776655");
});

test("buildRefundPayload — event is 'refund'", () => {
  const payload = buildRefundPayload(
    "shop.myshopify.com",
    makeOrder(),
    makeRefund(),
    {}
  );
  assert.equal(payload.metadata.event, "refund");
});

test("buildRefundPayload — refund line_items only include refunded items", () => {
  const payload = buildRefundPayload(
    "shop.myshopify.com",
    makeOrder(),
    makeRefund(),
    {}
  );
  // Original order had 2 line items, refund only refunded 1 — payload must reflect that
  assert.equal(payload.metadata.line_items.length, 1);
  assert.equal(payload.metadata.line_items[0].sku, "SKU-A");
  assert.equal(payload.metadata.line_items[0].quantity, 1);
});

test("buildRefundPayload — sums multiple refund transactions", () => {
  const refund = makeRefund({
    transactions: [
      { kind: "refund", status: "success", amount: "30.00" },
      { kind: "refund", status: "success", amount: "25.00" },
      { kind: "refund", status: "failure", amount: "999.00" }, // ignored
      { kind: "authorization", status: "success", amount: "100.00" }, // ignored
    ],
  });
  const payload = buildRefundPayload("shop.myshopify.com", makeOrder(), refund, {});
  assert.equal(payload.order_total, -55.0);
});

test("buildRefundPayload — falls back to refund_line_items total when no transactions", () => {
  const refund = makeRefund({ transactions: [] });
  const payload = buildRefundPayload("shop.myshopify.com", makeOrder(), refund, {});
  // subtotal 50 + total_tax 5 = 55
  assert.equal(payload.order_total, -55.0);
});

test("buildRefundPayload — handles missing parent order gracefully", () => {
  // Simulates the case where Admin API order fetch fails — handler still
  // produces a payload but with click_id = null. The webhook handler
  // should skip the postback when click_id is null (not an affiliate order),
  // but the payload builder itself must not crash.
  const payload = buildRefundPayload(
    "shop.myshopify.com",
    null,
    makeRefund(),
    {}
  );
  assert.equal(payload.click_id, null);
  assert.equal(payload.order_id, "4567890");
  assert.equal(payload.refund_id, "9988776655");
});

// ── nextRetryAt ─────────────────────────────────────────────────────────────

test("nextRetryAt — first attempt is immediate (returns null)", () => {
  assert.equal(nextRetryAt(0), null);
});

test("nextRetryAt — schedules subsequent retries in the future", () => {
  const before = Date.now();
  const retry = new Date(nextRetryAt(1)).getTime();
  assert.ok(retry > before, "Retry time must be in the future");
  // 5 minutes (300s) for attempt 1, with a small tolerance
  assert.ok(retry - before >= 299 * 1000);
  assert.ok(retry - before <= 301 * 1000);
});

// ── Step 1+2: simulate the cart attribute → note_attributes flow ────────────
// Shopify converts cart attributes into order note_attributes automatically;
// these tests verify our extractor handles the resulting shape correctly.

test("attribution chain — click_id from cart attribute appears as note_attribute", () => {
  // Simulates what Shopify produces when the storefront capture script
  // sets `attributes: { click_id: 'xyz' }` on the cart.
  const orderFromShopify = makeOrder({
    note_attributes: [{ name: "click_id", value: "campaign_summer_2026" }],
  });
  const payload = buildPayload("shop.myshopify.com", orderFromShopify, {});
  assert.equal(payload.click_id, "campaign_summer_2026");
});

test("attribution chain — first matching note_attribute wins on duplicates", () => {
  const orderFromShopify = makeOrder({
    note_attributes: [
      { name: "click_id", value: "first_click" },
      { name: "click_id", value: "second_click" },
    ],
  });
  const payload = buildPayload("shop.myshopify.com", orderFromShopify, {});
  assert.equal(payload.click_id, "first_click");
});

// ── v1.3: line-item-properties is the primary source ───────────────────────
//
// In v1.3 the storefront capture script injects a hidden
// `<input name="properties[click_id]">` into product forms, so click_id
// arrives on each line_item.properties (Shopify webhook delivers them as
// an array of {name, value} objects). This is robust to Buy It Now and
// Shop Pay flows that bypass the cart and therefore never get a cart
// attribute set.
//
// The extractor must:
//   1. prefer line_items[].properties.click_id over note_attributes
//   2. fall back to note_attributes if no line item property is set
//   3. return null safely when neither source has a click_id
//   4. handle multiple line items (first non-empty wins)

test("extractClickId — line item property (array form) is primary source", () => {
  const order = makeOrder({
    note_attributes: [{ name: "click_id", value: "from_cart_attribute" }],
    line_items: [
      {
        product_id: 111,
        variant_id: 222,
        sku: "SKU-A",
        title: "Product A",
        quantity: 1,
        price: "50.00",
        total_discount: "0.00",
        properties: [{ name: "click_id", value: "from_line_item" }],
      },
    ],
  });
  // Line item beats note_attribute when both are present.
  assert.equal(extractClickId(order), "from_line_item");
});

test("extractClickId — line item property (object form) is also recognised", () => {
  // Some Admin API responses serialise properties as a plain object rather
  // than the {name,value}[] shape the webhook uses. Both must work.
  const order = makeOrder({
    note_attributes: [],
    line_items: [
      {
        product_id: 111,
        variant_id: 222,
        sku: "SKU-A",
        title: "Product A",
        quantity: 1,
        price: "50.00",
        total_discount: "0.00",
        properties: { click_id: "from_object_form" },
      },
    ],
  });
  assert.equal(extractClickId(order), "from_object_form");
});

test("extractClickId — falls back to note_attributes when no line item property", () => {
  const order = makeOrder({
    note_attributes: [{ name: "click_id", value: "fallback_value" }],
    line_items: [
      {
        product_id: 111,
        variant_id: 222,
        sku: "SKU-A",
        title: "Product A",
        quantity: 1,
        price: "50.00",
        total_discount: "0.00",
        properties: [], // no click_id in line items
      },
    ],
  });
  assert.equal(extractClickId(order), "fallback_value");
});

test("extractClickId — returns null when neither source has click_id", () => {
  const order = makeOrder({
    note_attributes: [{ name: "other_field", value: "nope" }],
    line_items: [
      {
        product_id: 111,
        sku: "SKU-A",
        quantity: 1,
        price: "50.00",
        properties: [{ name: "gift_message", value: "Happy birthday" }],
      },
    ],
  });
  assert.equal(extractClickId(order), null);
});

test("extractClickId — multi line item: first line item with click_id wins", () => {
  const order = makeOrder({
    note_attributes: [],
    line_items: [
      {
        product_id: 111,
        sku: "SKU-A",
        quantity: 1,
        price: "10.00",
        properties: [{ name: "gift_message", value: "no click_id here" }],
      },
      {
        product_id: 222,
        sku: "SKU-B",
        quantity: 1,
        price: "20.00",
        properties: [{ name: "click_id", value: "second_item_click" }],
      },
      {
        product_id: 333,
        sku: "SKU-C",
        quantity: 1,
        price: "30.00",
        properties: [{ name: "click_id", value: "third_item_click" }],
      },
    ],
  });
  // First line item that actually carries click_id wins (deterministic).
  assert.equal(extractClickId(order), "second_item_click");
});

test("extractClickId — empty/whitespace property doesn't suppress note_attribute fallback", () => {
  // A stale empty value on a line item must not block the note_attributes
  // fallback — otherwise a cleared form would silently lose attribution.
  const order = makeOrder({
    note_attributes: [{ name: "click_id", value: "fallback_wins" }],
    line_items: [
      {
        product_id: 111,
        sku: "SKU-A",
        quantity: 1,
        price: "10.00",
        properties: [{ name: "click_id", value: "   " }],
      },
    ],
  });
  assert.equal(extractClickId(order), "fallback_wins");
});

test("extractClickId — values are trimmed", () => {
  const order = makeOrder({
    note_attributes: [],
    line_items: [
      {
        product_id: 111,
        sku: "SKU-A",
        quantity: 1,
        price: "10.00",
        properties: [{ name: "click_id", value: "  trimmed_id  " }],
      },
    ],
  });
  assert.equal(extractClickId(order), "trimmed_id");
});

test("extractClickId — handles null/undefined order safely", () => {
  assert.equal(extractClickId(null), null);
  assert.equal(extractClickId(undefined), null);
  assert.equal(extractClickId({}), null);
});

test("extractClickId — handles missing line_items array", () => {
  const order = {
    note_attributes: [{ name: "click_id", value: "from_notes" }],
  };
  // No line_items at all → still finds the note attribute.
  assert.equal(extractClickId(order), "from_notes");
});

// ── v1.3: integration — buildPayload uses the new priority ─────────────────

test("buildPayload — v1.3: line item properties take priority over note_attributes", () => {
  const order = makeOrder({
    note_attributes: [{ name: "click_id", value: "old_cart_attribute" }],
    line_items: [
      {
        product_id: 111,
        variant_id: 222,
        sku: "SKU-A",
        title: "Product A",
        quantity: 2,
        price: "50.00",
        total_discount: "5.00",
        properties: [{ name: "click_id", value: "new_line_item_click" }],
      },
    ],
  });
  const payload = buildPayload("shop.myshopify.com", order, {});
  assert.equal(payload.click_id, "new_line_item_click");
});

test("buildPayload — v1.3: simulates Buy It Now flow (line item only, no cart attr)", () => {
  // In Buy It Now / Shop Pay express checkout, /cart/update.js is never
  // called, so note_attributes will be empty. The hidden form input is
  // the only attribution channel that survives.
  const order = makeOrder({
    note_attributes: [], // cart attribute write didn't happen
    line_items: [
      {
        product_id: 111,
        sku: "SKU-A",
        title: "Product A",
        quantity: 1,
        price: "50.00",
        total_discount: "0.00",
        properties: [{ name: "click_id", value: "buy_it_now_click" }],
      },
    ],
  });
  const payload = buildPayload("shop.myshopify.com", order, {});
  assert.equal(payload.click_id, "buy_it_now_click");
});

test("buildRefundPayload — v1.3: extracts click_id from parent order line items", () => {
  // Parent order's line items carry click_id (v1.3 path), refund webhook
  // fetches the parent order, refund payload still gets attribution.
  const order = makeOrder({
    note_attributes: [],
    line_items: [
      {
        product_id: 111,
        variant_id: 222,
        sku: "SKU-A",
        title: "Product A",
        quantity: 2,
        price: "50.00",
        total_discount: "5.00",
        properties: [{ name: "click_id", value: "refund_click_id" }],
      },
    ],
  });
  const refund = makeRefund();
  const payload = buildRefundPayload("shop.myshopify.com", order, refund, {});
  assert.equal(payload.click_id, "refund_click_id");
});
