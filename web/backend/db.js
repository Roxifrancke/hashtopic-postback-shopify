import pg from "pg";

const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL || "";
const isLocalhost = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isLocalhost ? false : { rejectUnauthorized: false },
});

// ── Schema ──────────────────────────────────────────────────────────────────

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      shop             TEXT PRIMARY KEY,
      webhook_url      TEXT NOT NULL DEFAULT '',
      webhook_secret   TEXT NOT NULL DEFAULT '',
      paid_statuses    TEXT NOT NULL DEFAULT '["paid"]',
      param_names      TEXT NOT NULL DEFAULT 'click_id',
      cookie_name      TEXT NOT NULL DEFAULT 'click_id',
      cookie_days      INTEGER NOT NULL DEFAULT 30,
      debug            INTEGER NOT NULL DEFAULT 0,
      test_mode        INTEGER NOT NULL DEFAULT 0,
      mystorefront_api_key TEXT NOT NULL DEFAULT '',
      shopify_admin_token  TEXT NOT NULL DEFAULT '',
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id               SERIAL PRIMARY KEY,
      shop             TEXT NOT NULL,
      order_id         TEXT NOT NULL,
      order_name       TEXT NOT NULL DEFAULT '',
      status           TEXT NOT NULL DEFAULT 'pending',
      attempts         INTEGER NOT NULL DEFAULT 0,
      last_http_code   INTEGER,
      last_error       TEXT,
      sent_at          TIMESTAMPTZ,
      next_retry_at    TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_deliveries_shop ON deliveries(shop);
    CREATE INDEX IF NOT EXISTS idx_deliveries_order ON deliveries(shop, order_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON deliveries(status, next_retry_at);
  `);
}

// Initialize on import
const dbReady = initDb().catch((err) => {
  console.error("[MS] Database initialization failed:", err);
  process.exit(1);
});

// Helper to ensure DB is ready before queries
async function ensureReady() {
  await dbReady;
}

// ── Settings helpers ─────────────────────────────────────────────────────────

export function getSettings(shop) {
  return getSettingsAsync(shop);
}

export async function getSettingsAsync(shop) {
  await ensureReady();
  const { rows } = await pool.query("SELECT * FROM settings WHERE shop = $1", [shop]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    paid_statuses: JSON.parse(row.paid_statuses || '["paid"]'),
    debug: Boolean(row.debug),
    test_mode: Boolean(row.test_mode),
    mystorefront_api_key: row.mystorefront_api_key || "",
    shopify_admin_token: row.shopify_admin_token || "",
  };
}

export async function getSettingsByApiKey(apiKey) {
  if (!apiKey) return null;
  await ensureReady();
  const { rows } = await pool.query("SELECT * FROM settings WHERE mystorefront_api_key = $1", [apiKey]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    paid_statuses: JSON.parse(row.paid_statuses || '["paid"]'),
    debug: Boolean(row.debug),
    test_mode: Boolean(row.test_mode),
    mystorefront_api_key: row.mystorefront_api_key || "",
    shopify_admin_token: row.shopify_admin_token || "",
  };
}

export async function saveSettings(shop, data) {
  await ensureReady();
  const existing = await getSettingsAsync(shop);
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

  // Merge with existing values so partial updates (e.g. generate-api-key) don't wipe fields
  const merged = {
    webhook_url:   data.webhook_url   !== undefined ? data.webhook_url   : existing?.webhook_url   || "",
    paid_statuses: data.paid_statuses !== undefined ? data.paid_statuses : existing?.paid_statuses  || ["paid"],
    param_names:   data.param_names   !== undefined ? data.param_names   : existing?.param_names    || "click_id",
    cookie_name:   data.cookie_name   !== undefined ? data.cookie_name   : existing?.cookie_name    || "click_id",
    cookie_days:   data.cookie_days   !== undefined ? data.cookie_days   : existing?.cookie_days    || 30,
    debug:         data.debug         !== undefined ? data.debug         : existing?.debug          || false,
    test_mode:     data.test_mode     !== undefined ? data.test_mode     : existing?.test_mode      || false,
  };

  await pool.query(`
    INSERT INTO settings (shop, webhook_url, webhook_secret, paid_statuses, param_names,
      cookie_name, cookie_days, debug, test_mode, mystorefront_api_key, shopify_admin_token, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    ON CONFLICT(shop) DO UPDATE SET
      webhook_url          = EXCLUDED.webhook_url,
      webhook_secret       = EXCLUDED.webhook_secret,
      paid_statuses        = EXCLUDED.paid_statuses,
      param_names          = EXCLUDED.param_names,
      cookie_name          = EXCLUDED.cookie_name,
      cookie_days          = EXCLUDED.cookie_days,
      debug                = EXCLUDED.debug,
      test_mode            = EXCLUDED.test_mode,
      mystorefront_api_key = EXCLUDED.mystorefront_api_key,
      shopify_admin_token  = EXCLUDED.shopify_admin_token,
      updated_at           = NOW()
  `, [
    shop,
    merged.webhook_url,
    secret,
    JSON.stringify(merged.paid_statuses),
    merged.param_names,
    merged.cookie_name,
    Math.min(365, Math.max(1, parseInt(merged.cookie_days, 10) || 30)),
    merged.debug ? 1 : 0,
    merged.test_mode ? 1 : 0,
    msApiKey,
    adminToken,
  ]);
  return getSettingsAsync(shop);
}

// ── Deliveries helpers ───────────────────────────────────────────────────────

export async function upsertDelivery(shop, orderId, orderName) {
  await ensureReady();
  const { rows: existing } = await pool.query(
    "SELECT * FROM deliveries WHERE shop = $1 AND order_id = $2",
    [shop, orderId]
  );
  if (existing.length > 0) return existing[0];

  const { rows } = await pool.query(`
    INSERT INTO deliveries (shop, order_id, order_name, status)
    VALUES ($1, $2, $3, 'pending')
    RETURNING *
  `, [shop, orderId, orderName || orderId]);

  return rows[0];
}

export async function markDeliverySent(deliveryId, httpCode) {
  await ensureReady();
  await pool.query(`
    UPDATE deliveries SET
      status = 'sent', last_http_code = $1, last_error = NULL,
      sent_at = NOW(), updated_at = NOW(),
      attempts = attempts + 1
    WHERE id = $2
  `, [httpCode, deliveryId]);
}

export async function markDeliveryFailed(deliveryId, httpCode, error, nextRetryAt) {
  await ensureReady();
  await pool.query(`
    UPDATE deliveries SET
      status = $1,
      last_http_code = $2,
      last_error = $3,
      next_retry_at = $4,
      updated_at = NOW(),
      attempts = attempts + 1
    WHERE id = $5
  `, [
    nextRetryAt ? "pending_retry" : "failed",
    httpCode || 0,
    error || "",
    nextRetryAt || null,
    deliveryId,
  ]);
}

export async function getDeliveriesForShop(shop, limit = 50) {
  await ensureReady();
  const { rows } = await pool.query(
    "SELECT * FROM deliveries WHERE shop = $1 ORDER BY updated_at DESC LIMIT $2",
    [shop, limit]
  );
  return rows;
}

export async function getDeliveryById(id) {
  await ensureReady();
  const { rows } = await pool.query("SELECT * FROM deliveries WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function getPendingRetries() {
  await ensureReady();
  const { rows } = await pool.query(
    "SELECT * FROM deliveries WHERE status = 'pending_retry' AND next_retry_at <= NOW() LIMIT 100"
  );
  return rows;
}

export async function resetDeliveryForRetry(deliveryId) {
  await ensureReady();
  await pool.query(`
    UPDATE deliveries SET status = 'pending', next_retry_at = NULL, updated_at = NOW()
    WHERE id = $1
  `, [deliveryId]);
}

// ── OAuth access token helpers ───────────────────────────────────────────────

export async function saveAccessToken(shop, accessToken) {
  await ensureReady();
  await pool.query(
    `INSERT INTO settings (shop) VALUES ($1) ON CONFLICT(shop) DO NOTHING`,
    [shop]
  );
  await pool.query(`
    UPDATE settings
    SET shopify_admin_token = $1, updated_at = NOW()
    WHERE shop = $2
  `, [accessToken, shop]);
}

export async function getAccessToken(shop) {
  await ensureReady();
  const { rows } = await pool.query(
    "SELECT shopify_admin_token FROM settings WHERE shop = $1",
    [shop]
  );
  return rows[0]?.shopify_admin_token || null;
}

// ── Retention / GDPR ────────────────────────────────────────────────────────

export async function purgeOldDeliveries(days = 90) {
  await ensureReady();
  const { rowCount } = await pool.query(
    `DELETE FROM deliveries
     WHERE updated_at < NOW() - ($1 || ' days')::interval
       AND status IN ('sent', 'failed')`,
    [days]
  );
  return rowCount;
}

export async function deleteShopData(shop) {
  await ensureReady();
  const { rowCount: d } = await pool.query("DELETE FROM deliveries WHERE shop = $1", [shop]);
  const { rowCount: s } = await pool.query("DELETE FROM settings WHERE shop = $1", [shop]);
  return { deliveries: d, settings: s };
}

export default pool;
export { pool as db };
