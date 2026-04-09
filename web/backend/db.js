import Database from "better-sqlite3";
import { join } from "path";

const DB_PATH = join(process.cwd(), "hashtopic.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    shop         TEXT PRIMARY KEY,
    webhook_url  TEXT NOT NULL DEFAULT '',
    webhook_secret TEXT NOT NULL DEFAULT '',
    paid_statuses TEXT NOT NULL DEFAULT '["paid"]',
    param_names  TEXT NOT NULL DEFAULT 'click_id',
    cookie_name  TEXT NOT NULL DEFAULT '_ht_click_id',
    cookie_days  INTEGER NOT NULL DEFAULT 30,
    debug        INTEGER NOT NULL DEFAULT 0,
    test_mode    INTEGER NOT NULL DEFAULT 0,
    mystorefront_api_key TEXT NOT NULL DEFAULT '',
    shopify_admin_token  TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    shop             TEXT NOT NULL,
    order_id         TEXT NOT NULL,
    order_name       TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_http_code   INTEGER,
    last_error       TEXT,
    sent_at          TEXT,
    next_retry_at    TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_deliveries_shop ON deliveries(shop);
  CREATE INDEX IF NOT EXISTS idx_deliveries_order ON deliveries(shop, order_id);
  CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON deliveries(status, next_retry_at);
`);

// ── Settings helpers ─────────────────────────────────────────────────────────

export function getSettings(shop) {
  const row = db.prepare("SELECT * FROM settings WHERE shop = ?").get(shop);
  if (!row) return null;
  return {
    ...row,
    paid_statuses: JSON.parse(row.paid_statuses || '["paid"]'),
    debug: Boolean(row.debug),
    test_mode: Boolean(row.test_mode),
    mystorefront_api_key: row.mystorefront_api_key || "",
    shopify_admin_token: row.shopify_admin_token || "",
  };
}

export function getSettingsByApiKey(apiKey) {
  if (!apiKey) return null;
  const row = db.prepare("SELECT * FROM settings WHERE mystorefront_api_key = ?").get(apiKey);
  if (!row) return null;
  return {
    ...row,
    paid_statuses: JSON.parse(row.paid_statuses || '["paid"]'),
    debug: Boolean(row.debug),
    test_mode: Boolean(row.test_mode),
    mystorefront_api_key: row.mystorefront_api_key || "",
    shopify_admin_token: row.shopify_admin_token || "",
  };
}

export function saveSettings(shop, data) {
  const existing = getSettings(shop);
  const secret =
    data.webhook_secret && data.webhook_secret.trim()
      ? data.webhook_secret.trim()
      : existing?.webhook_secret || "";

  const msApiKey =
    data.mystorefront_api_key && data.mystorefront_api_key.trim()
      ? data.mystorefront_api_key.trim()
      : existing?.mystorefront_api_key || "";

  const adminToken =
    data.shopify_admin_token && data.shopify_admin_token.trim()
      ? data.shopify_admin_token.trim()
      : existing?.shopify_admin_token || "";

  db.prepare(`
    INSERT INTO settings (shop, webhook_url, webhook_secret, paid_statuses, param_names,
      cookie_name, cookie_days, debug, test_mode, mystorefront_api_key, shopify_admin_token, updated_at)
    VALUES (@shop, @webhook_url, @webhook_secret, @paid_statuses, @param_names,
      @cookie_name, @cookie_days, @debug, @test_mode, @mystorefront_api_key, @shopify_admin_token, datetime('now'))
    ON CONFLICT(shop) DO UPDATE SET
      webhook_url          = excluded.webhook_url,
      webhook_secret       = excluded.webhook_secret,
      paid_statuses        = excluded.paid_statuses,
      param_names          = excluded.param_names,
      cookie_name          = excluded.cookie_name,
      cookie_days          = excluded.cookie_days,
      debug                = excluded.debug,
      test_mode            = excluded.test_mode,
      mystorefront_api_key = excluded.mystorefront_api_key,
      shopify_admin_token  = excluded.shopify_admin_token,
      updated_at           = datetime('now')
  `).run({
    shop,
    webhook_url: data.webhook_url || "",
    webhook_secret: secret,
    paid_statuses: JSON.stringify(data.paid_statuses || ["paid"]),
    param_names: data.param_names || "click_id",
    cookie_name: data.cookie_name || "_ht_click_id",
    cookie_days: Math.min(365, Math.max(1, parseInt(data.cookie_days, 10) || 30)),
    debug: data.debug ? 1 : 0,
    test_mode: data.test_mode ? 1 : 0,
    mystorefront_api_key: msApiKey,
    shopify_admin_token: adminToken,
  });
  return getSettings(shop);
}

// ── Deliveries helpers ───────────────────────────────────────────────────────

export function upsertDelivery(shop, orderId, orderName) {
  const existing = db
    .prepare("SELECT * FROM deliveries WHERE shop = ? AND order_id = ?")
    .get(shop, orderId);
  if (existing) return existing;

  const info = db.prepare(`
    INSERT INTO deliveries (shop, order_id, order_name, status)
    VALUES (?, ?, ?, 'pending')
  `).run(shop, orderId, orderName || orderId);

  return db.prepare("SELECT * FROM deliveries WHERE id = ?").get(info.lastInsertRowid);
}

export function markDeliverySent(deliveryId, httpCode) {
  db.prepare(`
    UPDATE deliveries SET
      status = 'sent', last_http_code = ?, last_error = NULL,
      sent_at = datetime('now'), updated_at = datetime('now'),
      attempts = attempts + 1
    WHERE id = ?
  `).run(httpCode, deliveryId);
}

export function markDeliveryFailed(deliveryId, httpCode, error, nextRetryAt) {
  db.prepare(`
    UPDATE deliveries SET
      status = ?,
      last_http_code = ?,
      last_error = ?,
      next_retry_at = ?,
      updated_at = datetime('now'),
      attempts = attempts + 1
    WHERE id = ?
  `).run(
    nextRetryAt ? "pending_retry" : "failed",
    httpCode || 0,
    error || "",
    nextRetryAt || null,
    deliveryId
  );
}

export function getDeliveriesForShop(shop, limit = 50) {
  return db
    .prepare(
      "SELECT * FROM deliveries WHERE shop = ? ORDER BY updated_at DESC LIMIT ?"
    )
    .all(shop, limit);
}

export function getDeliveryById(id) {
  return db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
}

export function getPendingRetries() {
  return db
    .prepare(
      "SELECT * FROM deliveries WHERE status = 'pending_retry' AND next_retry_at <= datetime('now') LIMIT 100"
    )
    .all();
}

export function resetDeliveryForRetry(deliveryId) {
  db.prepare(`
    UPDATE deliveries SET status = 'pending', next_retry_at = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(deliveryId);
}

// ── OAuth access token helpers ───────────────────────────────────────────────

export function saveAccessToken(shop, accessToken) {
  db.prepare(`INSERT OR IGNORE INTO settings (shop) VALUES (?)`).run(shop);

  db.prepare(`
    UPDATE settings
    SET shopify_admin_token = ?, updated_at = datetime('now')
    WHERE shop = ?
  `).run(accessToken, shop);
}

export function getAccessToken(shop) {
  const row = db.prepare("SELECT shopify_admin_token FROM settings WHERE shop = ?").get(shop);
  return row?.shopify_admin_token || null;
}

export default db;
export { db };
