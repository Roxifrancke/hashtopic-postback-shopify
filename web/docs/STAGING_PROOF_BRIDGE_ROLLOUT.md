# Protected referral bridge: staging-only deployment and acceptance gate

This is a preparation checklist, NOT an instruction to enable commissions.
The new Web Pixel attribution and legacy order postbacks remain independent.
Never deploy a MyStorefront service-role key to Shopify, Render, GitHub,
Web Pixels, browsers or ticket comments.

## Paired changes
- MyStorefront PR #6 adds a protected Edge Function named
  `staging-referral-proof-verify`, currently undeployed.
- Shopify staging PR #20 adds a read-only client and opt-in one-shot audit.
- Shopify staging PR #19 independently adds a protected-ledger lookup
  implementation, but has no live credential or deployment.

## Security setup (only after review and tests)
1. Generate one new, unpredictable secret with at least 48 characters using
   an approved password/secret manager. Never send it through chat or commit it.
2. In MyStorefront Supabase Edge Function secrets set
   `REFERRAL_STAGING_BRIDGE_TOKEN` to that secret. The MyStorefront function
   internally reads `SUPABASE_SERVICE_ROLE_KEY`, but never returns or forwards
   that key. `verify_jwt=false` is intentional: the function checks its own
   bearer token before *any* database query.
3. Restrict the edge function to the named HashTopic staging Shopify store.
   Code already pins `mystorefront-test.myshopify.com`, the production
   MyStorefront project and its HashTopic test brand.
4. Only on the staging Render service `hashtopic-postback-shopify-staging`,
   store the same secret in `WEB_PIXEL_STAGING_BRIDGE_TOKEN`. Set:
   - `WEB_PIXEL_STAGING_BRIDGE_ENDPOINT=https://lhzqnkrjqaebcfxcmlgd.supabase.co/functions/v1/staging-referral-proof-verify`
   - `WEB_PIXEL_STAGING_BRIDGE_AUDIT_ENABLED=true`
   - `WEB_PIXEL_STAGING_AUDIT_CLICK_ID` to a *newly server-issued*, genuine
     HashTopic click ID, entered as a secret. Never reuse browser-created clicks.
5. Confirm `SHOPIFY_APP_URL` is exactly
   `https://hashtopic-postback-shopify-staging.onrender.com` and the
   `DATABASE_URL` path is `/mystorefront_postback_staging_db`.
6. Only after both PRs are reviewed and merged into their intended branches,
   and staging is deliberately deployed, execute once from a trusted staging
   shell: `node web/scripts/staging-proof-bridge-audit.mjs` from the repo
   root, or `node scripts/staging-proof-bridge-audit.mjs` from `web/`.
   Do not mount the script as an HTTP route or schedule it.

## Acceptance requirements
- A genuine newly attested click must yield
  `provenance_verified_pending_consent`, `provenance_verified:true`.
- A browser-generated legacy click, mismatched brand/shop/creator/link,
  expired click, missing bearer token and invalid proof must all block.
- Every outcome must have
  `consent_eligible:false`, `can_send_postback:false`, and
  `commission_created:false`.
- Never log raw tokens or click IDs; rotate the token after suspected leakage.
- Do not send commission postbacks, modify affiliate_orders or reconcile orders.

## Subsequent gates before brand rollout
Implement and test independent Shopify order evidence, consent determination,
order-level atomic idempotency, retry behavior, refund reversal and payout
calculation. Validate actual MyStorefront creator/brand dashboards through
controlled end-to-end UAT with nonpayable staging orders.

Release status remains NO-GO until all gates pass.
