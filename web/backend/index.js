import "dotenv/config";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { join } from "path";
import { readFileSync } from "fs";
import { shopifyApp } from "@shopify/shopify-app-express";
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";
import { ApiVersion, DeliveryMethod } from "@shopify/shopify-api";
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

// DIAGNOSTIC LOG: This will tell us if Render is actually using your new code
console.log("--- DEBUG: Starting Shopify App Init ---");
console.log("SHOPIFY_APP_URL from env:", process.env.SHOPIFY_APP_URL);

const shopify = shopifyApp({
  api: {
    apiVersion: ApiVersion.January24,
    restResources, // Change this from {} to restResources
    billing: undefined,
  },
  hostName: "hashtopic-postback.onrender.com",
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
  sessionStorage: new SQLiteSessionStorage(
    join(process.cwd(), "database.sqlite")
  ),
});

// Register webhook topics
shopify.api.webhooks.addHandlers({
  ORDERS_PAID: [
    {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/api/webhooks",
      callback: webhookHandlers.ordersPaid,
    },
  ],
  ORDERS_UPDATED: [
    {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/api/webhooks",
      callback: webhookHandlers.ordersUpdated,
    },
  ],
});

const app = express();

app.use(morgan("combined"));
app.use(compression());

// CSP adjustments for embedded app
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// --- ADD THIS HERE (Line 79) ---
app.get("/health", (req, res) => res.status(200).send("OK"));

// Shopify auth middleware
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  express.text({ type: '*/*' }), // Required for webhook signature verification
  shopify.processWebhooks({ webhookHandlers: shopify.api.webhooks })
);

// Public pixel script endpoint (no auth required)
app.use("/pixel", pixelScriptRouter);

// Authenticated API routes
app.use("/api/*", shopify.validateAuthenticatedSession());
app.use(express.json());

app.use("/api/settings", settingsRouter(shopify));
app.use("/api/deliveries", deliveriesRouter(shopify));

// Serve frontend
app.use(shopify.cspHeaders());
app.use(express.static(STATIC_PATH, { index: false }));
app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res) => {
  return res.set("Content-Type", "text/html").send(
    readFileSync(join(STATIC_PATH, "index.html"))
  );
});

app.listen(PORT, () => {
  console.log(`HashTopic Postback app listening on port ${PORT}`);
  startRetryWorker();
});

export default shopify;
