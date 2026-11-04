# MyStorefront Web Pixel attribution research (NOT DEPLOYED)

## Objective
Remove dependency on a merchant's active theme-app-embed without changing
normal creator-to-product links, carts, checkout, or commission calculations.

## What the branch demonstrates
- Validates a creator `click_id` observed on a Shopify `page_viewed` event.
- Accepts a `checkout_completed` observation with a Shopify order GID.
- Correlates the same Shopify `clientId` in a 30-day window as a **candidate**,
  **not** proof a commission is owed.
- Omits customer identity, contact details, pricing, and browser fingerprints.
- Does not send events, create orders, create commissions, install Shopify apps
  or modify Shopify Admin API scopes.
- Includes a non-deployable subscription sketch and pure Node tests.

## Significant unresolved risks
1. Shopify Web Pixels run in a strict sandbox: they cannot write the current
   `MyStorefront click_id` cart attribute or line-item property. The current
   webhook pipeline silently skips orders without these values.
2. A browser `clientId` correlation may be incomplete/unstable across domains,
   devices, consent choices, accelerated checkout, post-purchase flows and
   blocked script execution. A pixel checkout event may not have an order ID.
3. A checkout-completed event does not establish the order is paid, commission
   eligibility, amount, refunds, or a correct 30-day attribution choice.
4. Client-supplied event data cannot be trusted without server verification.
   Matching should be reconciled with the *verified Shopify order webhook* and
   protected from duplicate credits when theme-embed attribution also exists.
5. Consent and privacy settings can suppress events. Do not circumvent them.
6. A real pixel extension requires generating its own Shopify UID through CLI,
   the `@shopify/web-pixels-extension` runtime package, and Shopify approval
   of `write_pixels` + `read_customer_events` scope changes. No existing
   merchant is automatically upgraded by this branch.
7. Privacy/governance review is necessary before persisting even pseudonymous
   client IDs; retention/erasure requirements need definition.

## Next engineering milestones (staging only)
1. Generate a real web pixel extension via `shopify app generate extension
   --template web_pixel --name mystorefront-attribution` using a TEST app.
2. Select appropriate required privacy purposes and configure first-party,
   authenticated event ingestion with rate limiting and replay protection.
3. Observe allowed test-store page-view and checkout events, and compare
   the client ID/order ID against Shopify webhooks.
4. Build a restricted, server-side attribution candidate store; never award
   commissions directly from pixel events. Require a verified Shopify order,
   confirmed payment, eligible item totals, cookie window and deduplication.
5. Trial normal product browsing, privacy opt-out, cross-domain checkout,
   Buy Now/Shop Pay, multiple clicks, refunds, and both-embed-enabled cases.
6. Only request new merchant permissions after successful staging validation.

Shopify docs:
https://shopify.dev/docs/apps/build/marketing/build-web-pixels
https://shopify.dev/docs/api/web-pixels-api
https://shopify.dev/docs/api/web-pixels-api/standard-events/page_viewed
