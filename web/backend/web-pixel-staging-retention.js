/**
 * Staging ledger retention and consent-withdrawal primitives.
 * NEVER connected to production workers. Only staging tables are referenced.
 * These operations don't change affiliate orders or existing deliveries.
 */
const SHOP = "mystorefront-test.myshopify.com";
const HASH = /^[a-f0-9]{64}$/;

export async function cleanExpiredStagingPixelRecords({
  pool,now=new Date(),batchSize=500,
}) {
  if (!pool || typeof pool.connect !== "function" ||
      !(now instanceof Date) || Number.isNaN(now.getTime()) ||
      !Number.isInteger(batchSize) || batchSize<1 || batchSize>1000)
    throw new Error("Invalid staging cleanup parameters");
  const client=await pool.connect();
  try {
    const cutoff=new Date(now.getTime()-30*86400000);
    const reviewCutoff=new Date(now.getTime()-7*86400000);
    const {rowCount:referrals}=await client.query(
      `DELETE FROM web_pixel_staging_referrals WHERE ctid IN (
        SELECT ctid FROM web_pixel_staging_referrals
        WHERE shop=$1 AND expires_at<=$2 LIMIT $3
      )`,[SHOP,now,batchSize]);
    const {rowCount:events}=await client.query(
      `DELETE FROM web_pixel_staging_event_ids WHERE ctid IN (
        SELECT ctid FROM web_pixel_staging_event_ids
        WHERE shop=$1 AND received_at<=$2 LIMIT $3
      )`,[SHOP,cutoff,batchSize]);
    const {rowCount:reviews}=await client.query(
      `DELETE FROM web_pixel_staging_order_review WHERE ctid IN (
        SELECT ctid FROM web_pixel_staging_order_review
        WHERE shop=$1 AND reviewed_at<=$2 LIMIT $3
      )`,[SHOP,reviewCutoff,batchSize]);
    if (![referrals,events,reviews].every(n=>Number.isInteger(n)&&n>=0))
      throw new Error("Staging cleanup result incomplete");
    return {referrals,events,reviews,commission_created:false};
  } finally {
    client.release();
  }
}

/**
 * Support a user's consent withdrawal / deletion request for an individual
 * pseudonymous client identity. No attempt to access non-staging shops.
 * The calling administrator must authenticate and authorize the request.
 */
export async function eraseStagingPixelClient({
  pool,clientHash,shop=SHOP,
}) {
  if (!pool || typeof pool.connect !== "function" ||
      shop!==SHOP || !HASH.test(clientHash || ""))
    throw new Error("Invalid staging erasure");
  const client=await pool.connect();
  try {
    const result=await client.query(
      "DELETE FROM web_pixel_staging_referrals WHERE shop=$1 AND client_hash=$2",
      [SHOP,clientHash]);
    if (!Number.isInteger(result.rowCount))
      throw new Error("Staging erasure result incomplete");
    return {referrals_removed:result.rowCount,commission_created:false};
  } finally {
    client.release();
  }
}
