import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const source = readFileSync(new URL('../../extensions/mystorefront-staging-pixel/src/referral-candidate.js', import.meta.url), 'utf8');
const { readStagingClickId, consentAllowsReferral, captureStagingCandidate, inspectStagingCheckoutCandidate,
  REFERRAL_STORAGE_KEY, REFERRAL_TTL_MS } =
  await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const click = 'c84cc8f8-787a-40f2-8b3c-3e79e51e3001';
const privacy = { marketingAllowed: true, analyticsProcessingAllowed: true };
const now = Date.parse('2026-11-05T18:00:00Z');

function storage() {
  const data = new Map();
  return {
    data,
    async getItem(key) { return data.get(key) ?? null; },
    async setItem(key, value) { data.set(key, value); },
    async removeItem(key) { data.delete(key); },
  };
}

test('accept only a single UUID click_id on the exact HTTPS staging host', () => {
  assert.equal(readStagingClickId('https://mystorefront-test.myshopify.com/products/a?click_id=' + click), click);
  for (const url of [
    'https://different.myshopify.com/?click_id=' + click,
    'http://mystorefront-test.myshopify.com/?click_id=' + click,
    'https://mystorefront-test.myshopify.com.evil.test/?click_id=' + click,
    'https://mystorefront-test.myshopify.com/?click_id=' + click + '&click_id=' + click,
    'https://mystorefront-test.myshopify.com/?click_id=not-a-uuid',
    'https://mystorefront-test.myshopify.com:444/?click_id=' + click,
  ]) assert.equal(readStagingClickId(url), null, url);
});

test('fail closed when either relevant privacy permission is absent', () => {
  assert.equal(consentAllowsReferral(privacy), true);
  assert.equal(consentAllowsReferral({ marketingAllowed: true }), false);
  assert.equal(consentAllowsReferral({ analyticsProcessingAllowed: true }), false);
  assert.equal(consentAllowsReferral(null), false);
});

test('store only an explicitly untrusted local candidate, no network transmission', async () => {
  const s = storage();
  const status = await captureStagingCandidate({ href: 'https://mystorefront-test.myshopify.com/?click_id=' + click,
    privacy, storage: s, nowMs: now });
  assert.equal(status, 'stored_verified_local');
  const value = JSON.parse(s.data.get(REFERRAL_STORAGE_KEY));
  assert.equal(value.click_id, click);
  assert.equal(value.trusted, false);
  assert.equal(value.expires_at, now + REFERRAL_TTL_MS);
  assert.equal(Object.keys(value).sort().join(','), 'click_id,expires_at,observed_at,trusted');
});

test('remove candidate on consent loss and after expiration', async () => {
  const s = storage();
  const href = 'https://mystorefront-test.myshopify.com/?click_id=' + click;
  await captureStagingCandidate({ href, privacy, storage: s, nowMs: now });
  assert.equal(await captureStagingCandidate({ href, privacy: {}, storage: s, nowMs: now }), 'consent_denied');
  assert.equal(s.data.has(REFERRAL_STORAGE_KEY), false);
  await captureStagingCandidate({ href, privacy, storage: s, nowMs: now });
  assert.equal(await captureStagingCandidate({ href: 'https://mystorefront-test.myshopify.com/',
    privacy, storage: s, nowMs: now + REFERRAL_TTL_MS }), 'expired_or_invalid');
  assert.equal(s.data.has(REFERRAL_STORAGE_KEY), false);
});

test('staging pixel does not send the candidate or initiate conversion processing', () => {
  const pixel = readFileSync(new URL('../../extensions/mystorefront-staging-pixel/src/index.js', import.meta.url), 'utf8');
  assert.match(pixel, /captureStagingCandidate/);
  assert.match(pixel, /analytics\.subscribe\('page_viewed'/);
  assert.doesNotMatch(pixel, /checkout_completed|orders\/paid|affiliate-postback|sendBeacon/);
  assert.doesNotMatch(pixel, /body\s*:/);
});

test('report storage readback mismatch without claiming verification', async () => {
  const s = storage();
  s.getItem = async () => null;
  const result = await captureStagingCandidate({
    href: 'https://mystorefront-test.myshopify.com/?click_id=' + click,
    privacy, storage: s, nowMs: now,
  });
  assert.equal(result, 'storage_readback_failed');
});

test('DevTools diagnostic reveals status only, never the referral identifier', () => {
  const pixel = readFileSync(new URL('../../extensions/mystorefront-staging-pixel/src/index.js', import.meta.url), 'utf8');
  assert.match(pixel, /referral_storage_status=/);
  assert.doesNotMatch(pixel, /console\.(?:log|info|warn|error)\([^\n]*(?:clickId|click_id|urlSnapshot|lastPageUrl)/);
});

test('retain verified local candidate when navigating without query parameter', async () => {
  const s = storage();
  const first = await captureStagingCandidate({
    href: 'https://mystorefront-test.myshopify.com/?click_id=' + click,
    privacy, storage: s, nowMs: now,
  });
  assert.equal(first, 'stored_verified_local');
  const original = s.data.get(REFERRAL_STORAGE_KEY);
  const next = await captureStagingCandidate({
    href: 'https://mystorefront-test.myshopify.com/collections/all',
    privacy, storage: s, nowMs: now + 1000,
  });
  assert.equal(next, 'retained_verified_local');
  assert.equal(s.data.get(REFERRAL_STORAGE_KEY), original);
});

test('visit without any referral reports no_referral', async () => {
  const result = await captureStagingCandidate({
    href: 'https://mystorefront-test.myshopify.com/products/a',
    privacy, storage: storage(), nowMs: now,
  });
  assert.equal(result, 'no_referral');
});

test('checkout read-only inspection sees retained unverified referral without sending it', async () => {
  const s = storage();
  await captureStagingCandidate({href: 'https://mystorefront-test.myshopify.com/?click_id=' + click,
    privacy, storage:s, nowMs:now});
  assert.equal(await inspectStagingCheckoutCandidate({privacy,storage:s,nowMs:now+2000}),
    'present_unverified');
  assert.equal(await inspectStagingCheckoutCandidate({privacy:{},storage:s,nowMs:now+2000}),
    'consent_denied');
  assert.equal(await inspectStagingCheckoutCandidate({privacy,storage:s,nowMs:now+REFERRAL_TTL_MS}),
    'expired_or_invalid');
  assert.equal(s.data.has(REFERRAL_STORAGE_KEY),false);
});

test('checkout pixel diagnostic does not transmit checkout or referral identifiers',()=>{
  const pixel=readFileSync(new URL('../../extensions/mystorefront-staging-pixel/src/index.js',import.meta.url),'utf8');
  assert.match(pixel, /analytics\\.subscribe\\('checkout_started'/);
  assert.match(pixel,/checkout_referral_status=/);
  assert.doesNotMatch(pixel,/checkout_completed|checkout\\.token|checkout\\.order|sendBeacon/);
});
