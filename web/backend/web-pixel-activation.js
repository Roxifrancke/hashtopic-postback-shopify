/**
 * Shopify App Pixel activation, staging store only.
 * Run only after Shopify CLI deployed the Web Pixel extension and the
 * merchant accepted read_customer_events/write_pixels/read_pixels scopes.
 */
const TEST_SHOP = 'mystorefront-test.myshopify.com';
const STAGING_HOST = 'https://hashtopic-postback-shopify-staging.onrender.com';
const CANDIDATE_ENDPOINT = STAGING_HOST + '/api/staging/affiliate-pixel-candidate';
const QUERY = 'query { webPixel { id settings } }';
const CREATE = 'mutation($pixel: WebPixelInput!) { webPixelCreate(webPixel: $pixel) { webPixel { id settings } userErrors { code message } } }';

export function stagingPixelActivationEnabled(shop, env=process.env) {
  return shop === TEST_SHOP &&
    env.SHOPIFY_APP_URL === STAGING_HOST &&
    env.WEB_PIXEL_STAGING_ACTIVATION_ENABLED === 'true';
}

export async function ensureStagingAppPixel({
  shop, token, env=process.env, fetchFn=fetch
}={}) {
  if(!stagingPixelActivationEnabled(shop,env)) return {status:'disabled'};
  if(typeof token!=='string'||token.length<10) return {status:'token_unavailable'};
  const call=async(query,variables)=>{
    const response=await fetchFn('https://'+TEST_SHOP+'/admin/api/2026-01/graphql.json',{
      method:'POST',headers:{
        'X-Shopify-Access-Token':token,
        'Content-Type':'application/json',
      },
      body:JSON.stringify({query,variables}),
    });
    if(!response.ok)return {error:'shopify_http_'+response.status};
    const json=await response.json();
    if(json?.errors?.length)return {error:'graphql_error'};
    return json?.data||{error:'graphql_data_unavailable'};
  };
  try{
    const existing=await call(QUERY);
    if(existing.error)return {status:existing.error};
    if(existing.webPixel?.id) return {status:'connected'};
    const result=await call(CREATE,{pixel:{settings:{
      shop:TEST_SHOP, endpoint:CANDIDATE_ENDPOINT,
    }}});
    if(result.error)return {status:result.error};
    if(result.webPixelCreate?.userErrors?.length)
      return {status:'shopify_user_error',codes:result.webPixelCreate.userErrors.map(x=>x.code).filter(Boolean)};
    return result.webPixelCreate?.webPixel?.id?
      {status:'created'}:{status:'shopify_pixel_not_created'};
  }catch{return {status:'shopify_unavailable'};}
}
