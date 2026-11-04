import test from "node:test";
import assert from "node:assert/strict";
import { extractClickId, buildRefundPayload } from "../backend/postback-sender.js";
import { mapGraphQLRefundOrder, fetchRefundOrderGraphQL } from "../backend/refund-order-graphql.js";

test("preserves order-level attribution and currency for refund postback", () => {
  const order = mapGraphQLRefundOrder({
    name: "#1005", currencyCode: "ZAR",
    customAttributes: [{key:"MyStorefront click_id", value:"test-click-1"}],
    lineItems:{nodes:[],pageInfo:{hasNextPage:false}},
  }, "123");
  assert.equal(order.id, "123");
  assert.equal(extractClickId(order), "test-click-1");
  const payload = buildRefundPayload("example.myshopify.com",order,{
    id:88,order_id:123,refund_line_items:[]
  },{test_mode:false});
  assert.equal(payload.click_id,"test-click-1");
  assert.equal(payload.currency,"ZAR");
  assert.equal(payload.order_id,"123");
});

test("falls back to line-item attribution", () => {
  const order = mapGraphQLRefundOrder({
    name:"#1006",currencyCode:"ZAR",customAttributes:[],
    lineItems:{nodes:[{customAttributes:[{key:"_MyStorefront click_id",value:"test-click-2"}]}],
      pageInfo:{hasNextPage:false}},
  },456);
  assert.equal(extractClickId(order),"test-click-2");
});

test("refuses incomplete line-item data", () => {
  assert.throws(()=>mapGraphQLRefundOrder({
    lineItems:{nodes:[],pageInfo:{hasNextPage:true}}
  },123),/more than 100/);
});

test("issues read-only order query with numeric GID", async () => {
  const order=await fetchRefundOrderGraphQL("example.myshopify.com",123,async (shop,query,vars)=>{
    assert.match(query,/query MyStorefrontRefundOrder/);
    assert.equal(vars.id,"gid://shopify/Order/123");
    return {order:{name:"#1001",currencyCode:"ZAR",customAttributes:[],lineItems:{nodes:[],pageInfo:{hasNextPage:false}}}};
  });
  assert.equal(order.name,"#1001");
  await assert.rejects(fetchRefundOrderGraphQL("example.myshopify.com","not-an-id",async()=>({})),/Invalid numeric/);
});
