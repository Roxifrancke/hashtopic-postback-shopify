/**
 * Shopify Web Pixel privacy gate. App Pixel must declare the applicable
 * purposes in shopify.extension.toml. The platform additionally controls
 * when registered callbacks can execute, including consent replay.
 *
 * This is a browser-side collection gate, NOT independently authenticated
 * server evidence of consent. No browser-supplied boolean can be trusted
 * to override server consent policy or to authorize commissions.
 *
 * Current staging extension requires analytics=true, marketing=true;
 * both permissions must be explicitly reported as allowed before collecting.
 * Missing, unknown or false means no MyStorefront observation is recorded.
 */
export function canRecordPixelObservation(privacy) {
  return !!privacy &&
    privacy.analyticsProcessingAllowed === true &&
    privacy.marketingAllowed === true;
}

/**
 * Pixel-scoped state following the Shopify Standard API contract.
 * init.customerPrivacy is the initial snapshot. Shopify emits the
 * visitorConsentCollected event on subsequent changes. No DOM usage.
 */
export function observeShopifyPixelPrivacy(api) {
  if (!api || typeof api.customerPrivacy?.subscribe !== "function")
    throw new Error("Shopify pixel privacy API unavailable");
  let current = api.init?.customerPrivacy || null;
  api.customerPrivacy.subscribe("visitorConsentCollected", event => {
    current=event?.customerPrivacy || null;
  });
  return {
    allowed() { return canRecordPixelObservation(current); },
    snapshot() { return current ? {
      analyticsProcessingAllowed:current.analyticsProcessingAllowed === true,
      marketingAllowed:current.marketingAllowed === true,
    } : null; },
  };
}
