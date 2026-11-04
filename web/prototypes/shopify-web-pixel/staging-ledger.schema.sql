-- STAGING DESIGN ONLY. Not applied by any migration runner.
-- Keep completely separate from production affiliate orders/deliveries.
-- No shopper name, email, phone, address, URL, IP, or raw client identifier.
-- Database backups and retention need review before deployment.
BEGIN;

CREATE TABLE IF NOT EXISTS web_pixel_staging_referrals (
  shop TEXT NOT NULL CHECK (shop = 'mystorefront-test.myshopify.com'),
  client_hash CHAR(64) NOT NULL,
  click_id TEXT NOT NULL CHECK (length(click_id) BETWEEN 8 AND 128),
  clicked_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (shop, client_hash)
);

CREATE INDEX IF NOT EXISTS idx_web_pixel_staging_referral_expiry
  ON web_pixel_staging_referrals(expires_at);

CREATE TABLE IF NOT EXISTS web_pixel_staging_event_ids (
  shop TEXT NOT NULL CHECK (shop = 'mystorefront-test.myshopify.com'),
  event_hash CHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shop, event_hash)
);

CREATE INDEX IF NOT EXISTS idx_web_pixel_staging_event_expiry
  ON web_pixel_staging_event_ids(received_at);

CREATE TABLE IF NOT EXISTS web_pixel_staging_order_review (
  shop TEXT NOT NULL CHECK (shop = 'mystorefront-test.myshopify.com'),
  order_id TEXT NOT NULL,
  click_id TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending_manual_review'
    CHECK (status = 'pending_manual_review'),
  PRIMARY KEY (shop, order_id)
);

COMMIT;

-- BEFORE ENABLEMENT: configure retention: daily deletion of expired referrals,
-- event IDs older than 30 days, and reviewed staging orders older than policy.
-- Explicitly disable reads/writes except by staging service identity.
-- Never apply this migration to production without separate approval.
