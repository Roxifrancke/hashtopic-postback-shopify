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

const shopify = shopifyApp({
  api: {
    apiVersion: ApiVersion.January24,
    restResources: {},
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
shopify.webhooks.addHandlers({
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

// Shopify auth middleware
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: shopify.webhooks })
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
