/**
 * STAGING ONLY: browser-side referral candidate, not proof of attribution.
 * Never transmit this value, issue a commission, or call a postback from here.
 */
export const STAGING_SHOP = 'mystorefront-test.myshopify.com';
export const REFERRAL_STORAGE_KEY = 'mystorefront_staging_unverified_click_v1';
export const REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readStagingClickId(href) {
  if (typeof href !== 'string' || href.length > 8192) return null;
  try {
    const page = new URL(href);
    if (page.protocol !== 'https:' || page.hostname !== STAGING_SHOP ||
        page.username || page.password || page.port) return null;
    const values = page.searchParams.getAll('click_id');
    return values.length === 1 && UUID.test(values[0]) ? values[0].toLowerCase() : null;
  } catch { return null; }
}

export function consentAllowsReferral(status) {
  return status?.marketingAllowed === true &&
    status?.analyticsProcessingAllowed === true;
}

export function createCandidate(clickId, atMs) {
  if (!UUID.test(clickId || '') || !Number.isFinite(atMs) || atMs <= 0) return null;
  return JSON.stringify({ click_id: clickId.toLowerCase(), observed_at: atMs,
    expires_at: atMs + REFERRAL_TTL_MS, trusted: false });
}

export function isCurrentCandidate(raw, nowMs) {
  try {
    const candidate = JSON.parse(raw);
    return candidate?.trusted === false &&
      typeof candidate.click_id === 'string' && UUID.test(candidate.click_id) &&
      Number.isFinite(candidate.observed_at) && Number.isFinite(candidate.expires_at) &&
      candidate.expires_at === candidate.observed_at + REFERRAL_TTL_MS &&
      Number.isFinite(nowMs) && nowMs >= candidate.observed_at &&
      nowMs < candidate.expires_at;
  } catch { return false; }
}

export async function captureStagingCandidate({ href, privacy, storage, nowMs }) {
  if (!storage || typeof storage.getItem !== 'function' ||
      typeof storage.setItem !== 'function' ||
      typeof storage.removeItem !== 'function') return 'unavailable';
  if (!consentAllowsReferral(privacy)) {
    await storage.removeItem(REFERRAL_STORAGE_KEY);
    return 'consent_denied';
  }
  const clickId = readStagingClickId(href);
  if (clickId) {
    const candidate = createCandidate(clickId, nowMs);
    if (!candidate) return 'invalid_time';
    await storage.setItem(REFERRAL_STORAGE_KEY, candidate);
    // Verify storage in the strict pixel sandbox without transmitting click IDs.
    const readBack = await storage.getItem(REFERRAL_STORAGE_KEY);
    return readBack === candidate && isCurrentCandidate(readBack, nowMs)
      ? 'stored_verified_local' : 'storage_readback_failed';
  }
  const raw = await storage.getItem(REFERRAL_STORAGE_KEY);
  if (raw && !isCurrentCandidate(raw, nowMs)) {
    await storage.removeItem(REFERRAL_STORAGE_KEY);
    return 'expired_or_invalid';
  }
  return 'no_referral';
}
