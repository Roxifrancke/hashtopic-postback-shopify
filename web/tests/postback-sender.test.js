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
