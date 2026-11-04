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

## Double-gated durable receiver and retention (code only, 4 November 2026)

The branch now includes `web/backend/routes/web-pixel-staging-durable.js`
and `web/backend/web-pixel-staging-retention.js` plus tests.
Durable endpoint `POST /api/staging/web-pixel-durable` is mounted **only if**
all existing staging guard conditions are satisfied AND
`WEB_PIXEL_STAGING_PERSISTENCE_ENABLED=true`.
Both flags default to OFF. **Do not set them or deploy the branch yet.**

The adapter accepts only HashTopic test-store events, hashes browser/event
identifiers on the server, enforces strict schemas, limits request size,
rejects unknown fields and returns at most an unverified candidate. It
writes no Shopify orders, postbacks, sales, commissions or refunds. Its origin
check is NOT authentication. The local limiter is not distributed protection.

Retention code provides bounded deletion of expired referrals (30-day
window), event IDs older than 30 days, and manual-review rows older than
7 days. Client-hash erasure removes the referral row but is **not** complete
cross-table data erasure, because order review rows and event IDs cannot
be linked back to the erased client. Before any use with real shoppers,
introduce suitable consent provenance, deletion mapping, scheduling,
backup retention and a verified privacy policy. No cleanup job is scheduled.

The database schema file is still a reference design and **has not been
applied**. Existing staging Web Pixel JavaScript on the user's Mac still logs
locally; it does NOT call this endpoint. This addition alone does not provide
real end-to-end tracking, and does not fix Orphan Street's missing capture.

A full test requires (a) applying the migration to a separate staging DB,
(b) direct PostgreSQL concurrency and retention testing, (c) secure click
validation against MyStorefront, (d) explicit customer privacy review,
(e) validating Shopify's paid webhook and Admin API against the exact same
order, (f) destination-side order-level idempotency, and (g) deliberate
controlled rollout to staging only.

## MyStorefront trust check contract (not yet connected)

Two server-only modules were added:
- `web-pixel-trusted-click.js` accepts only a result from an authenticated,
  MyStorefront-owned server-side lookup confirming an existing click ID,
  its creator, its brand/shop, the click timestamp and consent eligibility.
  A missing or errored lookup rejects the candidate.
- `web-pixel-staging-review.js` composes Shopify's HMAC-signed paid-order
  evidence, an independently fetched Shopify order and that trusted click.
  The Shopify order creation time is obtained from the trusted Shopify
  response, not the browser.

This repository does NOT yet have a verified adapter to the MyStorefront
database. The `trusted_mystorefront_server` marker is a **contract**, not
authentication by itself. An attacker who can call this pure helper with
arbitrary objects could simulate evidence, so never expose it as an API or
call it with browser-provided server evidence. Map it to an authenticated
internal query, enforce real brand ownership and consent status and validate
the source of click IDs before any staging activation.

All outputs remain manual-review-only, with `commission_created:false`
and `can_send_postback:false`. No production routes or webhooks invoke
these helpers.

## MyStorefront schema-backed click lookup (4 November 2026)

Inspected GitHub repository `Roxifrancke/mystorefrontmvp-a1a72025`,
`src/integrations/supabase/types.ts` and
`supabase/functions/affiliate-postback/index.ts`. Their schema shows
`affiliate_clicks(click_id,creator_id,brand_id,link_id,created_at)`,
`links(id,user_id,is_deleted)` and `brand_accounts(id)`.
The current affiliate-postback looks up a click using `click_id` and
uses its brand/creator for attribution.

Added `web/backend/web-pixel-mystorefront-adapter.js`, a read-only
server-side Supabase REST adapter for **this observed schema**, plus
`web/tests/web-pixel-mystorefront-adapter.test.js`. The adapter checks
the click, expected brand UUID, creator ownership of the link and that
the brand exists. It validates the Supabase endpoint and requires a
server-only service credential. It is NOT mounted in any HTTP route.

**Not a deployed integration:** this repository may not represent the
currently deployed MyStorefront release; no verified mapping from
`mystorefront-test.myshopify.com` to a MyStorefront brand UUID is available.
Never guess the brand UUID or Supabase project credential. The source
schema has no consent-eligibility field, so the adapter deliberately returns
`consent_eligible:false` for every referral. This means the downstream
review gate remains blocked even with a matching stored click, until a
separately verified consent-proof mechanism is built and reviewed.

The required opt-in gate is
`WEB_PIXEL_STAGING_TRUSTED_CLICK_ENABLED=true` alongside the existing
staging receiver/persistence gates, exact staging service URL, the
staging Supabase HTTPS project root, a valid brand UUID and a server-only
service credential. Do **not** configure or enable these yet. Service-role
keys must never appear in a Shopify Web Pixel, public client, GitHub
source or logs. Use least-privilege server access where supported.

## Verified live Lovable schema and Shopify test-shop mismatch

Read-only inspected the MyStorefront project's live Lovable-backed Supabase
schema. The `affiliate_clicks`, `links`, `brand_accounts` and
`affiliate_orders` fields match the adapter's GitHub reference.

**Important, do not proceed with an attributed staging order yet:** the
HashTopic brand in that environment currently has `website_url` set to
`mystorefront-test-2.myshopify.com`, whereas the pixel checkout demonstration
ran on `mystorefront-test.myshopify.com`. These are distinct Shopify stores.

The click adapter now fails closed unless the brand's authoritative
`store_url` or `website_url` corresponds exactly to the Shopify test
store. No MyStorefront records were edited. The project may need a separate
test brand connected to the actual test shop, with correct permissions, before
the next end-to-end test. Confirm ownership/installation and brand mapping;
never remap a working brand merely to make a test pass.

The live MyStorefront `affiliate_clicks` schema includes no Shopify consent
record. The adapter therefore deliberately marks `consent_eligible:false`
and cannot release a real attribution. A documented, trustworthy consent
provenance strategy is required before this flag can be eligible.

## Shopify Customer Privacy API research (4 November 2026)

The official Web Pixels Standard API exposes `init.customerPrivacy` and
`customerPrivacy.subscribe('visitorConsentCollected', ...)`. The four
boolean properties include `analyticsProcessingAllowed` and
`marketingAllowed`. A pixel extension's declared privacy purposes also
control whether Shopify loads the pixel at all.

Official references:
- https://shopify.dev/docs/api/web-pixels-api/standard-api/customerprivacy
- https://shopify.dev/docs/api/web-pixels-api/pixel-privacy
- https://shopify.dev/docs/api/customer-privacy

Added `web/prototypes/shopify-web-pixel/consent-gate.js` and tests. Its
read-only, in-pixel status tracker rejects missing/false permissions and
reacts to consent changes. Shopify's permission allowance may reflect
merchant/region policy rather than an explicit opt-in: it is **not the same
thing as server-verifiable positive consent**. Browser-reported consent
must not by itself authenticate attribution. The local user-tested pixel
has not been replaced by this research helper. A complete rollout needs
privacy review, an appropriate retention policy and consent provenance.

Do **not** change the HashTopic brand's configured Shopify URL. The
live MyStorefront record references `mystorefront-test-2.myshopify.com`,
while the controlled pixel test was on `mystorefront-test.myshopify.com`.
Safest path is a separately verified test-brand association for the correct
shop, with brand owner consent and no production remapping.

## Controlled staging preflight (4 November 2026)

Added `web/backend/web-pixel-staging-preflight.js` and tests. This
read-only, fail-closed checklist confirms that all key conditions have
explicit evidence before a person authorizes staging. It does NOT inspect
live Shopify or Render state on its own; boolean inputs must come from
independently verified checks, not a browser or merchant-provided claim.

**Known blocker:** the HashTopic brand in MyStorefront currently records
`mystorefront-test-2.myshopify.com`, not the tested
`mystorefront-test.myshopify.com`. Do not silently update this existing
brand or attempt to count orders from the other store. Either independently
prove an existing brand-to-shop association or provision a dedicated
staging-only MyStorefront brand, with appropriate test isolation.

Shopify's Web Pixels customerPrivacy Standard API exposes
`init.customerPrivacy` and
`customerPrivacy.subscribe('visitorConsentCollected', ...)`.
Shopify's pixel manager loads a pixel only when its declared permissions
are allowed. This is a browser-side privacy gate, not cryptographic server
proof of consent; independent policy and data-handling review remain
outstanding. Official reference:
https://shopify.dev/docs/api/web-pixels-api/pixel-privacy

No request was made to Shopify checkout or live merchant data and no
staging receiver flags, production feature flags or commissions were enabled.

## Staging project environment audit

Inspected Lovable projects with read-only SQL:
- Main MyStorefront `4eab06f5-090c-47b2-a089-08e606446bea`: has the
  matching `affiliate_clicks`, `links`, `brand_accounts` and
  `affiliate_orders` fields, but its HashTopic brand is mapped to
  `mystorefront-test-2.myshopify.com`.
- Legacy `Staging_MyStorefront_13 March`
  `f271bfa4-6a44-4d82-89c3-d2f9ad3935bf`: database enabled and
  affiliate tables exist, but `brand_accounts.store_url` is absent and
  the HashTopic/test Shopify brand query returned no rows.

Added a read-only schema compatibility checker and test-brand ownership
gate in `web/backend/web-pixel-environment-audit.js`.
The March staging project must **not** be treated as a schema-compatible
clone just because it has affiliate tables. No database writes were made.

Next safe step: create or identify a genuine isolated test brand in an
appropriate up-to-date staging MyStorefront environment, confirm ownership
of the exact `mystorefront-test.myshopify.com` store, then revisit data
retention, consent and credentials. Do not alter the live HashTopic record,
secret keys, or commission flow to make the tests pass.

## Verified brand connection and provisional checkout persistence (4 November 2026)

Read-only verified MyStorefront's current HashTopic brand and its
`brand_shopify_settings` record after the user changed settings. The brand
website is `mystorefront-test.myshopify.com`; Shopify discount-code sync
references that same shop, the staging Render URL, and `is_verified=true`.
This resolves the *previous* store mapping discrepancy. It does **not**
verify Shopify Web Pixel event delivery, checkout attribution, consent or
paid-order postbacks. The previously recorded health check referred to the
old test-2 domain and must not be taken as current tracking proof.

Added the `web_pixel_staging_checkout_candidates` research table and
transactional insert in `lookupStagingCheckoutCandidate`. It retains
unverified candidates keyed by (shop, order, hashed browser). Multiple
different browsers can propose the same order; this must never mean
multiple commissions. Candidate erasure by client hash and 30-day cleanup
are included in the retention helper, with isolated PostgreSQL tests.
No existing affiliate or delivery table is written by this feature.

**Live activation remains blocked.** Web Pixel requests originate from a
strict sandbox. Shopify documents that outgoing `fetch` must support
CORS. Our current receiver still requires an exact storefront `Origin`
header; this may not match the strict sandbox's actual origin. Do not
change it to a blanket `*` origin or enable the receiver without first
capturing a test-store CORS preflight and checking Shopify's privacy
settings. Origin is never an authentication mechanism.

The tested Web Pixel extension is still on the user's Mac and does not
send checkout observations to this receiver. No actual staging migration,
Render deployment, server-side MyStorefront sale or commission occurred.

## Strict sandbox transport probe (4 November 2026)

Added a separate inert staging-only endpoint at
`/api/staging/web-pixel-transport-probe`, mounted before the general
CORS middleware, with only two allowed origins: literal `null` (Shopify
strict sandbox) and `https://mystorefront-test.myshopify.com`.
It accepts an empty POST and a browser OPTIONS preflight; neither stores
events nor creates postbacks or commissions. An explicit
`WEB_PIXEL_STAGING_TRANSPORT_PROBE_ENABLED=true` plus the exact staging
`SHOPIFY_APP_URL` is necessary for mounting. Default is off.

This probe is a transport test ONLY. Shopify strict-sandbox Origin
behavior can vary, so an actual browser network trace is still necessary.
Never interpret Origin as authentication or broaden it to enable the
real attribution receiver. The live pixel and production app are unchanged.
After deploying the probe to the staging Render host, validate an empty
`fetch()` from the Shopify test pixel and check the network response.
Only then design authenticated server-side order reconciliation and
privacy-compliant event storage; do not route a browser observation into
paid-order or commission logic.
