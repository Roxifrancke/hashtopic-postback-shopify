/**
 * Read-only staging activation preflight. Never writes merchant data, stores
 * referral events, enables a pixel, or creates a commission.
 * Any missing proof is a blocker, not an inferred success.
 */
import { shopMatchesBrand } from "./web-pixel-mystorefront-adapter.js";

const TEST_SHOP = "mystorefront-test.myshopify.com";
const STAGING_URL = "https://hashtopic-postback-shopify-staging.onrender.com";

export function evaluatePixelStagingReadiness({
  shop = TEST_SHOP,
  brand = null,
  shopifyPixelActivated = false,
  extensionPurposesVerified = false,
  consentBehaviorVerified = false,
  testDatabaseMigrated = false,
  retentionJobVerified = false,
  pixelDeliveryTested = false,
  trustedClickAdapterTested = false,
  signedPaidWebhookTested = false,
  duplicateOrderPathTested = false,
  destinationIdempotencyTested = false,
} = {}) {
  const checks = {
    test_shop_isolated: shop === TEST_SHOP,
    brand_shop_matches: shopMatchesBrand(shop, brand),
    pixel_activated_on_test_shop: shopifyPixelActivated === true,
    extension_purposes_verified: extensionPurposesVerified === true,
    consent_behavior_verified: consentBehaviorVerified === true,
    test_database_migrated: testDatabaseMigrated === true,
    retention_job_verified: retentionJobVerified === true,
    pixel_delivery_tested: pixelDeliveryTested === true,
    trusted_click_adapter_tested: trustedClickAdapterTested === true,
    paid_webhook_verified: signedPaidWebhookTested === true,
    duplicate_order_path_tested: duplicateOrderPathTested === true,
    destination_idempotency_tested: destinationIdempotencyTested === true,
  };
  return {
    ready: Object.values(checks).every(Boolean),
    checks,
    blockers: Object.entries(checks).filter(([,passed])=>!passed).map(([name])=>name),
    staging_service: STAGING_URL,
    production_enabled: false,
    commissions_enabled: false,
  };
}
