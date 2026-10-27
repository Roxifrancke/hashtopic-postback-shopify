import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("refund handler propagates processing failures", async () => {
  const source = readFileSync(
    new URL("../backend/webhooks/index.js", import.meta.url),
    "utf8"
  );

  const start = source.indexOf("const refundsCreate = async");
  const end = source.indexOf("export default", start);

  assert.ok(start >= 0 && end > start, "Refund handler not found");

  const context = {
    JSON,
    console: { error() {} },
    processRefund: async () => {
      throw new Error("Simulated Shopify HTTP 401");
    },
  };

  vm.runInNewContext(
    source.slice(start, end) +
      "\n globalThis.testRefundsCreate = refundsCreate;",
    context
  );

  await assert.rejects(
    context.testRefundsCreate(
      "refunds/create",
      "mystorefront-test.myshopify.com",
      JSON.stringify({
        id: 123,
        order_id: 7254761930817,
      }),
      "test-webhook",
      {}
    ),
    /Simulated Shopify HTTP 401/
  );
});
