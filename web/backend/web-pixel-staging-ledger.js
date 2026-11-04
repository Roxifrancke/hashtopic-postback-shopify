/**
 * Staging-only transactional persistence prototype.
 * No migration runner references this module, and no live route invokes it.
 * Do not enable without the privacy and secure ingestion reviews in PR #9.
 *
 * Accepts previously validated, pseudonymized data from the staging server,
 * not raw customer data from the browser. Uses a Postgres Pool injected by
 * the caller, so tests run without a database or live Shopify access.
 */
const TEST_SHOP = "mystorefront-test.myshopify.com";
const HASH_RE = /^[a-f0-9]{64}$/;
const CLICK_RE = /^[A-Za-z0-9_-]{8,128}$/;
const ORDER_RE = /^[1-9][0-9]{0,19}$/;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function withStagingTransaction(pool, work) {
  if (!pool || typeof pool.connect !== "function") throw Error("DB pool required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export function validateLedgerRecord({shop, clientHash, eventHash}) {
  return shop === TEST_SHOP && HASH_RE.test(clientHash || "") &&
    HASH_RE.test(eventHash || "");
}

/**
 * Atomic idempotency + last referral policy. Timestamp limits are checked on
 * the trusted server before this function is invoked. A repeated event NEVER
 * overwrites the original.
 */
export async function persistStagingReferral({
  pool, shop, clientHash, eventHash, clickId, occurredAt, nowMs=Date.now(),
}) {
  if (!validateLedgerRecord({shop,clientHash,eventHash}) ||
      typeof clickId !== "string" || !CLICK_RE.test(clickId) ||
      !Number.isFinite(nowMs)) throw Error("Invalid staging referral");
  const at=Date.parse(occurredAt);
  if (!Number.isFinite(at) || at > nowMs + 60_000 || nowMs-at > MAX_WINDOW_MS)
    throw Error("Invalid referral time");
  return withStagingTransaction(pool, async client=>{
    const {rows:claim} = await client.query(
      `INSERT INTO web_pixel_staging_event_ids (shop,event_hash)
       VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_hash`,
      [shop,eventHash]);
    if (!claim?.length) return {status:"duplicate_ignored",commission_created:false};
    // Transactional row lock avoids stale events overriding a newer referral.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [shop+":"+clientHash]);
    await client.query(
      `INSERT INTO web_pixel_staging_referrals
        (shop,client_hash,click_id,clicked_at,expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (shop,client_hash) DO UPDATE SET
         click_id=EXCLUDED.click_id,
         clicked_at=EXCLUDED.clicked_at,
         expires_at=EXCLUDED.expires_at
       WHERE web_pixel_staging_referrals.clicked_at <= EXCLUDED.clicked_at`,
      [shop,clientHash,clickId,new Date(at),new Date(at+MAX_WINDOW_MS)]);
    return {status:"referral_observed",commission_created:false};
  });
}

/**
 * Browser checkout is not Shopify payment proof. This function only
 * resolves a candidate against server-stored referral observations.
 * Nothing here can generate or send a paid order.
 */
export async function lookupStagingCheckoutCandidate({
  pool,shop,clientHash,eventHash,orderId,occurredAt,nowMs=Date.now(),
}) {
  if (!validateLedgerRecord({shop,clientHash,eventHash}) ||
      typeof orderId !== "string" || !ORDER_RE.test(orderId) ||
      !Number.isFinite(nowMs)) throw Error("Invalid staging checkout");
  const at=Date.parse(occurredAt);
  if (!Number.isFinite(at) || at > nowMs+60_000 || nowMs-at>MAX_WINDOW_MS)
    throw Error("Invalid checkout time");
  return withStagingTransaction(pool, async client=>{
    const {rows:claim}=await client.query(
      `INSERT INTO web_pixel_staging_event_ids (shop,event_hash)
       VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_hash`,
      [shop,eventHash]);
    if(!claim?.length)return {status:"duplicate_ignored",commission_created:false};
    const {rows} = await client.query(
      `SELECT click_id,clicked_at FROM web_pixel_staging_referrals
       WHERE shop=$1 AND client_hash=$2
         AND clicked_at <= $3 AND expires_at > $3
       FOR SHARE`,
      [shop,clientHash,new Date(at)]);
    if(!rows?.length)return {status:"checkout_unmatched",commission_created:false};
    const row=rows[0];
    if(typeof row.click_id!=="string"||!CLICK_RE.test(row.click_id))
      throw Error("Untrusted referral record");
    // This is only a browser-supplied checkout observation. Keep candidates
    // independently per hashed browser so a spoofed order ID cannot prevent
    // an unrelated legitimate candidate from being recorded.
    // No paid order, attribution or creator earning is created here.
    await client.query(
      `INSERT INTO web_pixel_staging_checkout_candidates
       (shop,order_id,client_hash,click_id,observed_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (shop,order_id,client_hash) DO UPDATE SET
         click_id=EXCLUDED.click_id,
         observed_at=EXCLUDED.observed_at
       WHERE web_pixel_staging_checkout_candidates.observed_at < EXCLUDED.observed_at`,
      [shop,orderId,clientHash,row.click_id,new Date(at)]);
    return {status:"candidate_only",shop,order_id:orderId,click_id:row.click_id,
      requires_order_verification:true,commission_created:false};
  });
}

/** 
 * A staging-only review claim, not an affiliate sale.
 * The caller must have verified a Shopify-signed paid webhook, independently
 * fetched the Shopify order, validated click eligibility and found no
 * existing delivery for the same order. Those inputs cannot be fabricated
 * by browser events. Unique shop+order prevents two review claims.
 */
export async function reserveStagingReview({
  pool,shop,orderId,clickId,confirmedTrustedChecks=false,
}) {
  if(shop!==TEST_SHOP || !ORDER_RE.test(orderId || "") ||
      !CLICK_RE.test(clickId || "") || confirmedTrustedChecks !== true)
    throw Error("Trusted staging verification required");
  return withStagingTransaction(pool,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [shop+":"+orderId]);
    const {rows:existing}=await client.query(
      "SELECT EXISTS(SELECT 1 FROM deliveries WHERE shop=$1 AND order_id=$2) AS present",
      [shop,orderId]);
    if(typeof existing?.[0]?.present!=="boolean")throw Error("Legacy lookup unavailable");
    if(existing[0].present)return {status:"blocked_existing_delivery",commission_created:false};
    const {rows}=await client.query(
      `INSERT INTO web_pixel_staging_order_review(shop,order_id,click_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING order_id`,
      [shop,orderId,clickId]);
    return {status:rows?.length?"pending_manual_review":"duplicate_review_ignored",
      commission_created:false};
  });
}
