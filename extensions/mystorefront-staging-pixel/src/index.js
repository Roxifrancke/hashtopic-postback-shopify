/** 
 * STAGING-ONLY, zero-payload Shopify App Web Pixel transport smoke test.
 * Copy into the Shopify CLI-generated web_pixel extension's src/index.js.
 * This does NOT capture affiliate links, attribute orders, or award commissions.
 * The Shopify CLI must create the extension and its managed uid.
 */
import { register } from '@shopify/web-pixels-extension';

const STAGING_HOST = 'https://hashtopic-postback-shopify-staging.onrender.com';
const PROBE = STAGING_HOST + '/api/staging/web-pixel-transport-probe/';

register(({ analytics }) => {
  let sent = false;
  analytics.subscribe('page_viewed', () => {
    if (sent) return;
    sent = true;
    // No body, no identifiers, no customer information.
    // This only validates that Shopify loaded the extension and
    // its strict sandbox can reach the staging probe.
    fetch(PROBE, { method: 'POST', keepalive: true }).catch(() => {});
  });
});
