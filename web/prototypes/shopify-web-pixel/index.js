/**
 * RESEARCH DRAFT ONLY. Not a generated/registered Shopify extension.
 * To use later, generate a real Shopify web_pixel extension with Shopify CLI,
 * obtaining an authentic Shopify extension UID, then adapt this module.
 * No transmission to any server; no purchase attribution is performed.
 *
 * The strict sandbox cannot mutate cart attributes. Shopify controls whether
 * events are delivered based on the store's customer-privacy configuration.
 */
import { register } from "@shopify/web-pixels-extension";

register(({ analytics, settings }) => {
  // Explicitly no fetch, no browser cookie, no localStorage, no console of PII.
  // Confirm Shopify event shapes and consent behaviour via test store first.
  analytics.subscribe("page_viewed", (event) => {
    const url = event.context?.document?.location?.href;
    const clickId = typeof url === "string" ? new URL(url).searchParams.get("click_id") : null;
    // Placeholder intentionally discards all details. Event forwarding and
    // authenticated ingestion must be reviewed BEFORE enabling any pixel.
    void clickId;
    void settings;
  });
  analytics.subscribe("checkout_completed", (event) => {
    // A checkout-completed event is NOT evidence of a verified/paid order.
    void event;
  });
});
