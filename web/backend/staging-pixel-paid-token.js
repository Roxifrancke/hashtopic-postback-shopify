import { stagingAffiliatePixelCandidateEnabled, STAGING_PIXEL_SHOP } from './routes/affiliate-pixel-staging-candidate.js';
import { isStagingOrderQuarantineEnabled } from './staging-order-postback-quarantine.js';

const TOKEN=/^[a-zA-Z0-9_-]{12,128}$/;
const ORDER=/^[1-9][0-9]{0,19}$/;

/**
 * Called ONLY from the Shopify HMAC-verified orders/paid branch.
 * Store a minimal signed-order checkout token as the independent join key.
 * This does not mark a pixel candidate as valid, send a postback, or create
 * creator commissions. Browser requests cannot call this helper.
 */
export async function recordStagingSignedCheckoutToken({
  shop,rawBody,pool,env=process.env,
}={}){
  if(!stagingAffiliatePixelCandidateEnabled(env) ||
     !isStagingOrderQuarantineEnabled(shop,env) ||
     shop!==STAGING_PIXEL_SHOP)return {status:'disabled'};
  let order;
  try{order=JSON.parse(rawBody);}catch{return {status:'invalid_order'};}
  const id=String(order?.id??'');
  const token=order?.checkout_token;
  if(!ORDER.test(id)||typeof token!=='string'||!TOKEN.test(token) ||
     order?.financial_status!=='paid'||order?.cancelled_at)
    return {status:'invalid_order'};
  try{
    const result=await pool.query(
      `INSERT INTO affiliate_pixel_staging_paid_orders
       (shop,checkout_token,order_id) VALUES($1,$2,$3)
       ON CONFLICT(shop,checkout_token) DO NOTHING`,
      [shop,token,id]);
    if(result.rowCount===0){
      const prior=await pool.query(
        'SELECT order_id FROM affiliate_pixel_staging_paid_orders WHERE shop=$1 AND checkout_token=$2',
        [shop,token]);
      return {status:prior.rows?.[0]?.order_id===id?'duplicate':'conflict'};
    }
    return {status:'recorded'};
  }catch{return {status:'unavailable'};}
}
