import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const handler = readFileSync(
  new URL("../backend/webhooks/index.js", import.meta.url),
  "utf8"
);

const server = readFileSync(
  new URL("../backend/index.js", import.meta.url),
  "utf8"
);

test("refund lookup uses the Shopify token-refresh helper", () => {
  assert.match(handler, /getValidAccessToken\(shopify,\s*shop\)/);
});

test("Shopify client is passed through the refund handler", () => {
  assert.match(handler, /processRefund\(shop,\s*refund,\s*shopify\)/);
  assert.match(handler, /fetchOrder\(shop,\s*refund\.order_id,\s*shopify\)/);
});

test("failed parent-order lookups propagate an error", () => {
  assert.match(handler, /if\s*\(!order\)\s*throw new Error/);
  assert.match(handler, /catch\s*\(err\)\s*\{[\s\S]*?Error in refunds\/create handler:[\s\S]*?throw err;/);
});

test("webhook route returns HTTP 500 on propagated errors", () => {
  assert.match(server, /webhookHandlers\.refundsCreate\(topic,\s*shop,\s*req\.body,\s*undefined,\s*shopify\)/);
  assert.match(server, /Webhook route error:[\s\S]*?res\.status\(500\)/);
});

test("token exchange does not log token response contents", () => {
  assert.doesNotMatch(server, /JSON\.stringify\(safeLog\)/);
  assert.doesNotMatch(server, /token-exchange raw response/);
});
