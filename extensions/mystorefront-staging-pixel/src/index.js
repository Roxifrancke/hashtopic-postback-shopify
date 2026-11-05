/**
 * STAGING ONLY: connectivity probe plus consented, unverified referral candidate.
 * Candidate is never transmitted, authenticated, or used for attribution.
 */
import { register } from '@shopify/web-pixels-extension';
import { captureStagingCandidate, REFERRAL_STORAGE_KEY, consentAllowsReferral } from './referral-candidate.js';

const STAGING_HOST = 'https://hashtopic-postback-shopify-staging.onrender.com';
const PROBE = STAGING_HOST + '/api/staging/web-pixel-transport-probe/';

register(({ analytics, browser, init, customerPrivacy }) => {
  let probeSent = false;
  let privacy = init?.customerPrivacy;
  let lastPageUrl = init?.context?.document?.location?.href;
  // Serialize asynchronous storage operations so a late page-view write cannot
  // re-create a candidate after a consent withdrawal.
  let pending = Promise.resolve();
  const runCapture = () => {
    const consentSnapshot = privacy;
    const urlSnapshot = lastPageUrl;
    pending = pending.catch(() => {}).then(() => captureStagingCandidate({
      href: urlSnapshot,
      privacy: consentSnapshot,
      storage: browser.localStorage,
      nowMs: Date.now(),
    }));
    return pending;
  };

  customerPrivacy.subscribe('visitorConsentCollected', (event) => {
    privacy = event?.customerPrivacy;
    if (consentAllowsReferral(privacy)) {
      // Some visitors grant consent on the first page without navigating.
      runCapture().catch(() => {});
    } else {
      // Queued after earlier writes to avoid restoring an untrusted candidate.
      pending = pending.catch(() => {}).then(() =>
        browser.localStorage.removeItem(REFERRAL_STORAGE_KEY));
      pending.catch(() => {});
    }
  });

  analytics.subscribe('page_viewed', (event) => {
    // Preserve the proven zero-payload staging transport smoke test.
    if (!probeSent) {
      probeSent = true;
      fetch(PROBE, { method: 'POST', keepalive: true }).catch(() => {});
    }
    lastPageUrl = event?.context?.document?.location?.href;
    runCapture().catch(() => {});
  });
});
