import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AppProvider } from "@shopify/polaris";
import { Provider as AppBridgeProvider } from "@shopify/app-bridge-react";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import App from "./App";

const apiKey = process.env.SHOPIFY_API_KEY || "";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppBridgeProvider config={{ apiKey, host: new URLSearchParams(location.search).get("host") || "", forceRedirect: true }}>
      <AppProvider i18n={enTranslations}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AppProvider>
    </AppBridgeProvider>
  </React.StrictMode>
);
