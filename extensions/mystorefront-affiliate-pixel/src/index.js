import { register } from '@shopify/web-pixels-extension';

// Shopify app pixel: runs in Shopify's strict sandbox, not the storefront DOM.
// No cart mutations or hidden form inputs. Do not send customer PII.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOP=/^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$/;
const KEY='mystorefront_pixel_referral_v1';
const MAX_AGE=30*86400000;

function getReferral(href){
  try{
    const url=new URL(href);
    const id=url.searchParams.get('click_id');
    return id && UUID.test(id)?id.toLowerCase():null;
  }catch{return null;}
}
function checkoutToken(value){
  return typeof value==='string' && /^[a-zA-Z0-9_-]{12,128}$/.test(value)?value:null;
}
function orderId(value){
  const raw=String(value||'');
  const match=raw.match(/^(?:gid:\/\/shopify\/Order\/)?([1-9][0-9]{0,19})$/);
  return match?match[1]:null;
}
export function startAffiliatePixel({analytics,browser,settings}){
  const shop=String(settings?.shop||'').toLowerCase();
  const endpoint=String(settings?.endpoint||'');
  // Staging-only until server-side paid-order reconciliation and privacy
  // have been approved. This does NOT award a commission.
  if(shop!=='mystorefront-test.myshopify.com' ||
     !SHOP.test(shop) ||
     endpoint!=='https://hashtopic-postback-shopify-staging.onrender.com/api/staging/affiliate-pixel-candidate') return;

  async function stored(){
    try{
      const raw=await browser.localStorage.getItem(KEY);
      if(!raw)return null;
      const data=JSON.parse(raw);
      if(!UUID.test(data?.click_id) ||
        !Number.isFinite(data?.at) ||
        data.at>Date.now()+60000 ||
        Date.now()-data.at>=MAX_AGE)return null;
      return data;
    }catch{return null;}
  }
  async function capture(event){
    const id=getReferral(event?.context?.document?.location?.href||'');
    if(!id)return;
    try{await browser.localStorage.setItem(KEY,JSON.stringify({click_id:id,at:Date.now()}));}catch{}
  }
  async function checkoutCandidate(event){
    // Shopify checkout.token is stable from checkout_started through
    // checkout_completed and matches order.checkout_token in paid webhooks.
    // It does not depend on a thank-you page rendering successfully.
    const token=checkoutToken(event?.data?.checkout?.token);
    if(!token)return;
    const referral=await stored();
    if(!referral)return;
    const body={
      shop, checkout_token:token, click_id:referral.click_id,
      order_id:orderId(event?.data?.checkout?.order?.id),
      event_id:String(event?.id||'').slice(0,128),
      type:'pixel_candidate',
    };
    try{
      await fetch(endpoint,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),keepalive:true,
      });
    }catch{}
  }
  analytics.subscribe('page_viewed',event=>{void capture(event);});
  analytics.subscribe('checkout_started',event=>{void checkoutCandidate(event);});
  analytics.subscribe('checkout_completed',event=>{void checkoutCandidate(event);});
}
register(startAffiliatePixel);
