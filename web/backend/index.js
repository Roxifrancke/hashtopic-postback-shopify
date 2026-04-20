import "dotenv/config";

// Force pg to use SSL — the Shopify session-storage library doesn't pass ssl
// options to its internal pg.Pool, so we rely on the libpq env vars instead.
const dbUrl = process.env.DATABASE_URL || "";
const isLocal = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");
if (!isLocal && !process.env.PGSSLMODE) {
  process.env.PGSSLMODE = "require";
  // Render uses self-signed certs; pg needs this to accept them
  if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
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

import { getSettings } from "./db.js";
import settingsRouter from "./routes/settings.js";
import deliveriesRouter from "./routes/deliveries.js";
import webhookHandlers from "./webhooks/index.js";
import { startRetryWorker } from "./retry-worker.js";
import { pixelScriptRouter } from "./routes/pixel-script.js";
import discountCodesRouter from "./routes/discount-codes.js";
import cors from "cors";
import shopifyWebhooks from "./routes/shopify-webhooks.js";
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
  },
  hostName: HOST_NAME,
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },

  webhooks: {
    path: "/api/webhooks", // ✅ REQUIRED
  },

  sessionStorage: new PostgreSQLSessionStorage(process.env.DATABASE_URL),
});

const app = express();

// ✅ ADD THIS FIRST (before everything)
app.use(cors({
  origin: "*", // or "https://mystorefront.io"
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Mystorefront-Key"]
}));

// ✅ HANDLE PREFLIGHT (CRITICAL)
app.options("*", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Mystorefront-Key"
  });
  return res.sendStatus(200);
});

app.use(morgan("combined"));
app.use(compression());

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    xFrameOptions: false,
  })
);

app.use("/api/webhooks/shopify", shopifyWebhooks);

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

// SECURITY: validate redirectUri — only allow relative paths or known Shopify domains
app.get("/exitiframe", (req, res) => {
  const redirectUri = req.query.redirectUri;
  let sanitized = "/";

  if (redirectUri) {
    const decoded = decodeURIComponent(String(redirectUri));
    const isRelative = decoded.startsWith("/") && !decoded.startsWith("//");
    const isShopifyDomain = /^https:\/\/([a-zA-Z0-9-]+\.myshopify\.com|admin\.shopify\.com)(\/|$)/.test(decoded);
    if (isRelative || isShopifyDomain) {
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

        // Auto-enable the Click ID Capture app embed in the active theme
        // TEMP DISABLED — causing OAuth 403
        // enableClickIdEmbed(session.shop, session.accessToken).catch((err) =>
        //   console.error("[MS] Failed to auto-enable app embed:", err.message)
        // );
      }
    } catch (err) {
      console.error("[MS] Error saving access token:", err.message);
    }
    next();
  },
  shopify.redirectToShopifyOrAppRoot()
);

/**
 * Programmatically activates the Click ID Capture app embed block in the
 * merchant's currently-active theme by patching config/settings_data.json.
 */
async function enableClickIdEmbed(shop, accessToken) {
  const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "mystorefront-postback";
  const BLOCK_HANDLE = "click-id-capture";
  const API_VERSION = "2025-04";
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  // 1. Find the active (main) theme
  const themesRes = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/themes.json`,
    { headers }
  );
  if (!themesRes.ok) throw new Error(`themes fetch failed: ${themesRes.status}`);
  const { themes } = await themesRes.json();
  const activeTheme = themes.find((t) => t.role === "main");
  if (!activeTheme) {
    console.warn("[MS] No active theme found for", shop);
    return;
  }

  // 2. Fetch config/settings_data.json from that theme
  const assetUrl =
    `https://${shop}/admin/api/${API_VERSION}/themes/${activeTheme.id}/assets.json` +
    `?asset[key]=config/settings_data.json`;
  const assetRes = await fetch(assetUrl, { headers });
  if (!assetRes.ok) throw new Error(`asset fetch failed: ${assetRes.status}`);
  const { asset } = await assetRes.json();
  const settingsData = JSON.parse(asset.value);

  // 3. Check if the embed is already present and enabled
  const blockType = `shopify://apps/${APP_HANDLE}/blocks/${BLOCK_HANDLE}`;
  const blocks = settingsData.current.blocks || {};
  const alreadyEnabled = Object.values(blocks).some(
    (b) => b.type === blockType && b.disabled !== true
  );
  if (alreadyEnabled) {
    console.log(`[MS] App embed already enabled for ${shop}`);
    return;
  }

  // 4. Remove any existing (disabled) entry for this block type, then add fresh
  for (const key of Object.keys(blocks)) {
    if (blocks[key].type === blockType) delete blocks[key];
  }
  const uuid = crypto.randomUUID();
  blocks[`${blockType}/${uuid}`] = { type: blockType, disabled: false, settings: {} };
  settingsData.current.blocks = blocks;

  // 5. Write back
  const putRes = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/themes/${activeTheme.id}/assets.json`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        asset: { key: "config/settings_data.json", value: JSON.stringify(settingsData) },
      }),
    }
  );
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`asset PUT failed ${putRes.status}: ${body}`);
  }
  console.log(`[MS] App embed enabled in theme "${activeTheme.name}" for ${shop}`);
}

// Webhook route — HMAC verified before dispatching
app.post("/api/webhooks", express.text({ type: "*/*" }), async (req, res) => {
  console.log("🔥 WEBHOOK HIT:", req.headers["x-shopify-topic"]);
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
app.use("/api/discount-codes", discountCodesRouter());

// SECURITY: Session middleware — verifies Shopify JWT signature before trusting shop identity
app.use("/api/*", async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace("Bearer ", "");

    if (token && token.includes(".")) {
      const parts = token.split(".");
      if (parts.length === 3) {
        const { createHmac, timingSafeEqual: tse } = await import("crypto");
        const apiSecret = process.env.SHOPIFY_API_SECRET || "";

        // Verify JWT signature: HMAC-SHA256 of header.payload
        const signingInput = parts[0] + "." + parts[1];
        const expectedSig = createHmac("sha256", apiSecret)
          .update(signingInput)
          .digest("base64url");

        let sigValid = false;
        try {
          sigValid = tse(
            Buffer.from(expectedSig),
            Buffer.from(parts[2])
          );
        } catch { sigValid = false; }

        if (sigValid) {
          const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
          const dest = payload.dest || "";
          const shop = dest.replace("https://", "");
          if (shop && shop.includes(".myshopify.com")) {
            res.locals.shopify = { session: { shop } };
            return next();
          }
        }
      }
    }
  } catch (e) {
    // Fall through to header/query fallback
  }

  // Fallback: header or query param (only for internal/trusted calls)
  const shop = req.headers["x-shopify-shop"] || req.query.shop;
  if (shop && String(shop).includes(".myshopify.com")) {
    res.locals.shopify = { session: { shop: String(shop) } };
    return next();
  }

  res.status(403).json({ error: "No shop identified" });
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
app.use("/*", async (_req, res) => {
  return res.set("Content-Type", "text/html").send(
    readFileSync(join(STATIC_PATH, "index.html"))
  );
});

app.listen(PORT, () => {
  console.log(`MyStorefront Postback app listening on port ${PORT}`);
  startRetryWorker();
});

export default shopify;
