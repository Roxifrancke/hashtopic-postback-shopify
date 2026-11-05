import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const app = readFileSync(new URL('../../shopify.app.mystorefront-postback.toml', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../prototypes/shopify-web-pixel/staging-transport-smoke.js', import.meta.url), 'utf8');

test('Shopify CLI app config must target the isolated staging identity only', () => {
  assert.match(app, /^client_id = "2f3aa895637da2cc63111d4922a5dd17"$/m);
  assert.match(app, /^name = "MyStorefront Postback Staging"$/m);
  assert.match(app, /^application_url = "https:\/\/hashtopic-postback-shopify-staging\.onrender\.com"$/m);
  assert.doesNotMatch(app, /80133e649bd215aa494b9e54f91aa0f3/);
  assert.doesNotMatch(app, /https:\/\/mystorefront-postback\.onrender\.com/);
  assert.match(app, /write_pixels/);
  assert.match(app, /read_customer_events/);
  assert.match(app, /api_version = "2027-01"/);
  assert.match(app, /topics = \["orders\/paid", "refunds\/create"\]/);
  for (const scope of ['read_discounts','read_products','read_script_tags','read_themes','write_orders','write_script_tags','write_themes']) assert.ok(app.includes(scope));
});

test('Pixel prototype sends only an empty probe to the staging endpoint', () => {
  assert.match(smoke, /analytics\.subscribe\('page_viewed'/);
  assert.match(smoke, /https:\/\/hashtopic-postback-shopify-staging\.onrender\.com/);
  assert.match(smoke, /\/api\/staging\/web-pixel-transport-probe\//);
  assert.doesNotMatch(smoke, /mystorefront-postback\.onrender\.com/);
  assert.doesNotMatch(smoke, /checkout_completed|orders\/paid|customer\./);
  assert.doesNotMatch(smoke, /body\s*:/);
});
