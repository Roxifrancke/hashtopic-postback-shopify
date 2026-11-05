/**
 * Explicitly opt-in quarantine for paid order/refund postbacks on the
 * MyStorefront Shopify test store only. Does not inspect click IDs or
 * mutate deliveries, MyStorefront orders or commission ledgers.
 *
 * This function is disabled unless all four staging boundaries match.
 * Never infer the environment from the shop domain alone.
 */
const SHOP = 'mystorefront-test.myshopify.com';
const STAGING_HOST = 'https://hashtopic-postback-shopify-staging.onrender.com';
const STAGING_DB = '/mystorefront_postback_staging_db';

export function isStagingOrderQuarantineEnabled(shop, env = process.env) {
  if (shop !== SHOP || env.WEB_PIXEL_STAGING_ORDER_QUARANTINE !== 'true' ||
      env.SHOPIFY_APP_URL !== STAGING_HOST) return false;
  try {
    const database = new URL(env.DATABASE_URL);
    return database.protocol === 'postgres:' || database.protocol === 'postgresql:'
      ? database.pathname === STAGING_DB : false;
  } catch { return false; }
}
