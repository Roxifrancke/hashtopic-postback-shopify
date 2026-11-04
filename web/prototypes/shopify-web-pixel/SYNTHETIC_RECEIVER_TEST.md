# Local synthetic receiver verification (no real shopper events)

This is a deliberately **offline, synthetic-only** research milestone for PR #9.
It does not transmit Shopify pixel events or persist visitor identifiers.

The existing HashTopic test Web Pixel is connected in Shopify and its
`page_viewed` subscription has logged `referralDetected: true` in Chrome.
That is proven **page-view detection only**, not backend ingestion,
checkout matching or paid-sale attribution.

## Run from a checked-out PR #9 copy

```sh
npm run test --workspace=web
PIXEL_PROTOTYPE_MODE=synthetic node web/prototypes/shopify-web-pixel/staging-receiver.mjs
```

In another terminal, send a synthetic event:

```sh
curl --fail-with-body -sS -X POST http://127.0.0.1:48731/observations \
  -H 'Content-Type: application/json' \
  -d '{"shop":"mystorefront-test.myshopify.com","event":{"id":"synthetic-event-page-1","clientId":"synthetic-client-abc","name":"page_viewed","timestamp":"2026-11-04T16:00:00Z","context":{"document":{"location":{"href":"https://example.test/products/demo?click_id=test_referral_123456"}}}}}'
```

**Note:** Observations are valid only within 30 days of the system clock.
Adjust synthetic timestamps to current UTC if retesting later.

Expected: `{"status":"synthetic_referral_observed","recorded":true}`.

A synthetic checkout event with the same clientId and a later event timestamp
can yield `status: "candidate_only"`. A candidate is *never* a sale.
The receiver accepts only `synthetic-event-*`, `synthetic-client-*`,
`test_*` referral IDs, the `example.test` origin and the HashTopic test
store. It binds only to `127.0.0.1`, holds bounded in-memory records
and has no access to Shopify, MyStorefront postbacks or the orders database.

## Conditions before any real staging telemetry

1. Shopify Web Pixel receives `checkout_completed` on a genuine test
   checkout, with customer consent and developer-authorised test order.
2. Observe *only schema*, not personal contents, to validate order identifier
   formats and `clientId` continuity; do not paste real events in chat.
3. Design authenticated and rate-limited public ingestion, including
   no PII, encrypted-at-rest short retention, deletion compliance,
   anti-replay/idempotency and secure per-shop identity.
4. Verify order payment and commission-eligible subtotal independently from
   a Shopify-signed webhook/Admin API. Never treat a browser-supplied event
   as authoritative.
5. Enforce 30-day attribution, last-click policy, order-level deduplication
   against the old embed, refunds and exclusions, consent regulations.
6. Security/privacy review **before** changing the pixel to make outbound
   network requests. Shopify events follow consent decisions.

Do not merge PR #9, deploy this receiver or add network transmission to the
connected Shopify pixel yet. All live merchant stores remain unchanged.
