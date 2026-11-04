/**
 * TEMPORARY Shopify Web Pixel staging test, for the development store ONLY.
 *
 * To use: save a separate backup of the known-working extension first,
 * temporarily paste this into your local Web Pixel extension source,
 * run Shopify staging dev, then refresh the test storefront.
 *
 * This intentionally sends NO actual click ID, Shopify clientId, browser ID,
 * URL, address, checkout data or customer information. These are freshly
 * generated, obviously synthetic identifiers only.
 *
 * Restore the original extension immediately after testing.
 * No commission or actual affiliate sale can be created by this sender.
 */
import { register } from "@shopify/web-pixels-extension";

const ENDPOINT="https://hashtopic-postback-shopify-staging.onrender.com/api/staging/web-pixel-synthetic-referral";

register(({ analytics }) => {
  let sent = false;
  analytics.subscribe("page_viewed", async () => {
    if (sent) return;
    sent = true;
    const nonce = String(Date.now()) + "_" + Math.random().toString(36).slice(2, 12);
    const payload = {
      type: "synthetic_referral",
      test_only: true,
      shop: "mystorefront-test.myshopify.com",
      event_id: "test_event_" + nonce,
      client_id: "test_client_" + nonce,
      click_id: "test_referral_" + nonce,
      observed_at: new Date().toISOString(),
    };
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      console.log("[MyStorefront Synthetic Staging]", {
        status: response.status,
        recorded: response.status === 202 &&
          result.result === "synthetic_referral_recorded",
        commissionCreated: result.commission_created,
      });
    } catch (error) {
      console.log("[MyStorefront Synthetic Staging]", {
        recorded: false,
        error: String(error),
      });
    }
  });
});
