import { Router, json } from 'express';

const SHOP='mystorefront-test.myshopify.com';
const HOST='https://hashtopic-postback-shopify-staging.onrender.com';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN=/^[a-zA-Z0-9_-]{12,128}$/;
const ORDER=/^[1-9][0-9]{0,19}$/;
const CANDIDATE_PATH='/api/staging/affiliate-pixel-candidate';

/**
 * Browser-originated checkout tokens and click IDs are UNTRUSTED candidates.
 * Never use these without a signed Shopify paid webhook and server-issued
 * referral proof. This route cannot create deliveries or commissions.
 */
export function stagingAffiliatePixelCandidateEnabled(env=process.env){
  try{
    return env.SHOPIFY_APP_URL===HOST &&
      new URL(env.DATABASE_URL).pathname==='/mystorefront_postback_staging_db' &&
      env.WEB_PIXEL_STAGING_CANDIDATES_ENABLED==='true';
  }catch{return false;}
}
export const CANDIDATE_SCHEMA=`
CREATE TABLE IF NOT EXISTS affiliate_pixel_staging_candidates(
 shop text NOT NULL CHECK(shop='mystorefront-test.myshopify.com'),
 checkout_token text NOT NULL,
 click_id text NOT NULL,
 order_id text,
 event_id text NOT NULL,
 seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shop,checkout_token)
);
CREATE INDEX IF NOT EXISTS idx_affiliate_pixel_candidates_seen
  ON affiliate_pixel_staging_candidates(seen_at);
CREATE TABLE IF NOT EXISTS affiliate_pixel_staging_paid_orders(
 shop text NOT NULL CHECK(shop='mystorefront-test.myshopify.com'),
 checkout_token text NOT NULL,
 order_id text NOT NULL,
 seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shop,checkout_token),
 UNIQUE(shop,order_id)
);`;

export function validatePixelCandidate(p){
  return Boolean(p && typeof p==='object' && !Array.isArray(p) &&
    Object.keys(p).sort().join(',')==='checkout_token,click_id,event_id,order_id,shop,type' &&
    p.type==='pixel_candidate' && p.shop===SHOP &&
    typeof p.click_id==='string' && UUID.test(p.click_id) &&
    typeof p.checkout_token==='string' && TOKEN.test(p.checkout_token) &&
    (p.order_id===null||(typeof p.order_id==='string' && ORDER.test(p.order_id))) &&
    typeof p.event_id==='string' && p.event_id.length>=1 &&
    p.event_id.length<=128 && /^[a-zA-Z0-9._:-]+$/.test(p.event_id));
}

export async function acceptStagingPixelCandidate({pool,input}){
  if(!validatePixelCandidate(input))return {status:400,body:{result:'invalid_candidate'}};
  if(!pool || typeof pool.query!=='function')return {status:503,body:{result:'unavailable'}};
  try{
    const values=[SHOP,input.checkout_token,input.click_id.toLowerCase(),input.order_id,input.event_id];
    const result=await pool.query(
      `INSERT INTO affiliate_pixel_staging_candidates
       (shop,checkout_token,click_id,order_id,event_id)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(shop,checkout_token) DO NOTHING
       RETURNING checkout_token`,values);
    if(result.rowCount===0){
      const prior=await pool.query(
        'SELECT click_id,order_id FROM affiliate_pixel_staging_candidates WHERE shop=$1 AND checkout_token=$2',
        [SHOP,input.checkout_token]);
      const known=prior.rows?.[0];
      if(known?.click_id!==input.click_id.toLowerCase() ||
        (known?.order_id && input.order_id && known.order_id!==input.order_id))
        return {status:202,body:{result:'conflicting_candidate_quarantined'}};
      if(!known)return {status:503,body:{result:'unavailable'}};
      if(!known.order_id && input.order_id){
        await pool.query(
          'UPDATE affiliate_pixel_staging_candidates SET order_id=$3 WHERE shop=$1 AND checkout_token=$2 AND click_id=$4 AND order_id IS NULL',
          [SHOP,input.checkout_token,input.order_id,input.click_id.toLowerCase()]);
      }
      return {status:202,body:{result:'duplicate_ignored'}};
    }
    return {status:202,body:{result:'unverified_candidate_recorded'}};
  }catch{return {status:503,body:{result:'unavailable'}};}
}

export function createStagingAffiliatePixelCandidateRouter({pool}){
  const router=Router();
  const ready=Promise.resolve().then(()=>pool.query(CANDIDATE_SCHEMA)).then(()=>true).catch(()=>false);
  router.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','Vary':'Origin'});
    const origin=req.get('Origin');
    // Origin:null is a Shopify strict-sandbox transport allowance, not auth.
    if(origin!=='null' && origin!=='https://'+SHOP)return res.sendStatus(403);
    res.set({
      'Access-Control-Allow-Origin':origin,
      'Access-Control-Allow-Methods':'POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type',
    });
    next();
  });
  router.options('/',(_req,res)=>res.status(204).end());
  router.post('/',json({limit:'1kb',strict:true}),async(req,res)=>{
    if(!await ready)return res.status(503).json({result:'unavailable'});
    const result=await acceptStagingPixelCandidate({pool,input:req.body});
    return res.status(result.status).json(result.body);
  });
  return router;
}
export { CANDIDATE_PATH, SHOP as STAGING_PIXEL_SHOP };
