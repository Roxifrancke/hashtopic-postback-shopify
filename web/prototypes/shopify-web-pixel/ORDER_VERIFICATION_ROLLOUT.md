# Web Pixel checkout attribution: implementation gates

The HashTopic staging Web Pixel was tested manually on 4 November 2026.
The console showed `referralFound: true`, `sameClient: true`,
`within30Days: true`, `orderIdPresent: true`, `matched: true`
on the immediate Shopify test-gateway thank-you page.

**This verifies one browser-local journey, not a recorded affiliate sale.**
No real brand or production extension was modified.

## What this PR implements

- Pure referral-event parsing and 30-day window candidate matching.
- Loopback-only, synthetic-data-only receiver in `staging-receiver.mjs`.
- Pure, fail-closed `assessVerifiedAttribution` for a candidate and a
  **server-fetched** Shopify Admin API order; rejects unpaid, cancelled,
  mismatched, malformed and stale inputs.
- Pure `assessLegacyDeliveryConflict` that rejects duplicate legacy deliveries
  and refuses to assume safe absence when the database lookup fails.
- A gated, staging-only `POST /api/staging/web-pixel-observations` handler for the
  HashTopic test store. It returns only provisional browser-event candidates.
  It must never be considered authenticated payment proof. The handler stores
  only bounded in-memory correlation data and hashes browser IDs; restart
  clears all observations. It does not persist referrals or verify Shopify
  orders. A public browser's `Origin` header is **not** authentication.
- Unit tests. No production deployment, DB migration, outbound transmission,
  or commission-changing code is enabled.

## Required implementation before real staging ingestion

1. **Consent**: confirm which permissions are actually needed for affiliate
   measurement; avoid the broad `Always on` setting in production without
   privacy review. Explicit merchant and shopper consent rules apply.
2. **Identity and anti-abuse**: Shopify Web Pixels are public browser clients.
   Do not put a private API key into pixel code. Implement strict per-shop
   origin policy, request limits, replay protection, non-enumerable
   identifiers and a strategy to distinguish bogus events from real ones.
   Treat every browser-supplied order ID and click ID as untrusted.
3. **Store-specific identity**: the connected staging app is separate from
   production. Never send staging data or keys to production endpoints.
4. **Persistence and retention**: database rows for referrals and completed
   checkouts, 30-day expiry, data minimization, consent withdrawal and deletion.
   Deduplicate by event ID and (shop, order ID), with indexes and transactional
   locks, and protect against out-of-order events.
5. **Verification**: a trusted server retrieves the order independently via
   Shopify Admin API using the shop's server-side credential; the Shopify
   `orders/paid` HMAC-signed webhook is the preferred positive payment
   signal. Verify financial status, currency, refund/cancellation state,
   commission eligibility and discount handling. Never count a checkout
   event alone as a paid sale.
6. **Prevent double commission**: check existing `deliveries` and the
   MyStorefront destination's affiliate-orders idempotency for the same
   canonical (shop, order) before any postback. The current embed route is
   authoritative until explicit migration.
7. **End-to-end controlled test**: run exactly one development store order
   with synthetic referral, confirm delivery in the correct staging
   MyStorefront environment, check retries/refunds and no duplicate payment.
8. **Merchant activation**: deploy the production extension in a reviewed
   app version, request merchant authorization when Shopify requires it,
   then programmatically `webPixelCreate` per store. Theme embeds are
   separate and need not be toggled for the pixel. Do not assume existing
   stores are automatically approved/activated.

## Current constraints

The local Shopify staging Web Pixel code is on the user's Mac, not yet
checked into this repository. Do not overwrite it from PR #9 without
explicitly syncing the tested version. The Shopify staging client ID and
extension UID must remain associated with the staging app.

This research branch must remain unmerged and undeployed to production
until the guards above have been validated.

## Deployment state and feature gate (4 November 2026)

**No deployment is authorized yet.** The feature flag defaults to OFF,
and production must leave it OFF. The opt-in handler is mounted only when:

- `WEB_PIXEL_STAGING_RECEIVER_ENABLED=true`
- `SHOPIFY_APP_URL=https://hashtopic-postback-shopify-staging.onrender.com`
- `WEB_PIXEL_STAGING_HASH_KEY` is a randomly generated, secret value with at
  least 32 characters stored only in the staging server's secrets manager.

No key may be embedded in a Web Pixel. No brand other than
`mystorefront-test.myshopify.com` can submit a valid observation. For this
phase, do **not** enable the flag or wire the browser pixel to the endpoint;
first complete Shopify order retrieval, consent review, durable deduplication
and a no-commission staging acceptance test. GitHub CI validates the code,
not real Shopify interoperability.

**Critical gap:** the existing staging pixel code is in the user's local
`extensions/mystorefront-web-pixel/src/index.js`. It still logs a local
`matched: true` result; it is not a remotely deployed ingestion client.
The receiver alone cannot recover Orphan Street's missing attribution.

## Durable staging ledger prototype (not deployed)

Files in PR #9:
- `staging-ledger.schema.sql`: reference-only SQL for restricted HashTopic
  staging referrals, hashed browser/event identifiers and unique order review.
  **It is not a migration run by the Shopify app** and must not be applied
  to the production database.
- `web/backend/web-pixel-staging-ledger.js`: opt-in transaction helpers with
  replay-safe event insert, last-referral ordering, 30-day expiry, and
  exact legacy-delivery conflict checks before a unique manual-review claim.
- `web/tests/web-pixel-staging-ledger.test.js`: mocked transaction tests;
  real PostgreSQL transaction and crash/retry testing is still required.

No new ledger helpers are mounted in `web/backend/index.js` or used by the
current Web Pixel receiver. **There is no live durable storage**, Shopify
payment confirmation integration, automatic affiliate order or commission.

Before any staging deployment: configure least-privilege DB access and
retention/deletion automation, settle the lawfulness and purpose of
pseudonymous browser IDs, validate trusted click IDs against MyStorefront,
test transaction concurrency against real staging Postgres, and connect
receipt of Shopify-signed paid webhooks to a secure reconciliation queue.
Only then may a verified staging event become a **manual review record**.
