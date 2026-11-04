/**
 * Read-only MyStorefront referral lookup based on the generated Supabase
 * schema in Roxifrancke/mystorefrontmvp-a1a72025
 * src/integrations/supabase/types.ts (4 November 2026).
 *
 * Data model verified read-only against the live MyStorefront Lovable project:
 * affiliate_clicks(click_id, creator_id, brand_id, link_id, created_at),
 * links(id, user_id, is_deleted), brand_accounts(id, store_url, website_url).
 * HashTopic's brand website and Shopify staging sync were verified on
 * 4 November 2026 as mystorefront-test.myshopify.com. Reject any future
 * mismatch; a verified discount sync does not prove Web Pixel attribution.
 *
 * REQUIREMENTS:
 * - Use a SECRET server-only service credential, NEVER in a Web Pixel.
 * - Explicitly map HashTopic's Shopify test shop to the actual test brand UUID.
 * - Never trust brand IDs, creator IDs, shop domains or timestamps from a
 *   browser event.
 * - Disabled until production/staging Supabase project identity and privacy
 *   purpose have been independently confirmed.
 * - This module does NOT issue postbacks, commissions or Shopify payments.
 */
const SHOP="mystorefront-test.myshopify.com";
const CLICK_RE=/^[A-Za-z0-9_-]{8,128}$/;
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function shopMatchesBrand(shop, brand) {
  if (shop!==SHOP || !brand || typeof brand!=="object")return false;
  const canonical=(value)=>{
    if(typeof value!=="string" || !value.trim())return null;
    try {
      const input=value.trim();
      const url=new URL(input.includes("://")?input:"https://"+input);
      if(url.protocol!=="https:" || url.username || url.password ||
         url.search || url.hash || (url.pathname!=="/" && url.pathname!==""))
        return null;
      return url.hostname.toLowerCase();
    } catch {return null;}
  };
  // A matching configured Shopify domain is required. Other brand websites
  // must never be accepted as sufficient proof of store ownership.
  return [brand.store_url,brand.website_url].some(x=>canonical(x)===shop);
}

function validSupabaseUrl(raw) {
  if(typeof raw!=="string")throw Error("Supabase URL missing");
  const url=new URL(raw);
  if(url.protocol!=="https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
     url.username || url.password || url.search || url.hash || url.pathname!=="/")
    throw Error("Only an HTTPS Supabase project root is supported");
  return url.origin;
}

export function trustedClickAdapterConfigured(env=process.env) {
  try {
    validSupabaseUrl(env.WEB_PIXEL_STAGING_SUPABASE_URL);
    return env.WEB_PIXEL_STAGING_TRUSTED_CLICK_ENABLED==="true" &&
      env.WEB_PIXEL_STAGING_RECEIVER_ENABLED==="true" &&
      env.WEB_PIXEL_STAGING_PERSISTENCE_ENABLED==="true" &&
      env.SHOPIFY_APP_URL==="https://hashtopic-postback-shopify-staging.onrender.com" &&
      UUID_RE.test(env.WEB_PIXEL_STAGING_BRAND_ID || "") &&
      typeof env.WEB_PIXEL_STAGING_SUPABASE_SERVICE_KEY==="string" &&
      env.WEB_PIXEL_STAGING_SUPABASE_SERVICE_KEY.length>=40;
  } catch { return false; }
}

export function createTrustedClickLookup({
  supabaseUrl,serviceKey,brandId,fetchImpl=fetch,
}) {
  const origin=validSupabaseUrl(supabaseUrl);
  if(typeof serviceKey!=="string"||serviceKey.length<40||
     !UUID_RE.test(brandId||""))
    throw Error("Incomplete trusted click configuration");
  async function readRows(table,params) {
    const u=new URL(origin+"/rest/v1/"+table);
    for(const [key,value] of Object.entries(params))u.searchParams.set(key,value);
    const res=await fetchImpl(u.href,{
      method:"GET",
      headers:{"apikey":serviceKey,"Authorization":"Bearer "+serviceKey,
        "Accept":"application/json"},
      redirect:"error",
      signal:AbortSignal.timeout(8000),
    });
    if(!res.ok)throw Error("Trusted MyStorefront lookup unavailable");
    const rows=await res.json();
    if(!Array.isArray(rows)||rows.length>2)throw Error("Invalid trusted lookup result");
    return rows;
  }

  return async function lookupTrustedClick({shop,clickId}) {
    if(shop!==SHOP || typeof clickId!=="string" || !CLICK_RE.test(clickId))
      throw Error("Invalid staging click query");
    const clicks=await readRows("affiliate_clicks",{
      select:"click_id,creator_id,brand_id,link_id,created_at",
      click_id:"eq."+clickId,
      limit:"2",
    });
    if(clicks.length!==1)return null;
    const click=clicks[0];
    if(click.click_id!==clickId || click.brand_id!==brandId ||
       !UUID_RE.test(click.creator_id||"") ||
       !UUID_RE.test(click.link_id||"") ||
       typeof click.created_at!=="string")
      return null;
    // Ensure a live link truly belongs to the creator. The click and link
    // tables may be stale or inconsistent if this is skipped.
    const links=await readRows("links",{
      select:"id,user_id,is_deleted",id:"eq."+click.link_id,limit:"2",
    });
    if(links.length!==1 || links[0].id!==click.link_id ||
       links[0].user_id!==click.creator_id || links[0].is_deleted===true)
      return null;
    const brands=await readRows("brand_accounts",{
      select:"id,store_url,website_url",id:"eq."+brandId,limit:"2",
    });
    if(brands.length!==1 || brands[0].id!==brandId ||
       !shopMatchesBrand(shop,brands[0]))return null;

    // NO consent status is present in this source schema. Do not pretend
    // Shopify's Customer Privacy consent can be derived from affiliate_clicks.
    // Fail CLOSED until a separately verified consent-proof adapter exists.
    return {
      source:"trusted_mystorefront_server",
      click_id:click.click_id, creator_id:click.creator_id,
      brand_id:click.brand_id,shop, clicked_at:click.created_at,
      valid:true,consent_eligible:false,
    };
  };
}
