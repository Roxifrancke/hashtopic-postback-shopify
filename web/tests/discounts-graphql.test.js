import test from "node:test";
import assert from "node:assert/strict";
import { numericShopifyId, normalizeDiscountNode, listDiscountsGraphQL } from "../backend/discounts-graphql.js";

test("strictly parses Shopify IDs", () => {
  assert.equal(numericShopifyId("gid://shopify/DiscountCodeNode/123", "DiscountCodeNode"), "123");
  assert.equal(numericShopifyId("gid://shopify/DiscountRedeemCode/99", "DiscountCodeNode"), null);
});

test("normalises a percentage basic discount", () => {
  const rows = normalizeDiscountNode({
    id: "gid://shopify/DiscountCodeNode/123",
    codeDiscount: {
      __typename: "DiscountCodeBasic", status:"ACTIVE",endsAt:null,
      usageLimit:10, asyncUsageCount:2,
      customerGets: {value:{percentage:0.15}},
      minimumRequirement:{greaterThanOrEqualToSubtotal:{amount:"50.00"}},
      codes:{pageInfo:{hasNextPage:false},nodes:[{id:"gid://shopify/DiscountRedeemCode/99",code:"hello15",asyncUsageCount:2}]}
    }
  });
  assert.equal(rows[0].discount_value,15);
  assert.equal(rows[0].minimum_order_value,50);
  assert.equal(rows[0].code,"HELLO15");
  assert.equal(rows[0].id,"99");
});

test("does not misclassify non-basic discount types", () => {
  const rows=normalizeDiscountNode({
    id:"gid://shopify/DiscountCodeNode/22",
    codeDiscount:{__typename:"DiscountCodeBxgy",status:"ACTIVE",codes:{
      pageInfo:{hasNextPage:false},nodes:[{id:"gid://shopify/DiscountRedeemCode/77",code:"BOGO"}]
    }}
  });
  assert.equal(rows[0].supported_for_write,false);
  assert.equal(rows[0].discount_type,null);
});

test("paginates discount nodes and rejects incomplete redeem-code pages", async () => {
  let calls=0;
  const rows=await listDiscountsGraphQL("test.myshopify.com",async(_shop,_query,vars)=>{
    calls++;
    return {codeDiscountNodes:{
      nodes:[],pageInfo: calls===1?{hasNextPage:true,endCursor:"next"}:{hasNextPage:false,endCursor:null}
    }};
  });
  assert.equal(calls,2);
  assert.deepEqual(rows,[]);
  assert.throws(()=>normalizeDiscountNode({id:"gid://shopify/DiscountCodeNode/1",
    codeDiscount:{__typename:"DiscountCodeBasic",codes:{pageInfo:{hasNextPage:true},nodes:[]}}
  }),/pagination required/);
});
