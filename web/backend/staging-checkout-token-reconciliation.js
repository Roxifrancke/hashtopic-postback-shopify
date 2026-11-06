/**
 * Diagnostic reconciliation of a Shopify Web Pixel checkout token with an
 * independently HMAC-verified orders/paid webhook.
 *
 * This does NOT authorize a sale, award commission, or queue a postback.
 * Browser pixel traffic is untrusted, even when both tokens agree. Further
 * click provenance and shopper privacy checks are separate release gates.
 */
const SHOP = 'mystorefront-test.myshopify.com';
const TOKEN = /^[A-Za-z0-9_-]{12,128}$/;
const ORDER = /^[1-9][0-9]{0,19}$/;
const WINDOW = 30 * 86400000;

const result = (status) => ({
  status,
  can_send_postback: false,
  commission_created: false,
});

export async function reconcileStagingCheckoutToken({
  pool, shop, checkoutToken, signedOrderId, nowMs = Date.now(),
} = {}) {
  if (shop !== SHOP || !TOKEN.test(checkoutToken ?? '') ||
      (signedOrderId != null && !ORDER.test(String(signedOrderId))) ||
      !Number.isFinite(nowMs)) return result('invalid_input');
  if (!pool || typeof pool.query !== 'function') return result('database_unavailable');

  let rows;
  try {
    // The paid side is written only by recordStagingSignedCheckoutToken after
    // HMAC verification; the candidate side comes from an UNTRUSTED browser.
    // Never use a pixel-supplied order ID to identify the paid order.
    ({ rows } = await pool.query(
      `SELECT p.order_id AS verified_order_id,
              p.seen_at AS paid_seen_at,
              c.click_id AS untrusted_click_id,
              c.order_id AS untrusted_order_id,
              c.seen_at AS candidate_seen_at
         FROM affiliate_pixel_staging_paid_orders p
         LEFT JOIN affiliate_pixel_staging_candidates c
           ON c.shop = p.shop AND c.checkout_token = p.checkout_token
        WHERE p.shop = $1 AND p.checkout_token = $2
        LIMIT 1`,
      [shop, checkoutToken],
    ));
  } catch {
    return result('database_unavailable');
  }
  const row = rows?.[0];
  if (!row) return result('signed_paid_order_not_recorded');
  if (!ORDER.test(String(row.verified_order_id ?? '')) ||
      (signedOrderId != null && String(row.verified_order_id) !== String(signedOrderId)))
    return result('paid_order_conflict');
  if (!row.untrusted_click_id) return result('pixel_candidate_not_recorded');
  if (row.untrusted_order_id &&
      String(row.untrusted_order_id) !== String(row.verified_order_id))
    return result('candidate_order_conflict');
  const paidAt = Date.parse(row.paid_seen_at);
  const candidateAt = Date.parse(row.candidate_seen_at);
  if (!Number.isFinite(paidAt) || !Number.isFinite(candidateAt) ||
      paidAt > nowMs + 60000 || candidateAt > nowMs + 60000 ||
      nowMs - paidAt >= WINDOW || nowMs - candidateAt >= WINDOW)
    return result('stale_or_invalid_evidence');

  // Deliberately no click ID or checkout token in the return value/logs.
  // A matching pair is NOT proof of genuine attribution or consent.
  return result('checkout_token_correlated_untrusted');
}
