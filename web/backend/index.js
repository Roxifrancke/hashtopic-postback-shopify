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
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

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
  sessionStorage: new SQLiteSessionStorage(":memory:"),
});

// NOTE: No addHandlers() call here — that caused DeliveryMethod version conflicts.
// Webhook subscriptions are registered via shopify.app.toml instead.
// We handle incoming webhooks manually in the route below.

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
        <meta http-equiv="refresh" content="0;url=${sanitized}" />
      </head>
      <body>
        <script>window.top.location.href = ${JSON.stringify(sanitized)};</script>
        <p>Redirecting...</p>
      </body>
    </html>
  `);
});

// Shopify auth routes
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);

// Webhook route — handled manually to avoid DeliveryMethod version conflicts
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

// Authenticated API routes
app.use("/api/*", shopify.validateAuthenticatedSession());
app.use(express.json());

app.use("/api/settings", settingsRouter(shopify));
app.use("/api/deliveries", deliveriesRouter(shopify));

// Serve frontend
app.use(shopify.cspHeaders());
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
