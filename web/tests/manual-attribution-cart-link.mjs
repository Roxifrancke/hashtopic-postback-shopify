// Manual smoke test only. Generates a legacy Shopify cart link for a test variant.
// It never accesses Shopify, creates an order, or handles payments.
// Run from the repository root:
//   node web/tests/manual-attribution-cart-link.mjs example.myshopify.com 123456789
// Open the generated link in a separate logged-in test-store browser session.
// After arriving at the cart, inspect /cart.js and verify attributes/properties.
import { randomUUID } from "node:crypto";
import { buildShopifyAttributionCartLink } from "../backend/attribution-cart-link.js";

const [shop, variantId] = process.argv.slice(2);
if (!shop || !variantId) {
  console.error("Usage: node web/tests/manual-attribution-cart-link.mjs SHOP.myshopify.com NUMERIC_VARIANT_ID");
  process.exit(1);
}
const testId = randomUUID();
try {
  const link = buildShopifyAttributionCartLink({
    shop, variantId, clickId: testId, quantity: 1, toCart: true,
  });
  console.log("Test click ID (synthetic, not a creator):", testId);
  console.log("Cart permalink:", link);
  console.log("TEST ONLY: Opening the link may replace items in your browser cart.");
  console.log("Do not check out or make a purchase.");
  console.log("In the SAME browser tab/session after the cart loads, open /cart.js.");
  console.log("Check cart.attributes['MyStorefront click_id'] equals the test ID,");
  console.log("and items[0].properties['_MyStorefront click_id'] equals the test ID.");
  console.log("If the store requests a password or shows no matching item, report as unverified.");
} catch (error) {
  console.error("Cannot build test link:", error.message);
  process.exitCode = 1;
}
