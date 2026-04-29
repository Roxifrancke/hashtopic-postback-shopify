import { Router } from "express";
import { getSettings } from "../db.js";

export const pixelScriptRouter = Router();

/**
 * GET /pixel/:shop/capture.js
 * Serves a shop-specific JavaScript snippet that captures click_id from URL
 * and stores it in a first-party cookie.
 * This is loaded by the Shopify theme via Script Tag or Web Pixel.
 */
pixelScriptRouter.get(["/capture.js", "/:shop/capture.js"], async (req, res) => {
  const shop =
    req.params.shop ||
    req.query.shop ||
    req.headers["x-shopify-shop-domain"];

  if (!shop || !shop.includes(".myshopify.com")) {
    return res.status(400).send("// Invalid shop");
  }

  const settings = await getSettings(shop);
  const paramNames = (settings?.param_names || "click_id")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cookieName = settings?.cookie_name || "click_id";
  const cookieDays = Math.min(365, Math.max(1, parseInt(settings?.cookie_days || 30, 10)));

  const script = generateCaptureScript(paramNames, cookieName, cookieDays);

res.set({
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=300",

  // 🔥 CRITICAL FIX
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Cross-Origin-Embedder-Policy": "unsafe-none",
  "Cross-Origin-Opener-Policy": "unsafe-none"
});
  res.send(script);
});

function generateCaptureScript(paramNames, cookieName, cookieDays) {
  return `
/* MyStorefront Postback — Click ID Capture v1.3.0
 *
 * v1.3 changes:
 *   - Inject hidden <input name="properties[click_id]"> into all product
 *     forms so click_id rides on line item properties (works for Buy It Now,
 *     Shop Pay, and any fast-checkout flow that bypasses the cart).
 *   - Persist click_id in localStorage in addition to the cookie (some
 *     embedded checkouts and PWAs scope cookies awkwardly).
 *   - MutationObserver re-injects when AJAX/quick-view/modal forms appear.
 *   - Cart attribute write retained as a backward-compatible fallback.
 */
(function() {
  'use strict';

  var PARAM_NAMES = ${JSON.stringify(paramNames)};
  var COOKIE_NAME = ${JSON.stringify(cookieName)};
  var COOKIE_DAYS = ${cookieDays};
  var STORAGE_KEY = 'mystorefront_click_id';
  var STORAGE_TS_KEY = 'mystorefront_click_id_ts';
  var EXPIRY_DAYS = 7;
  var FORM_INPUT_NAME = 'properties[click_id]';

  // ── Read sources ─────────────────────────────────────────────────────────

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

  function getLocalStorage() {
    try {
      var v = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
      return (v && v.trim()) ? v.trim() : null;
    } catch(e) { return null; }
  }

function setLocalStorage(value) {
  try {
    if (window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, value);
      window.localStorage.setItem(STORAGE_TS_KEY, Date.now().toString());
    }
  } catch(e) {}
}

  function getCookie(name) {
    try {
      var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    } catch(e) { return null; }
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

  /**
   * Resolve the active click_id from any persisted source.
   * URL is checked in run() and persisted before this is called, so this
   * just returns the most-recently-stored value across localStorage / cookie.
   */
function getStoredClickId() {
  try {
    var ts = window.localStorage && window.localStorage.getItem(STORAGE_TS_KEY);
    if (ts) {
      var age = Date.now() - parseInt(ts, 10);
      var maxAge = EXPIRY_DAYS * 24 * 60 * 60 * 1000;

      if (age > maxAge) {
        // expired → clear
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(STORAGE_TS_KEY);
        setCookie(COOKIE_NAME, '', -1);
        return null;
      }
    }
  } catch(e) {}

  return getLocalStorage() || getCookie(COOKIE_NAME);
}

  // ── Cart attribute write (backward-compatible fallback) ──────────────────

  /**
   * Write the click_id into the Shopify cart as a note attribute.
   * Retained for backward compatibility — line item properties are now the
   * primary attribution channel, but this still helps stores that have not
   * yet rolled out the form-injection path on every product template.
   */
  function writeToCart(clickId) {
    try {
      fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attributes: { 'click_id': clickId }
        })
      }).catch(function() {});
    } catch(e) {}
  }

  // ── Form injection (primary attribution channel) ─────────────────────────

  /**
   * Heuristic for "is this a Shopify product/add-to-cart form".
   * Matches the standard /cart/add action and the legacy product_form_*
   * pattern used by many themes. Falls back to forms with an explicit
   * data-product-form attribute.
   */
  function isProductForm(form) {
    if (!form || form.tagName !== 'FORM') return false;
    var action = (form.getAttribute('action') || '').toLowerCase();
    if (action.indexOf('/cart/add') !== -1) return true;
    if (form.hasAttribute('data-product-form')) return true;
    var id = form.id || '';
    if (/^product_form_/i.test(id)) return true;
    return false;
  }

  /**
   * Inject the hidden click_id input into a single form.
   *
   * Idempotent: if a properties[click_id] input already exists in the form
   * (whether placed by us, by the theme, or by another script), we do NOT
   * overwrite it. This protects custom merchant flows that may already be
   * setting click_id explicitly and means re-running injection is safe.
   */
  function injectIntoForm(form, clickId) {
    if (!form || !clickId) return;

    // Already has properties[click_id]? Don't touch it.
    var existing = form.querySelector('input[name="' + FORM_INPUT_NAME + '"]');
    if (existing) return;

    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = FORM_INPUT_NAME;
    input.value = clickId;
    input.setAttribute('data-mystorefront-postback', '1');
    form.appendChild(input);
  }

  function injectIntoAllForms(clickId) {
    if (!clickId) return;
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      if (isProductForm(forms[i])) injectIntoForm(forms[i], clickId);
    }
  }

  /**
   * Watch the DOM for new product forms (AJAX product pages, quick-view
   * modals, drawer carts that re-render product cards, etc.) and inject
   * into them as they appear.
   */
  function startMutationObserver() {
    if (typeof MutationObserver === 'undefined') return;

    var observer = new MutationObserver(function(mutations) {
      var clickId = getStoredClickId();
      if (!clickId) return;

      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        if (!added || !added.length) continue;

        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue; // ELEMENT_NODE only

          // The added node itself might be a product form…
          if (isProductForm(node)) {
            injectIntoForm(node, clickId);
          }
          // …or it might contain product forms (e.g. a modal wrapper).
          if (node.querySelectorAll) {
            var nested = node.querySelectorAll('form');
            for (var k = 0; k < nested.length; k++) {
              if (isProductForm(nested[k])) injectIntoForm(nested[k], clickId);
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Main flow ────────────────────────────────────────────────────────────

  function run() {
    // 1. URL → persist everywhere (URL always wins over stored value).
    var fromUrl = getUrlParam(PARAM_NAMES);
    var clickId = fromUrl;

    if (fromUrl) {
      setCookie(COOKIE_NAME, fromUrl, COOKIE_DAYS);
      setLocalStorage(fromUrl);
      writeToCart(fromUrl); // backward-compat fallback
    } else {
      // 2. No URL param — fall back to whatever we already have stored.
      clickId = getStoredClickId();
      if (clickId) {
        // Mirror across stores so a localStorage-only or cookie-only state
        // gets healed back into both.
        setLocalStorage(clickId);
        setCookie(COOKIE_NAME, clickId, COOKIE_DAYS);
        writeToCart(clickId); // backward-compat fallback
      }
    }

    // 3. Primary attribution channel: inject into every product form on the
    //    page right now, then watch for new ones. Safe even if clickId is
    //    falsy — both helpers no-op in that case.
    injectIntoAllForms(clickId);
    startMutationObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
`.trim();
}
