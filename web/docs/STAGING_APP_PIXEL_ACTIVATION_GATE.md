# Staging-only Shopify App Web Pixel: first activation gate

## Why this is deliberately only a smoke test
The existing `extensions/click-id-capture` is a **theme app embed**, not a Shopify Web Pixel. Its DOM form injection, `/cart/update.js` requests and cookie handling cannot simply be transplanted to the strict Web Pixel sandbox. The first test must prove that a true Shopify app pixel is registered, activated, and firing, without changing affiliate orders, commissions or existing tracking.

## Confirmed staging identities
- Shopify **MyStorefront Postback Staging** client ID: `2f3aa895637da2cc63111d4922a5dd17` (confirmed by merchant screenshot, 5 November 2026)
- Shopify test shop: `mystorefront-test.myshopify.com`
- Render service: `hashtopic-postback-shopify-staging` on GitHub `staging` branch
- Staging backend: `https://hashtopic-postback-shopify-staging.onrender.com`
- Production app and `main` branch: strictly excluded

## Before Shopify deployment
1. Review this PR into `staging`. The amended Shopify CLI configuration was formerly pointed at production. Ensure the staging process uses this config exclusively via `--config mystorefront-postback`, and compare the reported client ID before any CLI command that writes to Shopify.
2. Verify the **Render staging service's** `SHOPIFY_API_KEY`, `SHOPIFY_APP_URL`, `SHOPIFY_API_SECRET`, `DATABASE_URL` and dedicated Shopify installation without revealing secrets in logs or chat. App ID and URL must match staging. Never copy or change production secrets or database. An app config file does not change Render environment variables.
3. Use an up-to-date Shopify CLI in a trusted development environment logged into the correct Shopify organization. Scaffold a **new** extension with `shopify app generate extension --template web_pixel --name mystorefront-staging-pixel`, ensuring it is tied to the confirmed staging app. **Let Shopify CLI generate and manage its own extension UID**; do not invent/copy production extension UIDs.
4. Replace the generated extension's source `src/index.js` with `web/prototypes/shopify-web-pixel/staging-transport-smoke.js`. Configure the generated `shopify.extension.toml` with `type = "web_pixel_extension"`, `runtime_context = "strict"`, and explicitly declared `customer_privacy` purposes appropriate to the retailer's consent requirements. This smoke test transmits no user data, but must still respect Shopify's privacy gating. Do not force consent-independent settings to bypass choices.
5. Confirm the dedicated staging backend has `WEB_PIXEL_STAGING_TRANSPORT_PROBE_ENABLED=true` and `SHOPIFY_APP_URL` points to the staging Render URL. This harmless probe only accepts empty POSTs from `Origin: null` or the test shop; its availability is not proof of click attribution.
6. Deploy the extension **only to the confirmed staging Shopify app** with Shopify CLI. Validate the CLI-selected app and config before deployment. Shopify deployment is not the same as a Render deployment.
7. Activate the pixel on the **test shop only** using the Admin GraphQL `webPixelCreate` mutation and a properly scoped **staging app** token, then verify it appears Connected in Settings > Customer events. Consent settings can prevent events from firing until granted.
8. Visit the test shop and confirm a POST to `/api/staging/web-pixel-transport-probe/` in **staging Render request logs**. Do not expect to find the sandbox script in Shopify's page-view source.

## Acceptance gates
- Correct staging app ID in CLI, correct staging host in Render, and separate database: **required**.
- Shopify Customer events says staging app pixel Connected: **required**.
- At least one zero-payload `POST` from Shopify's Web Pixel sandbox reaches staging and receives 204: **required**.
- No changes to production Postback, paid-order processing, postbacks, commissions or MyStorefront: **required**.

**STOP** at this milestone. A successful probe does NOT demonstrate affiliate referral capture or paid-order attribution. Those require separate design of consent-aware, server-attested click transport and order binding. Never treat `checkout_completed` alone as proof of an `orders/paid` event.
