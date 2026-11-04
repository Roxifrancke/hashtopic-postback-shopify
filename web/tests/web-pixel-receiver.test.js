import test from "node:test";
import assert from "node:assert/strict";
import { makeSyntheticReceiver, createLoopbackServer } from "../prototypes/shopify-web-pixel/staging-receiver.mjs";

const now = Date.parse("2026-11-04T16:00:00Z");
const shop = "mystorefront-test.myshopify.com";
const event = (name, n, client = "synthetic-client-abc") => ({
  id: `synthetic-event-${name}-${n}`,
  clientId: client,
  name,
  timestamp: name === "page_viewed" ? "2026-11-04T15:40:00Z" : "2026-11-04T15:50:00Z",
  ...(name === "page_viewed" ? {
    context: { document: { location: { href: `https://example.test/products/test?click_id=test_referral_${n}12345` } } },
  } : { data: { checkout: { order: { id: "gid://shopify/Order/98765" } } } }),
});

test("synthetic referral and checkout create candidate but never commission", () => {
  const receiver = makeSyntheticReceiver({ now: () => now });
  assert.equal(receiver.observe(event("page_viewed","1")).body.status, "synthetic_referral_observed");
  const out = receiver.observe(event("checkout_completed","1"));
  assert.equal(out.status,202);
  assert.equal(out.body.status,"candidate_only");
  assert.equal(out.body.verified_paid_order,false);
  assert.equal(out.body.commission_created,false);
  assert.equal(out.body.click_id,"test_referral_112345");
  assert.equal(JSON.stringify(out).includes("synthetic-client"),false);
});

test("duplicate event ignored and unrelated browser not attributed", () => {
  const receiver = makeSyntheticReceiver({ now: () => now });
  const a = event("page_viewed","1");
  assert.equal(receiver.observe(a).status,202);
  assert.equal(receiver.observe(a).body.status,"duplicate_ignored");
  const out = receiver.observe(event("checkout_completed","2","synthetic-client-other"));
  assert.equal(out.body.status,"checkout_without_match");
});

test("rejects real-looking visitors and real domains", () => {
  const receiver = makeSyntheticReceiver({ now: () => now });
  assert.equal(receiver.observe({ ...event("page_viewed","1"), clientId:"actual-browser-345" }).status,400);
  assert.equal(receiver.observe({ ...event("page_viewed","1"), context: { document: { location:{href:"https://realbrand.com/?click_id=test_referral_112345"}}}}).status,400);
  assert.equal(receiver.observe({ ...event("checkout_completed","1"), data: {checkout: {order:{id:"1", email:"private@example.com"}}}}).status,400);
});

test("HTTP endpoint accepts only test store and synthetic observations", async (t) => {
  const server = createLoopbackServer(makeSyntheticReceiver({now:()=>now}));
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/observations`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ shop, event:event("page_viewed","7") }),
  });
  assert.equal(response.status,202);
  assert.equal((await response.json()).status,"synthetic_referral_observed");
  const rejected = await fetch(`http://127.0.0.1:${port}/observations`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({shop:"orphan-street-clothing-shop.myshopify.com",event:event("page_viewed","8")}),
  });
  assert.equal(rejected.status,400);
});
