/**
 * Staging research: read-only validation of existing MyStorefront affiliate
 * click data, with NO public route, DB writes, order processing or commissions.
 *
 * Verified live schema (2026-11-04):
 * affiliate_clicks(click_id, brand_id, creator_id, link_id, created_at)
 * links(id, user_id, is_deleted)
 * brand_accounts(id, website_url, store_url)
 *
 * A service key must be supplied exclusively by a trusted backend worker.
 * Browser-reported click IDs/shops are never proof of a paid order.
 * Shopify consent status is unavailable in this table: eligibility remains
 * false, regardless of a valid record.
 */
const TEST_SHOP="mystorefront-test.myshopify.com";
const TEST_BRAND="4e1d2474-1750-4f62-a8d8-693903f4154f";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_MS=30*86400000;

function canonicalShopDomain(value){
  if(typeof value!=="string" || !value.trim())return null;
  try {
    const url=new URL(value.includes("://")?value:"https://"+value);
    if(url.protocol!=="https:" || url.username || url.password ||
       url.port || url.search || url.hash ||
       !["","/"].includes(url.pathname))return null;
    return url.hostname.toLowerCase();
  } catch {return null;}
}

export function classifyTrustedReferral({click,link,brand,shop=TEST_SHOP,nowMs=Date.now()}={}){
  const reject=reason=>({status:"blocked",reason,consent_eligible:false,commission_created:false});
  if(shop!==TEST_SHOP||!brand||brand.id!==TEST_BRAND ||
     ![brand.website_url,brand.store_url].some(x=>canonicalShopDomain(x)===shop))
    return reject("brand_shop_mismatch");
  if(!click||!UUID.test(click.click_id||"")||click.brand_id!==TEST_BRAND ||
     !UUID.test(click.creator_id||"")||!UUID.test(click.link_id||""))
    return reject("click_invalid");
  if(!link||link.id!==click.link_id||link.user_id!==click.creator_id ||
     link.is_deleted===true)return reject("link_invalid");
  const at=Date.parse(click.created_at);
  if(!Number.isFinite(nowMs)||!Number.isFinite(at)||at>nowMs+60000||
     nowMs-at>=WINDOW_MS)return reject("outside_referral_window");
  // No user or click data is returned to any caller. Even verified clicks
  // cannot progress to sale attribution without independent consent evidence.
  return {
    status:"click_record_verified_pending_consent",
    // Internal-only timestamp for independent Shopify order-time comparison.
    // Never serialize this evidence into a public Web Pixel response.
    clicked_at:new Date(at).toISOString(),
    consent_eligible:false,
    commission_created:false,
    can_send_postback:false,
  };
}

export function createStagingTrustedReferralLookup({
  supabaseUrl,serviceKey,fetchImpl=fetch,now=()=>Date.now(),
}={}){
  const serviceUrl=(()=>{try{
    const u=new URL(supabaseUrl);
    if(u.protocol!=="https:" ||
       !/^[a-z0-9-]+\.supabase\.co$/.test(u.hostname) ||
       u.username||u.password||u.search||u.hash||u.pathname!=="/")
      throw Error("unsafe");
    return u.origin;
  }catch{throw Error("Invalid Supabase project URL");}})();
  if(typeof serviceKey!=="string"||serviceKey.length<40)
    throw Error("Server credential missing");
  if(typeof fetchImpl!=="function")throw Error("Invalid fetch adapter");
  async function rows(table,fields,filterField,filterValue){
    const url=new URL(serviceUrl+"/rest/v1/"+table);
    url.searchParams.set("select",fields);
    url.searchParams.set(filterField,"eq."+filterValue);
    url.searchParams.set("limit","2");
    const result=await fetchImpl(url.href,{
      method:"GET",
      headers:{
        apikey:serviceKey,Authorization:"Bearer "+serviceKey,
        Accept:"application/json",
      },
      redirect:"error",
      signal:AbortSignal.timeout(8000),
    });
    if(!result?.ok)throw Error("Trusted lookup unavailable");
    const response=await result.json();
    if(!Array.isArray(response)||response.length>2)
      throw Error("Invalid trusted lookup response");
    return response;
  }
  return async function lookup({clickId,shop}={}){
    if(shop!==TEST_SHOP||!UUID.test(clickId||""))
      return {status:"blocked",reason:"invalid_click_query",consent_eligible:false,commission_created:false};
    try {
      const clicks=await rows("affiliate_clicks",
        "click_id,brand_id,creator_id,link_id,created_at","click_id",clickId);
      if(clicks.length!==1||clicks[0].click_id!==clickId)
        return {status:"blocked",reason:"click_not_unique_or_missing",consent_eligible:false,commission_created:false};
      const click=clicks[0];
      if(click.brand_id!==TEST_BRAND||!UUID.test(click.link_id||""))
        return {status:"blocked",reason:"click_invalid",consent_eligible:false,commission_created:false};
      const [links,brands]=await Promise.all([
        rows("links","id,user_id,is_deleted","id",click.link_id),
        rows("brand_accounts","id,website_url,store_url","id",TEST_BRAND),
      ]);
      if(links.length!==1||brands.length!==1)
        return {status:"blocked",reason:"link_or_brand_missing",consent_eligible:false,commission_created:false};
      return classifyTrustedReferral({click,link:links[0],brand:brands[0],shop,nowMs:now()});
    }catch{
      return {status:"blocked",reason:"trusted_lookup_unavailable",consent_eligible:false,commission_created:false};
    }
  };
}

export const STAGING_TEST_SHOP=TEST_SHOP;
