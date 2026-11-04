import test from "node:test";
import assert from "node:assert/strict";
import {
  readReferralFromPageUrl, toPixelAttributionObservation, proposeAttributionCandidate,
} from "../backend/web-pixel-attribution-prototype.js";

const now = Date.parse("2026-11-04T12:00:00Z");
const shop = "mystorefront-test.myshopify.com";
const referral = {
  id: "event-page-1", clientId: "shopify-anonymous-client-123",
  name: "page_viewed", timestamp: "2026-11-04T11:00:00Z",
  context: { document: { location: { href: "https://example.com/products/shirt?click_id=creator_referral_123" } } },
};
const checkout = {
  id: "event-checkout-1", clientId: referral.clientId, name: "checkout_completed",
  timestamp: "2026-11-04T11:05:00Z", data: {
    checkout: { order: { id: "gid://shopify/Order/12345" }, email: "private@example.com" }
  },
};

test("recognizes only opaque click IDs in product-page URLs", () => {
  assert.equal(readReferralFromPageUrl(referral.context.document.location.href), "creator_referral_123");
  assert.equal(readReferralFromPageUrl("https://example.com/?click_id=<script>"), null);
  assert.equal(readReferralFromPageUrl("javascript:alert(1)"), null);
  assert.equal(readReferralFromPageUrl("https://example.com/?click_id=short"), null);
});

test("normalizes Shopify events with no shopper PII or checkout price", () => {
  const a = toPixelAttributionObservation({event: referral, shop, nowMs: now});
  const b = toPixelAttributionObservation({event: checkout, shop, nowMs: now});
  assert.equal(a.click_id, "creator_referral_123");
  assert.equal(b.order_id, "gid://shopify/Order/12345");
  assert.equal(b.outcome, "requires_verified_order_match");
  assert.ok(!JSON.stringify([a,b]).includes("private@example.com"));
  assert.ok(!JSON.stringify([a,b]).includes("example.com/products"));
  assert.deepEqual(proposeAttributionCandidate(a,b,now), {
    shop, order_id: "gid://shopify/Order/12345", click_id: "creator_referral_123",
    status: "candidate_only", requires_order_verification: true,
  });
});

test("never matches across separate Shopify client IDs or shops", () => {
  const a = toPixelAttributionObservation({event: referral, shop, nowMs: now});
  const b = toPixelAttributionObservation({event: checkout, shop, nowMs: now});
  assert.equal(proposeAttributionCandidate(a, {...b, client_id:"another-browser"},now), null);
  assert.equal(proposeAttributionCandidate(a, {...b, shop:"other.myshopify.com"},now), null);
  assert.equal(proposeAttributionCandidate(a, {...b, event_time:"2026-12-09T12:00:00Z"},now), null);
});

test("no checkout order id means no attribution, not a fake sale", () => {
  const a = toPixelAttributionObservation({event: referral, shop, nowMs: now});
  const b = toPixelAttributionObservation({
    event: {...checkout, data:{checkout:{order:null}}}, shop, nowMs: now
  });
  assert.equal(b.outcome,"unmatched_checkout_event");
  assert.equal(proposeAttributionCandidate(a,b,now), null);
});

test("prevents stale and malformed observations", () => {
  assert.equal(toPixelAttributionObservation({event:referral,shop:"untrusted.example",nowMs:now}),null);
  assert.equal(toPixelAttributionObservation({event:{...referral,timestamp:"2025-01-01T00:00:00Z"},shop,nowMs:now}),null);
  assert.equal(toPixelAttributionObservation({event:{...referral,clientId:""},shop,nowMs:now}),null);
});
