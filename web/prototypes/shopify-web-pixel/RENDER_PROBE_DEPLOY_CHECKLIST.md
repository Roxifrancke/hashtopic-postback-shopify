# Render staging Web Pixel transport probe: deployment checklist

**Status:** CI passed; NOT deployed. No referral collection or commission writes.

## Service and branch

- GitHub repo: `Roxifrancke/hashtopic-postback-shopify`.
- Draft branch: `experiment/shopify-web-pixel-attribution-20261104` (PR #9).
- Existing staging URL: `https://hashtopic-postback-shopify-staging.onrender.com`.
- Live URL: `https://mystorefront-postback.onrender.com` (DO NOT MODIFY).

## Render access requirement

The Render account needs to be connected to ChatGPT or an operator must
perform this deployment in Render. Do not switch the existing staging service's
Git branch until you have confirmed its deployed app settings and saved a
rollback deploy. Avoid deploying the research branch into the production
service.

## First stage: zero-data transport handshake

1. Review the PR CI, confirm both workflows pass.
2. Use a separate *staging-only* service or a reviewed temporary deployment
   of the existing staging service, with an immediate rollback available.
3. Ensure it uses the correct Shopify **staging** app and its existing
   non-production service configuration.
4. Set only `WEB_PIXEL_STAGING_TRANSPORT_PROBE_ENABLED=true` on the
   staging service. The implementation additionally checks that
   `SHOPIFY_APP_URL=https://hashtopic-postback-shopify-staging.onrender.com`.
   Do NOT enable `WEB_PIXEL_STAGING_RECEIVER_ENABLED`,
   `WEB_PIXEL_STAGING_PERSISTENCE_ENABLED`, or
   `WEB_PIXEL_STAGING_TRUSTED_CLICK_ENABLED`.
5. Verify `GET /health` is healthy. From a browser sandbox on the HashTopic
   test store, exercise one empty POST to
   `/api/staging/web-pixel-transport-probe` using the research snippet
   `web/prototypes/shopify-web-pixel/transport-probe-extension.js`
   *only after* syncing the known working local Web Pixel extension.
6. In Chrome Developer Tools Network inspect actual `Origin`, OPTIONS
   preflight, status 204, and `Access-Control-Allow-Origin`. A failure may
   mean Shopify's sandbox sends a different origin: do not widen access
   to real event routes based on guesses.
7. Disable the probe flag and restore the local tested pixel implementation.
   Check checkout still functions as before.

## Expected results and limitations

- `reachable:true,status:204` is a **transport** success only.
- No event payload, click ID, checkout ID, customer details or merchant
  credentials are sent.
- `Origin` is not authentication. Never infer merchant identity or a valid
  commission from this result.
- Production delivery remains unchanged and no sale can be attributed by
  the probe.
- A complete attribution test additionally requires: an actual staging
  database migration, privacy checks, verified MyStorefront click lookup,
  independently fetched paid Shopify order, signed webhook verification,
  destination-level idempotency and measured end-to-end test.
