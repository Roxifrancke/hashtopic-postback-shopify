import { Router } from "express";
import { getSettings } from "../db.js";

export const pixelScriptRouter = Router();

/**
 * GET /pixel/:shop/capture.js
 * Serves a shop-specific JavaScript snippet that captures click_id from URL
 * and stores it in a first-party cookie.
 * This is loaded by the Shopify theme via Script Tag or Web Pixel.
 */
pixelScriptRouter.get("/:shop/capture.js", async (req, res) => {
  const shop = req.params.shop;
  if (!shop || !shop.includes(".myshopify.com")) {
    return res.status(400).send("// Invalid shop");
  }

  const settings = await getSettings(shop);
  const paramNames = (settings?.param_names || "click_id")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cookieName = settings?.cookie_name || "_ht_click_id";
  const cookieDays = Math.min(365, Math.max(1, parseInt(settings?.cookie_days || 30, 10)));

  const script = generateCaptureScript(paramNames, cookieName, cookieDays);

  res.set({
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
  res.send(script);
});

function generateCaptureScript(paramNames, cookieName, cookieDays) {
  return `
/* MyStorefront Postback — Click ID Capture v1.1.0 */
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
      var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    } catch(e) { return null; }
  }

  /**
   * Write the click_id into the Shopify cart as a note attribute.
   * This ensures it appears in order.note_attributes when the order is created,
   * so the postback sender can read it — even if the cookie isn't accessible
   * server-side (which it isn't in Shopify's architecture).
   */
  function writeToCart(clickId) {
    try {
      fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attributes: { '_ht_click_id': clickId }
        })
      }).catch(function() {});
    } catch(e) {}
  }

  function run() {
    // 1. Capture from URL (priority — overrides existing cookie)
    var fromUrl = getUrlParam(PARAM_NAMES);
    if (fromUrl) {
      setCookie(COOKIE_NAME, fromUrl, COOKIE_DAYS);
      writeToCart(fromUrl);
      return;
    }

    // 2. No URL param — check for existing cookie and re-write to cart
    // (handles case where shopper returns on a subsequent page load)
    var fromCookie = getCookie(COOKIE_NAME);
    if (fromCookie) {
      writeToCart(fromCookie);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
`.trim();
}
