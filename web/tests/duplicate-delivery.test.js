import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../backend/db.js", import.meta.url),
  "utf8"
);

const start = source.indexOf(
  "export async function claimDelivery("
);
const end = source.indexOf(
  "\n// Store the exact postback payload",
  start
);

assert.ok(start >= 0 && end > start, "claimDelivery must exist");

const functionSource = source
  .slice(start, end)
  .replace("export async function", "async function");

function makeHarness(initialStatus = "pending") {
  const delivery = {
    id: 123,
    status: initialStatus,
    attempts: 0,
  };

  const pool = {
    async query(sql, params) {
      assert.match(sql, /UPDATE deliveries/);
      assert.match(sql, /status = 'processing'/);
      assert.match(sql, /RETURNING \*/);

      if (
        delivery.id !== params[0] ||
        delivery.attempts >= params[1] ||
        !["pending", "pending_retry"].includes(delivery.status)
      ) {
        return { rows: [] };
      }

      delivery.status = "processing";
      return { rows: [{ ...delivery }] };
    },
  };

  const claimDelivery = new Function(
    "pool",
    "ensureReady",
    `${functionSource}; return claimDelivery;`
  )(pool, async () => {});

  return { claimDelivery, delivery };
}

test("simultaneous duplicate refund: only one claim succeeds", async () => {
  const { claimDelivery } = makeHarness();

  const results = await Promise.all([
    claimDelivery(123),
    claimDelivery(123),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
});

test("already processed refund cannot be claimed again", async () => {
  const { claimDelivery } = makeHarness("sent");

  assert.equal(await claimDelivery(123), null);
});

test("pending retry can be claimed once", async () => {
  const { claimDelivery } = makeHarness("pending_retry");

  const first = await claimDelivery(123);
  const second = await claimDelivery(123);

  assert.ok(first);
  assert.equal(second, null);
});
