/**
 * Preflight checking whether a candidate MyStorefront environment actually has
 * the same schema as the staging click adapter.
 *
 * Read-only results. No SQL write, no automatic migration and no changing
 * brand settings. A legacy Lovable project can have affiliate tables but still
 * lack store_url, and must not be silently treated as a verified clone.
 */
const REQUIRED_COLUMNS = Object.freeze({
  affiliate_clicks:["click_id","creator_id","brand_id","link_id","created_at"],
  links:["id","user_id","is_deleted"],
  brand_accounts:["id","store_url","website_url"],
  affiliate_orders:["brand_id","order_id","creator_id","click_id"],
});

export function evaluateMyStorefrontSchemaCompatibility(rows) {
  if(!Array.isArray(rows) || rows.some(x=>!x || typeof x.table_name!=="string" ||
    typeof x.column_name!=="string")) return {
      compatible:false,missing:["invalid_schema_evidence"],
    };
  const found=new Set(rows.map(x=>x.table_name+"."+x.column_name));
  const missing=[];
  for(const [table,columns] of Object.entries(REQUIRED_COLUMNS)){
    for(const column of columns){
      if(!found.has(table+"."+column)) missing.push(table+"."+column);
    }
  }
  return {compatible:missing.length===0,missing};
}

export const READ_ONLY_COMPATIBILITY_SQL = `SELECT table_name,column_name
FROM information_schema.columns
WHERE table_schema='public'
AND table_name IN ('affiliate_clicks','links','brand_accounts','affiliate_orders')
ORDER BY table_name,column_name`;

/** A staging brand must be deliberately owned and matched to the same test
 * shop. A matching unverified URL in a production brand is insufficient.
 */
export function evaluateDedicatedTestBrand({shop,brand,stagingEnvironmentConfirmed=false}) {
  const blocked=reason=>({ready:false,reason});
  if(shop!=="mystorefront-test.myshopify.com")return blocked("unexpected_shop");
  if(stagingEnvironmentConfirmed!==true)return blocked("not_verified_staging_environment");
  if(!brand || brand.is_test_brand!==true || brand.owner_verified!==true)
    return blocked("test_brand_ownership_not_verified");
  const domain=String(brand.shop_domain||"").trim().toLowerCase();
  if(domain!==shop)return blocked("test_brand_shop_mismatch");
  return {ready:true,reason:null};
}
