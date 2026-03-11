import "dotenv/config";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { join } from "path";
import { readFileSync } from "fs";
import { shopifyApp } from "@shopify/shopify-app-express";
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";
import { ApiVersion } from "@shopify/shopify-api";
import { restResources } from "@shopify/shopify-api/rest/admin/2024-01";

import db from "./db.js";
import settingsRouter from "./routes/settings.js";
import deliveriesRouter from "./routes/deliveries.js";
import webhookHandlers from "./webhooks/index.js";
import { startRetryWorker } from "./retry-worker.js";
import { pixelScriptRouter } from "./routes/pixel-script.js";

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || "3000", 10);
const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/web/frontend/dist`
    : `${process.cwd()}/web/frontend/`;

console.log("--- DEBUG: Starting Shopify App Init ---");
console.log("SHOPIFY_APP_URL from env:", process.env.SHOPIFY_APP_URL);

const HOST_NAME = (process.env.SHOPIFY_APP_URL || "hashtopic-postback-shopify.onrender.com").replace(/^https?:\/\//, "");
console.log("Derived hostName:", HOST_NAME);

const shopify = shopifyApp({
  api: {
    apiVersion: ApiVersion.January24,
    restResources,
    billing: undefined,
  },
  hostName: HOST_NAME,
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
  sessionStorage: new SQLiteSessionStorage("./sessions.sqlite"),
});

const app = express();

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

app.get("/health", (req, res) => res.status(200).send("OK"));

app.get("/exitiframe", (req, res) => {
  const redirectUri = req.query.redirectUri;
  const sanitized = redirectUri ? decodeURIComponent(redirectUri) : "/";
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
        saveAccessToken(session.shop, session.accessToken);
        console.log(`[HT] Access token saved for ${session.shop}`);

        // Auto-enable the Click ID Capture app embed in the active theme
        enableClickIdEmbed(session.shop, session.accessToken).catch((err) =>
          console.error("[HT] Failed to auto-enable app embed:", err.message)
        );
      }
    } catch (err) {
      console.error("[HT] Error saving access token:", err.message);
    }
    next();
  },
  shopify.redirectToShopifyOrAppRoot()
);

/**
 * Programmatically activates the Click ID Capture app embed block in the
 * merchant's currently-active theme by patching config/settings_data.json.
 *
 * Block type URL format:
 *   shopify://apps/{app-handle}/blocks/{block-handle}
 *
 * Replace APP_HANDLE below with your app's handle from the Partners dashboard
 * (Partners → Apps → your app → "App handle" field, e.g. "hashtopic-postback").
 */
async function enableClickIdEmbed(shop, accessToken) {
  const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "hashtopic-postback-4";
  const BLOCK_HANDLE = "click-id-capture";
  const API_VERSION = "2024-01";
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
    console.warn("[HT] No active theme found for", shop);
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
    console.log(`[HT] App embed already enabled for ${shop}`);
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
  console.log(`[HT] App embed enabled in theme "${activeTheme.name}" for ${shop}`);
}

// Webhook route — handled manually
app.post(shopify.config.webhooks.path, express.text({ type: "*/*" }), async (req, res) => {
  const topic = req.headers["x-shopify-topic"];
  const shop = req.headers["x-shopify-shop-domain"];
  try {
    if (topic === "orders/paid") {
      await webhookHandlers.ordersPaid(topic, shop, req.body);
    } else if (topic === "orders/updated") {
      await webhookHandlers.ordersUpdated(topic, shop, req.body);
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("[HT] Webhook route error:", err);
    res.status(500).send("Error");
  }
});

// Public pixel script
app.use("/pixel", pixelScriptRouter);

// Parse JSON body
app.use(express.json());

// Custom session middleware — extracts shop from Shopify JWT token
app.use("/api/*", (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace("Bearer ", "");
    if (token) {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      const dest = payload.dest || "";
      const shop = dest.replace("https://", "");
      if (shop) {
        res.locals.shopify = { session: { shop } };
        return next();
      }
    }
  } catch (e) {}

  const shop = req.headers["x-shopify-shop"] || req.query.shop;
  if (shop) {
    res.locals.shopify = { session: { shop } };
    return next();
  }

  res.status(403).json({ error: "No shop identified" });
});

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
  console.log(`HashTopic Postback app listening on port ${PORT}`);
  startRetryWorker();
});

export default shopify;
