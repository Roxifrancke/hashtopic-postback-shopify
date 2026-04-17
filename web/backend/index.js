import "dotenv/config";

const dbUrl = process.env.DATABASE_URL || "";
const isLocal = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");
if (!isLocal && !process.env.PGSSLMODE) {
  process.env.PGSSLMODE = "require";
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
    path: "/api/webhooks",
  },
  sessionStorage: new PostgreSQLSessionStorage(process.env.DATABASE_URL),
});

const app = express();

app.use(cors({ origin: "*", methods: ["GET","POST","PATCH","DELETE","OPTIONS"] }));
app.options("*", (_, res) => res.sendStatus(200));

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
app.use("/api/webhooks/gdpr", gdprRouter);

app.get("/health", (_, res) => res.status(200).send("OK"));

/* ---------------- AUTH ---------------- */

app.get(shopify.config.auth.path, shopify.auth.begin());

app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  async (req, res, next) => {
    try {
      const session = res.locals.shopify?.session;

      if (session?.shop && session?.accessToken) {
        const { saveAccessToken } = await import("./db.js");
        await saveAccessToken(session.shop, session.accessToken);
        console.log(`[MS] Access token saved for ${session.shop}`);

        // ✅ REGISTER WEBHOOK
        await registerWebhooks(session.shop, session.accessToken);
      }
    } catch (err) {
      console.error("[MS] OAuth error:", err.message);
    }

    next();
  },
  shopify.redirectToShopifyOrAppRoot()
);

/* ---------------- WEBHOOK REGISTRATION ---------------- */

async function registerWebhooks(shop, accessToken) {
  try {
    const res = await fetch(`https://${shop}/admin/api/2025-04/webhooks.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        webhook: {
          topic: "orders/paid",
          address: "https://hashtopic-postback-shopify.onrender.com/api/webhooks",
          format: "json",
        },
      }),
    });

    const data = await res.text();
    console.log("✅ Webhook registered:", data);
  } catch (err) {
    console.error("❌ Webhook registration failed:", err.message);
  }
}

/* ---------------- WEBHOOK RECEIVER ---------------- */

app.post(
  shopify.config.webhooks.path,
  express.text({ type: "*/*" }),
  async (req, res) => {
    console.log("🔥 WEBHOOK HIT:", req.headers["x-shopify-topic"]);

    const topic = req.headers["x-shopify-topic"];
    const shop = req.headers["x-shopify-shop-domain"];
    const hmac = req.headers["x-shopify-hmac-sha256"];

    if (!hmac || !process.env.SHOPIFY_API_SECRET) {
      return res.status(401).send("Unauthorized");
    }

    try {
      if (topic === "orders/paid") {
        await webhookHandlers.ordersPaid(topic, shop, req.body);
      }
      res.status(200).send("OK");
    } catch (err) {
      console.error("[MS] Webhook error:", err);
      res.status(500).send("Error");
    }
  }
);

/* ---------------- OTHER ROUTES ---------------- */

app.use("/pixel", pixelScriptRouter);
app.use(express.json());

app.get("/api/settings/ping", async (req, res) => {
  const shop = req.query.shop;
  const settings = await getSettings(shop);

  const storedKey = settings?.mystorefront_api_key || "";
  const providedKey = req.headers["x-mystorefront-key"] || "";

  let match = false;
  try {
    match = timingSafeEqual(Buffer.from(storedKey), Buffer.from(providedKey));
  } catch {}

  if (!match) return res.status(401).json({ error: "Invalid key" });

  res.json({ ok: true });
});

app.use("/api/discount-codes", discountCodesRouter());
app.use("/api/settings", settingsRouter(shopify));
app.use("/api/deliveries", deliveriesRouter(shopify));

app.use(express.static(STATIC_PATH, { index: false }));

app.use("/*", (_, res) => {
  res.set("Content-Type", "text/html").send(
    readFileSync(join(STATIC_PATH, "index.html"))
  );
});

app.listen(PORT, () => {
  console.log(`🚀 App running on port ${PORT}`);
  startRetryWorker();
});

export default shopify;