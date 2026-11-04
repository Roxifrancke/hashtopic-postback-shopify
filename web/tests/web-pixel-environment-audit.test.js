import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMyStorefrontSchemaCompatibility,evaluateDedicatedTestBrand,
  READ_ONLY_COMPATIBILITY_SQL,
} from "../backend/web-pixel-environment-audit.js";

const required={
  affiliate_clicks:["click_id","creator_id","brand_id","link_id","created_at"],
  links:["id","user_id","is_deleted"],
  brand_accounts:["id","store_url","website_url"],
  affiliate_orders:["brand_id","order_id","creator_id","click_id"],
};
const rows=Object.entries(required).flatMap(([table_name,columns])=>
  columns.map(column_name=>({table_name,column_name})));

test("current schema is compatible only when all required columns are present",()=>{
  assert.equal(evaluateMyStorefrontSchemaCompatibility(rows).compatible,true);
  const older=rows.filter(x=>!(x.table_name==="brand_accounts" && x.column_name==="store_url"));
  const result=evaluateMyStorefrontSchemaCompatibility(older);
  assert.equal(result.compatible,false);
  assert.ok(result.missing.includes("brand_accounts.store_url"));
  assert.match(READ_ONLY_COMPATIBILITY_SQL,/information_schema\.columns/);
});

test("schema evidence cannot be inferred from missing or malformed data",()=>{
  assert.equal(evaluateMyStorefrontSchemaCompatibility(undefined).compatible,false);
  assert.equal(evaluateMyStorefrontSchemaCompatibility([{table_name:"links"}]).compatible,false);
});

test("staging test brand requires confirmed ownership and exact shop mapping",()=>{
  const complete={
    shop:"mystorefront-test.myshopify.com",stagingEnvironmentConfirmed:true,
    brand:{is_test_brand:true,owner_verified:true,
      shop_domain:"mystorefront-test.myshopify.com"},
  };
  assert.equal(evaluateDedicatedTestBrand(complete).ready,true);
  assert.equal(evaluateDedicatedTestBrand({...complete,stagingEnvironmentConfirmed:false}).ready,false);
  assert.equal(evaluateDedicatedTestBrand({...complete,brand:{...complete.brand,owner_verified:false}}).ready,false);
  assert.equal(evaluateDedicatedTestBrand({...complete,brand:{...complete.brand,shop_domain:"mystorefront-test-2.myshopify.com"}}).ready,false);
});
