import "dotenv/config";

// The Shopify PostgreSQL session-storage library builds its own pg Pool and
// ignores both `ssl` options and the connection string's `sslmode` — it only
// reads host/user/password/database/port. So the ONLY lever for that pool's TLS
// is the PGSSLMODE env var, which node-postgres reads. Render's managed Postgres
// presents a self-signed certificate, so we force PGSSLMODE=no-verify, which
// node-postgres maps to { rejectUnauthorized: false } scoped to Postgres only.
// Forcing it (rather than defaulting) means a stale PGSSLMODE in the host env
// can't break boot.
//
// We deliberately do NOT disable TLS verification globally. A previous version
// set NODE_TLS_REJECT_UNAUTHORIZED="0", which turns off certificate checking for
// EVERY outbound HTTPS request in the process — customer data sent to the
// postback URL, all Shopify Admin API calls — exposing them to MITM. Clear it
// here if it leaked into the env (also remove it from the host env if pinned).
const dbUrl = process.env.DATABASE_URL || "";
const isLocal = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");
if (!isLocal) {
  process.env.PGSSLMODE = "no-verify";
}
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

import express from "express";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { join } from "path";
import { readFileSync } from "fs";
import { timingSafeEqual } from "crypto";
import { shopifyApp } from "@shopify/shopify-app-express";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import { ApiVersion } from "@shopify/shopify-api";
import { restResources } from "@shopify/shopify-api/rest/admin/2025-04";

import { getSettings, getShopifyTokenSet } from "./db.js";
import { persistShopifyTokens } from "./shopify-auth.js";
import settingsRouter from "./routes/settings.js";
import deliveriesRouter from "./routes/deliveries.js";
import webhookHandlers from "./webhooks/index.js";
import { startRetryWorker } from "./retry-worker.js";
import { pixelScriptRouter } from "./routes/pixel-script.js";
import discountCodesRouter from "./routes/discount-codes.js";
import cors from "cors";
import gdprRouter from "./routes/gdpr.js";

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || "3000", 10);
const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/web/frontend/dist`
    : `${process.cwd()}/web/frontend/`;

const HOST_NAME = (process.env.SHOPIFY_APP_URL || "").replace(/^https?:\/\//, "");

const shopify = shopifyApp({
  api: {
    apiVersion: ApiVersion.April25,
    restResources,
    future: {
      // Switch from Authorization Code Grant to Token Exchange.
      // Shopify now refuses to issue non-expiring offline tokens, which the
      // classic OAuth flow was producing — the only way to get a usable
      // Admin API token for an embedded app is via token exchange.
      unstable_newEmbeddedAuthStrategy: true,
    },
  },
  hostName: HOST_NAME,
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },

  webhooks: {
    path: "/api/webhooks",
  },

  sessionStorage: new PostgreSQLSessionStorage(process.env.DATABASE_URL),
});

const app = express();

// Cross-origin policy. The embedded admin UI calls this backend same-origin,
// and every server-to-server caller (the MyStorefront / Loveable Supabase edge
// functions) is not subject to CORS at all. So browser cross-origin access is
// denied by default and only enabled for origins explicitly listed in the
// ALLOWED_ORIGINS env var (comma-separated, e.g. "https://app.mystorefront.io").
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Mystorefront-Key",
      "X-Shopify-Shop",
    ],
  })
);

// Request logging. Use a concise format that omits the query string — it can
// carry the Shopify id_token (a session JWT) and the shop domain — and skip the
// health check so the logs aren't flooded by uptime pings.
morgan.token("cleanurl", (req) => (req.originalUrl || req.url || "").split("?")[0]);
app.use(
  morgan(
    ':remote-addr ":method :cleanurl HTTP/:http-version" :status :res[content-length] - :response-time ms',
    { skip: (req) => req.path === "/health" }
  )
);
app.use(compression());

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    xFrameOptions: false,
  })
);
// Allow the Shopify storefront (a different origin) to load the public pixel
// script. The /pixel route also sets this per-response; this keeps parity for
// any other publicly embedded asset.
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
  next();
});

// GDPR mandatory webhooks — must be registered BEFORE express.json() so the
// HMAC verifier sees the raw request body. Required by Shopify for any
// public/unlisted app submission.
app.use("/api/webhooks/gdpr", gdprRouter);

app.get("/health", (req, res) => res.status(200).send("OK"));

// Public policy documents — required for App Store / unlisted submission.
// Served as plain text so crawlers and reviewers can read them directly.
function servePolicyDoc(filename) {
  return (_req, res) => {
    try {
      const body = readFileSync(join(process.cwd(), filename), "utf8");
      res.set("Content-Type", "text/plain; charset=utf-8").send(body);
    } catch (err) {
      console.error(`[MS] Failed to serve ${filename}:`, err.message);
      res.status(404).send("Not found");
    }
  };
}
app.get("/privacy", servePolicyDoc("PRIVACY.md"));
app.get("/security", servePolicyDoc("SECURITY.md"));

// SECURITY: validate redirectUri — only allow relative paths, known Shopify
// domains, or our own app host (which Shopify library generates when it wants
// us to exit the iframe and hit /api/auth to complete OAuth).
const OWN_HOST = (process.env.SHOPIFY_APP_URL || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");
app.get("/exitiframe", (req, res) => {
  const redirectUri = req.query.redirectUri;
  let sanitized = "/";

  if (redirectUri) {
    const decoded = decodeURIComponent(String(redirectUri));
    const isRelative = decoded.startsWith("/") && !decoded.startsWith("//");
    const isShopifyDomain = /^https:\/\/([a-zA-Z0-9-]+\.myshopify\.com|admin\.shopify\.com)(\/|$)/.test(decoded);
    const isOwnHost =
      !!OWN_HOST && decoded.startsWith(`https://${OWN_HOST}/`);
    if (isRelative || isShopifyDomain || isOwnHost) {
      sanitized = decoded;
    }
  }

  res.set("Content-Type", "text/html").send(`
    <!DOCTYPE html>
    <html>
      <head>
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <script>
          var redirectUrl = ${JSON.stringify(sanitized)};
          window.open(redirectUrl, '_top');
        </script>
      </head>
      <body><p>Redirecting to authenticate...</p></body>
    </html>
  `);
});

// Shopify auth routes
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  async (req, res, next) => {
    try {
      // After successful OAuth, grab the session and save the access token
      const session = res.locals.shopify?.session;
      if (session?.shop && session?.accessToken) {
        const { saveAccessToken } = await import("./db.js");
        await saveAccessToken(session.shop, session.accessToken);
        console.log(`[MS] Access token saved for ${session.shop}`);
      }
    } catch (err) {
      console.error("[MS] Error saving access token:", err.message);
    }
    next();
  },
  shopify.redirectToShopifyOrAppRoot()
);

// Webhook route — HMAC verified before dispatching
app.post("/api/webhooks", express.text({ type: "*/*" }), async (req, res) => {
  const topic = req.headers["x-shopify-topic"];
  const shop = req.headers["x-shopify-shop-domain"];
  const hmac = req.headers["x-shopify-hmac-sha256"];

  // SECURITY: verify HMAC signature before processing any webhook payload
  if (!hmac || !process.env.SHOPIFY_API_SECRET) {
    console.error("[MS] Webhook rejected: missing HMAC or API secret not configured");
    return res.status(401).send("Unauthorized");
  }

  const { createHmac, timingSafeEqual: tse } = await import("crypto");
  const digest = createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(req.body, "utf8")
    .digest("base64");

  try {
    if (!tse(Buffer.from(digest), Buffer.from(hmac))) {
      console.error("[MS] Webhook rejected: HMAC mismatch");
      return res.status(401).send("Unauthorized");
    }
  } catch {
    return res.status(401).send("Unauthorized");
  }

  try {
    if (topic === "orders/paid") {
      await webhookHandlers.ordersPaid(topic, shop, req.body);
    } else if (topic === "orders/updated") {
      await webhookHandlers.ordersUpdated(topic, shop, req.body);
    } else if (topic === "refunds/create") {
      await webhookHandlers.refundsCreate(topic, shop, req.body);
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("[MS] Webhook route error:", err);
    res.status(500).send("Error");
  }
});

// Public pixel script
app.use("/pixel", pixelScriptRouter);

// Parse JSON body
app.use(express.json());

// ── Public ping endpoint — called by MyStorefront to verify connection ──────
// Must be registered BEFORE the session middleware, as this request comes
// from MyStorefront's servers (no Shopify JWT), authenticated only by API key.
app.get("/api/settings/ping", async (req, res) => {
  const shop = req.query.shop || req.headers["x-shopify-shop"];
  if (!shop) return res.status(400).json({ error: "shop parameter required" });

  const settings = await getSettings(shop);
  const storedKey = settings?.mystorefront_api_key || "";
  const providedKey = req.headers["x-mystorefront-key"] || "";

  if (!storedKey || !providedKey) {
    return res.status(401).json({ error: "Invalid or missing X-Mystorefront-Key header." });
  }

  let match = false;
  try { match = timingSafeEqual(Buffer.from(storedKey), Buffer.from(providedKey)); } catch { }
  if (!match) {
    return res.status(401).json({ error: "Invalid or missing X-Mystorefront-Key header." });
  }

  return res.json({ ok: true });
});

// ── MyStorefront-facing discount codes — also BEFORE session middleware ─────
// Called by MyStorefront's servers using X-Mystorefront-Key auth (handled inside router).
app.use("/api/discount-codes", discountCodesRouter(shopify));

// SECURITY: Session middleware for merchant-facing routes. Every /api call
// below this point must carry a valid Shopify session-token JWT (the App Bridge
// `idToken`). We verify the JWT signature with our API secret and trust ONLY
// the shop in its verified `dest` claim.
//
// There is deliberately NO fallback to a `?shop=` query param or header: that
// would let anyone read or modify any store's settings just by guessing its
// myshopify domain. (Server-to-server callers use the key-authenticated
// /api/settings/ping and /api/discount-codes routes registered above instead.)
app.use("/api/*", async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const parts = token.split(".");

    if (token && parts.length === 3) {
      const { createHmac, timingSafeEqual: tse } = await import("crypto");
      const apiSecret = process.env.SHOPIFY_API_SECRET || "";

      // Verify JWT signature: HMAC-SHA256 of header.payload
      const signingInput = parts[0] + "." + parts[1];
      const expectedSig = createHmac("sha256", apiSecret)
        .update(signingInput)
        .digest("base64url");

      let sigValid = false;
      try {
        sigValid = tse(Buffer.from(expectedSig), Buffer.from(parts[2]));
      } catch {
        sigValid = false;
      }

      if (sigValid) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
        // Reject expired tokens (30s leeway for clock skew). Shopify session
        // tokens live ~1 min and the frontend fetches a fresh one per request,
        // so a legitimate caller always presents an unexpired token.
        const now = Math.floor(Date.now() / 1000);
        const notExpired =
          typeof payload.exp !== "number" || payload.exp > now - 30;
        const dest = payload.dest || "";
        const shop = dest.replace("https://", "");
        if (notExpired && shop && shop.includes(".myshopify.com")) {
          res.locals.shopify = { session: { shop } };
          return next();
        }
      }
    }
  } catch {
    // fall through to 401
  }

  return res.status(401).json({ error: "Unauthorized" });
});

// Routes protected by Shopify JWT session middleware (merchant-facing)
app.use("/api/settings", settingsRouter(shopify));
app.use("/api/deliveries", deliveriesRouter(shopify));

// Serve frontend — set frame-ancestors to allow Shopify Admin to embed the app
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
  );
  next();
});
app.use(express.static(STATIC_PATH, { index: false }));

// When the embedded app loads we get `id_token` (a Shopify session JWT) on
// the querystring. Exchange it for an offline Admin API token and store it
// in session storage + settings cache. This is the only way to get an
// expiring offline token — the classic OAuth flow issues non-expiring
// tokens which Shopify no longer accepts on the Admin API.
async function tokenExchangeMiddleware(req, res, next) {
  const shopParam = req.query.shop;
  const idToken = req.query.id_token;
  if (typeof shopParam !== "string" || typeof idToken !== "string") {
    return next();
  }
  const shop = shopify.api.utils.sanitizeShop(shopParam);
  if (!shop) return next();

  try {
    // Decide whether to skip re-exchange. We skip ONLY when all three hold:
    //   1. the session storage already has an access token,
    //   2. that token's expiry is well in the future (>5 min buffer), and
    //   3. the settings row has a non-empty refresh_token.
    //
    // (3) catches the migration case: shops that exchanged under the
    // pre-refresh-token code have a valid session but no refresh token
    // stored, so the moment the access token expires, backend calls have
    // no way to recover. Re-exchanging on the next app open populates the
    // new columns so the refresh flow can take over from there.
    const sessionId = shopify.api.session.getOfflineId(shop);
    const existing =
      await shopify.config.sessionStorage.loadSession(sessionId);
    const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
    const expiresComfortablyInFuture =
      existing?.expires &&
      new Date(existing.expires).getTime() - Date.now() > EXPIRY_BUFFER_MS;

    const storedTokens = await getShopifyTokenSet(shop);
    const hasRefreshToken = Boolean(storedTokens?.refreshToken);

    if (
      existing?.accessToken &&
      expiresComfortablyInFuture &&
      hasRefreshToken
    ) {
      return next();
    }

    if (existing?.accessToken && expiresComfortablyInFuture && !hasRefreshToken) {
      console.log(
        `[MS] token-exchange: session valid but refresh_token missing for ${shop} — re-exchanging to backfill refresh token`,
      );
    }

    // Call the token-exchange endpoint ourselves so we can (a) include the
    // `expiring: "1"` parameter which the SDK v11.14.1 does NOT send, and
    // (b) log the raw response. Without `expiring=1` Shopify returns the
    // deprecated non-expiring offline token — which the Admin API now
    // rejects ("Non-expiring access tokens are no longer accepted").
    const body = {
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type:
        "urn:shopify:params:oauth:token-type:offline-access-token",
      expiring: "1",
    };
    const tokRes = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const tokJson = await tokRes.json().catch(() => ({}));
    const safeLog = {
      ...tokJson,
      access_token: tokJson.access_token
        ? `${String(tokJson.access_token).slice(0, 8)}…`
        : undefined,
      refresh_token: tokJson.refresh_token
        ? `${String(tokJson.refresh_token).slice(0, 8)}…`
        : undefined,
    };
    console.log(
      `[MS] token-exchange raw response (status=${tokRes.status}):`,
      JSON.stringify(safeLog),
    );

    if (!tokRes.ok || !tokJson.access_token) {
      return next();
    }

    // Persist the access token + refresh token + both expiry timestamps.
    // Uses the shared helper so the shape matches what refreshShopifyAccessToken
    // writes on rotation — keeps session storage and the settings row in sync.
    const { session, accessTokenExpiresAt, refreshTokenExpiresAt } =
      await persistShopifyTokens(shopify, shop, tokJson);

    console.log(
      `[MS] Token exchange stored offline session for ${shop} (scope=${session.scope}, access_expires=${accessTokenExpiresAt?.toISOString() || "null"}, refresh_expires=${refreshTokenExpiresAt?.toISOString() || "null"})`,
    );
  } catch (err) {
    console.error(
      `[MS] Token exchange failed for ${shopParam}:`,
      err?.message || err,
    );
  }
  return next();
}

app.use("/*", tokenExchangeMiddleware, async (_req, res) => {
  // Inject SHOPIFY_API_KEY into the App Bridge script's data-api-key attribute.
  // App Bridge v4 requires data-api-key to initialise window.shopify, which
  // provides window.shopify.idToken() — the fresh session-token source our
  // frontend uses for every authenticated fetch.
  const html = readFileSync(join(STATIC_PATH, "index.html"), "utf-8").replace(
    /%SHOPIFY_API_KEY%/g,
    process.env.SHOPIFY_API_KEY || ""
  );
  return res
    .set("Content-Type", "text/html")
    .set("Cache-Control", "no-store")
    .send(html);
});

app.listen(PORT, () => {
  console.log(`MyStorefront Postback app listening on port ${PORT}`);
  startRetryWorker();
});

export default shopify;
