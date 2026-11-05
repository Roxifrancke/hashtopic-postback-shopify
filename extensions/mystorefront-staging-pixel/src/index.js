/**
 * STAGING ONLY: connectivity probe plus consented, unverified referral candidate.
 * The candidate stays in browser storage and is NEVER sent to a postback,
 * authenticated or used to attribute an order. Production is unaffected.
 */
import { register } from '@shopify/web-pixels-extension';
import { captureStagingCandidate, REFERRAL_STORAGE_KEY, consentAllowsReferral } from './referral-candidate.js';

const STAGING_HOST = 'https://hashtopic-postback-shopify-staging.onrender.com';
const PROBE = STAGING_HOST + '/api/staging/web-pixel-transport-probe/';

register(({ analytics, browser, init, customerPrivacy }) => {
  let probeSent = false;
  let privacy = init?.customerPrivacy;

  // On consent withdrawal, erase any earlier unverified candidate.
  customerPrivacy.subscribe('visitorConsentCollected', (event) => {
    privacy = event?.customerPrivacy;
    if (!consentAllowsReferral(privacy)) {
      browser.localStorage.removeItem(REFERRAL_STORAGE_KEY).catch(() => {});
    }
  });

  analytics.subscribe('page_viewed', (event) => {
    // Keep the proven, body-free transport smoke test unchanged.
    if (!probeSent) {
      probeSent = true;
      fetch(PROBE, { method: 'POST', keepalive: true }).catch(() => {});
    }

    // Shopify strict-sandbox event context, not window.location.
    // This stores only an UNVERIFIED candidate after affirmative consent.
    captureStagingCandidate({
      href: event?.context?.document?.location?.href,
      privacy,
      storage: browser.localStorage,
      nowMs: Date.now(),
    }).catch(() => {});
  });
});
