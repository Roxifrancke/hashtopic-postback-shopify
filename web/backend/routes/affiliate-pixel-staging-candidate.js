import { Router, json } from 'express';

const SHOP='mystorefront-test.myshopify.com';
const HOST='https://hashtopic-postback-shopify-staging.onrender.com';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER=/^[1-9][0-9]{0,19}$/;
const CANDIDATE_PATH='/api/staging/affiliate-pixel-candidate';

/**
 * Shopify browser event candidates are UNTRUSTED. We record an order ID and
 * click ID for staging correlation only, never commissions or postbacks.
 * Shopify signed paid webhook and Admin API order are separate requirements.
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
 order_id text NOT NULL,
 click_id text NOT NULL,
 event_id text NOT NULL,
 seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shop,order_id)
);
CREATE INDEX IF NOT EXISTS idx_affiliate_pixel_candidates_seen
  ON affiliate_pixel_staging_candidates(seen_at);`;

export function validatePixelCandidate(p){
  return p && typeof p==='object' && !Array.isArray(p) &&
    Object.keys(p).sort().join(',')==='click_id,event_id,order_id,shop,type' &&
    p.type==='pixel_candidate' && p.shop===SHOP &&
    typeof p.click_id==='string' && UUID.test(p.click_id) &&
    typeof p.order_id==='string' && ORDER.test(p.order_id) &&
    typeof p.event_id==='string' && p.event_id.length>=1 &&
    p.event_id.length<=128 && /^[a-zA-Z0-9._:-]+$/.test(p.event_id);
}

export async function acceptStagingPixelCandidate({pool,input}){
  if(!validatePixelCandidate(input))return {status:400,body:{result:'invalid_candidate'}};
  if(!pool || typeof pool.query!=='function')return {status:503,body:{result:'unavailable'}};
  try{
    const result=await pool.query(
      `INSERT INTO affiliate_pixel_staging_candidates(shop,order_id,click_id,event_id)
       VALUES($1,$2,$3,$4) ON CONFLICT(shop,order_id) DO NOTHING
       RETURNING order_id`,
      [SHOP,input.order_id,input.click_id.toLowerCase(),input.event_id]);
    if(result.rowCount===0){
      const prior=await pool.query(
        'SELECT click_id FROM affiliate_pixel_staging_candidates WHERE shop=$1 AND order_id=$2',
        [SHOP,input.order_id]);
      return {status:202,body:{result:prior.rows?.[0]?.click_id===input.click_id.toLowerCase()?
        'duplicate_ignored':'conflicting_candidate_quarantined'}};
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
    // Shopify app pixels may send Origin: null from their strict sandbox.
    // This is a transport allowance, NOT authentication or attribution proof.
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
export { CANDIDATE_PATH };
