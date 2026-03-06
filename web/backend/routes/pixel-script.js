import { Router } from "express";
import { getSettings } from "../db.js";

export const pixelScriptRouter = Router();

/**
 * GET /pixel/:shop/capture.js
 * Serves a shop-specific JavaScript snippet that captures click_id from URL
 * and stores it in a first-party cookie.
 * This is loaded by the Shopify theme via Script Tag or Web Pixel.
 */
pixelScriptRouter.get("/:shop/capture.js", (req, res) => {
  const shop = req.params.shop;
  if (!shop || !shop.includes(".myshopify.com")) {
    return res.status(400).send("// Invalid shop");
  }

  const settings = getSettings(shop);
  const paramNames = (settings?.param_names || "click_id")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cookieName = settings?.cookie_name || "_ht_click_id";
  const cookieDays = parseInt(settings?.cookie_days || 30, 10);

  const script = generateCaptureScript(paramNames, cookieName, cookieDays);

  res.set({
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
  res.send(script);
});

function generateCaptureScript(paramNames, cookieName, cookieDays) {
  return `
/* HashTopic Postback — Click ID Capture v1.0.0 */
(function() {
  'use strict';

  var PARAM_NAMES = ${JSON.stringify(paramNames)};
  var COOKIE_NAME = ${JSON.stringify(cookieName)};
  var COOKIE_DAYS = ${cookieDays};

  function getUrlParam(names) {
    try {
      var params = new URLSearchParams(window.location.search);
      for (var i = 0; i < names.length; i++) {
        var val = params.get(names[i]);
        if (val && val.trim()) return val.trim();
      }
    } catch(e) {}
    return null;
  }

  function setCookie(name, value, days) {
    try {
      var expires = new Date(Date.now() + days * 864e5).toUTCString();
      var secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = name + '=' + encodeURIComponent(value) +
        '; expires=' + expires +
        '; path=/' +
        '; SameSite=Lax' +
        secure;
    } catch(e) {}
  }

  function getCookie(name) {
    try {
      var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    } catch(e) { return null; }
  }

  function run() {
    // Capture from URL (priority)
    var fromUrl = getUrlParam(PARAM_NAMES);
    if (fromUrl) {
      setCookie(COOKIE_NAME, fromUrl, COOKIE_DAYS);
      return;
    }
    // Otherwise read existing cookie (no action needed)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
`.trim();
}
