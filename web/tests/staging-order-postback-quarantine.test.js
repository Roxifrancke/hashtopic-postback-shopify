import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isStagingOrderQuarantineEnabled } from "../backend/staging-order-postback-quarantine.js";

const SHOP = "mystorefront-test.myshopify.com";
const env = {
  WEB_PIXEL_STAGING_ORDER_QUARANTINE: "true",
  SHOPIFY_APP_URL: "https://hashtopic-postback-shopify-staging.onrender.com",
  DATABASE_URL: "postgresql://unit-test:unused@localhost:5432/mystorefront_postback_staging_db",
};

test("quarantine requires all explicit staging boundaries", () => {
  assert.equal(isStagingOrderQuarantineEnabled(SHOP, env), true);
  for (const [shop, options] of [
    ["production.myshopify.com", env],
    [SHOP, { ...env, WEB_PIXEL_STAGING_ORDER_QUARANTINE: "false" }],
    [SHOP, { ...env, WEB_PIXEL_STAGING_ORDER_QUARANTINE: undefined }],
    [SHOP, { ...env, SHOPIFY_APP_URL: "https://mystorefront-postback.onrender.com" }],
    [SHOP, { ...env, SHOPIFY_APP_URL: "https://hashtopic-postback-shopify-staging.onrender.com.evil.example" }],
    [SHOP, { ...env, DATABASE_URL: "postgresql://user:pass@localhost/production" }],
    [SHOP, { ...env, DATABASE_URL: "not-a-url" }],
  ]) assert.equal(isStagingOrderQuarantineEnabled(shop, options), false);
});

test("the legacy paid and refund handlers check quarantine before settings or delivery mutations", () => {
  const source = readFileSync(new URL("../backend/webhooks/index.js", import.meta.url), "utf8");
  const paid = source.slice(source.indexOf("async function processOrder("), source.indexOf("const ordersPaid ="));
  const refund = source.slice(source.indexOf("async function processRefund("), source.indexOf("const refundsCreate ="));
  assert.match(paid, /if \(isStagingOrderQuarantineEnabled\(shop\)\) return;/);
  assert.match(refund, /if \(isStagingOrderQuarantineEnabled\(shop\)\) return;/);
  assert.ok(paid.indexOf("isStagingOrderQuarantineEnabled(shop)") < paid.indexOf("getSettings(shop)"));
  assert.ok(refund.indexOf("isStagingOrderQuarantineEnabled(shop)") < refund.indexOf("getSettings(shop)"));
  assert.ok(paid.indexOf("isStagingOrderQuarantineEnabled(shop)") < paid.indexOf("upsertDelivery("));
  assert.ok(refund.indexOf("isStagingOrderQuarantineEnabled(shop)") < refund.indexOf("upsertDelivery("));
});

test("staging retry worker checks quarantine before claiming queued deliveries", () => {
  const source = readFileSync(new URL("../backend/retry-worker.js", import.meta.url), "utf8");
  const retry = source.slice(source.indexOf("async function retryDelivery("));
  assert.match(retry,/if \(isStagingOrderQuarantineEnabled\(delivery\?\.shop\)\) return;/);
  assert.ok(retry.indexOf("isStagingOrderQuarantineEnabled(delivery?.shop)") <
    retry.indexOf("claimDelivery("));
});
