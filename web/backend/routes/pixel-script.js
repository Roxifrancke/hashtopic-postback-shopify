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
    // The storefront loads this script from a different origin, so it must be
    // fetchable cross-origin.
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cross-Origin-Embedder-Policy": "unsafe-none",
    "Cross-Origin-Opener-Policy": "unsafe-none",
  });
  res.send(script);
});

function generateCaptureScript(paramNames, cookieName, cookieDays) {
  return `
/* MyStorefront Postback — Click ID Capture v1.6.0
 *
 * v1.6 changes:
 *   - Capture the creator ref (ref) that arrives with a click_id and store
 *     it as cart attribute "MyStorefront creator" and hidden line item
 *     property "_MyStorefront creator" (so Buy It Now keeps it too).
 *     A new click with no ref clears the old one.
 *
 * v1.5 changes:
 *   - Respect an explicit "do not track" decision via Shopify's Customer
 *     Privacy API (proceeds when the API is absent or the shopper is undecided).
 *   - Write the cart attribute at most once per session (was: every page load)
 *     so themes that re-render the cart drawer don't flash/reopen it.
 *   - Attribution window now follows the merchant's configured cookie_days
 *     instead of a hard-coded 7 days.
 *   - MutationObserver reuses the resolved click_id instead of re-reading
 *     storage on every DOM mutation.
 *
 * v1.4 changes:
 *   - Rename storefront-set names to be MyStorefront-branded in admin:
 *       line item:  properties[_MyStorefront click_id]   (underscore hides
 *                                                          from cart/checkout)
 *       cart attr:  attributes['MyStorefront click_id']  (admin only)
 *     The cookie, URL param, and outbound postback payload field all stay
 *     as plain "click_id" — only the admin display labels change.
 *
 * v1.3 (still in effect):
 *   - Inject hidden line-item input on every product form so attribution
 *     survives Buy It Now / Shop Pay / fast-checkout flows that bypass the
 *     cart.
 *   - Persist click_id in localStorage in addition to the cookie.
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
  var EXPIRY_DAYS = COOKIE_DAYS; // attribution window follows merchant config
  // Line item property: leading underscore hides from cart/checkout/customer
  // emails (Shopify convention). Admin still shows it under each line item.
  var LINE_ITEM_PROP_NAME = '_MyStorefront click_id';
  var FORM_INPUT_NAME = 'properties[' + LINE_ITEM_PROP_NAME + ']';
  // Cart attribute → order note_attribute. No underscore needed: cart attrs
  // are not rendered in cart/checkout by default. Admin shows it under
  // "Additional details".
  var CART_ATTR_NAME = 'MyStorefront click_id';
  // sessionStorage flag so the cart attribute is written at most once per
  // session instead of on every page load (repeated /cart/update.js writes
  // make some themes re-render or flash the cart drawer as the shopper browses).
  var CART_WRITE_FLAG = 'mystorefront_cart_written_private_v2';

  // Creator ref. Only read from a URL that also carries a click_id, so an
  // unrelated ref param from another site can never tag a cart.
  var CREATOR_PARAM = 'ref';
  var CREATOR_STORAGE_KEY = 'mystorefront_creator_ref';
  var CREATOR_LINE_PROP = '_MyStorefront creator';
  var CREATOR_FORM_INPUT = 'properties[' + CREATOR_LINE_PROP + ']';
  var CREATOR_ATTR_NAME = 'MyStorefront creator';
  var CREATOR_REF_RE = /^[A-Za-z0-9._-]{1,64}$/;

  function getCreatorFromUrl() {
    try {
      var v = new URLSearchParams(window.location.search).get(CREATOR_PARAM);
      v = v ? v.trim() : '';
      return CREATOR_REF_RE.test(v) ? v : null;
    } catch(e) { return null; }
  }

  function getStoredCreator() {
    try {
      var v = window.localStorage && window.localStorage.getItem(CREATOR_STORAGE_KEY);
      return v && CREATOR_REF_RE.test(v) ? v : null;
    } catch(e) { return null; }
  }

  function setStoredCreator(value) {
    try {
      if (!window.localStorage) return;
      if (value) window.localStorage.setItem(CREATOR_STORAGE_KEY, value);
      else window.localStorage.removeItem(CREATOR_STORAGE_KEY);
    } catch(e) {}
  }

  // ── Consent ──────────────────────────────────────────────────────────────
  // Respect an explicit decline via Shopify's Customer Privacy API. When the
  // API is absent or the shopper hasn't decided we proceed — the click_id is
  // first-party data for an affiliate visit the shopper initiated.
  function trackingAllowed() {
    try {
      var cp = window.Shopify && window.Shopify.customerPrivacy;
      if (cp && typeof cp.getTrackingConsent === 'function') {
        return cp.getTrackingConsent() !== 'no';
      }
    } catch (e) {}
    return true;
  }

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

function setLocalStorage(value, timestamp) {
  try {
    if (window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, value);
      window.localStorage.setItem(STORAGE_TS_KEY, String(timestamp));
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

      if (!Number.isFinite(age) || age < -60000 || age >= maxAge) {
        // expired → clear
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(STORAGE_TS_KEY);
        setCookie(COOKIE_NAME, '', -1);
        window.localStorage.removeItem(CREATOR_STORAGE_KEY);
        return null;
      }
    }
  } catch(e) {}

  // An old cookie without a timestamp cannot establish a reliable 30-day window.
  // Newly recorded referrals always contain a timestamp.
  return ts ? (getLocalStorage() || getCookie(COOKIE_NAME)) : null;
}

  // ── Cart attribute write (backward-compatible fallback) ──────────────────

  /**
   * Write the click_id into the Shopify cart as a note attribute.
   * Retained for backward compatibility — line item properties are now the
   * primary attribution channel, but this still helps stores that have not
   * yet rolled out the form-injection path on every product template.
   */
  function writeToCart(clickId, creatorRef) {
    try {
      var ss = null;
      try { ss = window.sessionStorage; } catch (e) {}
      // Skip if this exact click_id + creator pair is already on the cart this session.
      var flag = clickId + '|' + (creatorRef || '');
      if (ss) {
        try { if (ss.getItem(CART_WRITE_FLAG) === flag) return; } catch (e) {}
      }
      var attrs = {};
      attrs[CART_ATTR_NAME] = clickId;
      // An empty value removes a creator ref left over from an earlier click.
      attrs[CREATOR_ATTR_NAME] = creatorRef || '';
      // Clear the private-name attributes from the short-lived __ version.
      attrs['__MyStorefront click_id'] = '';
      attrs['__MyStorefront Creator Referral'] = '';
      fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributes: attrs })
      }).catch(function() {});
      if (ss) {
        try { ss.setItem(CART_WRITE_FLAG, flag); } catch (e) {}
      }
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
  function injectIntoForm(form, clickId, creatorRef) {
    if (!form || !clickId) return;

    // Already has properties[click_id]? Don't touch it.
    if (!form.querySelector('input[name="' + FORM_INPUT_NAME + '"]')) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = FORM_INPUT_NAME;
      input.value = clickId;
      input.setAttribute('data-mystorefront-postback', '1');
      form.appendChild(input);
    }

    if (!creatorRef) return;
    var existingCreator = form.querySelector('input[name="' + CREATOR_FORM_INPUT + '"]');
    if (existingCreator) {
      // Only refresh an input we placed ourselves.
      if (existingCreator.hasAttribute('data-mystorefront-postback')) existingCreator.value = creatorRef;
      return;
    }
    var creatorInput = document.createElement('input');
    creatorInput.type = 'hidden';
    creatorInput.name = CREATOR_FORM_INPUT;
    creatorInput.value = creatorRef;
    creatorInput.setAttribute('data-mystorefront-postback', '1');
    form.appendChild(creatorInput);
  }

  function injectIntoAllForms(clickId, creatorRef) {
    if (!clickId) return;
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      if (isProductForm(forms[i])) injectIntoForm(forms[i], clickId, creatorRef);
    }
  }

  /**
   * Watch the DOM for new product forms (AJAX product pages, quick-view
   * modals, drawer carts that re-render product cards, etc.) and inject
   * into them as they appear.
   */
  function startMutationObserver(clickId, creatorRef) {
    if (typeof MutationObserver === 'undefined' || !clickId) return;

    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        if (!added || !added.length) continue;

        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue; // ELEMENT_NODE only

          if (isProductForm(node)) {
            injectIntoForm(node, clickId, creatorRef);
          }
          if (node.querySelectorAll) {
            var nested = node.querySelectorAll('form');
            for (var k = 0; k < nested.length; k++) {
              if (isProductForm(nested[k])) injectIntoForm(nested[k], clickId, creatorRef);
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Hide our item notes on older themes ──────────────────────────────────
  // Current themes skip line item properties starting with "_". Some older
  // themes print every property, so hide just the rows that contain nothing
  // but our MyStorefront notes. Display only: tracking is unaffected.
  var MS_ROW_RE = /_*MyStorefront (?:click_id|Creator Referral|creator)\\s*:?\\s*[A-Za-z0-9._-]*/g;

  function onlyOurText(el) {
    var t = (el.textContent || '').replace(MS_ROW_RE, '');
    return t.replace(/[\\s:]/g, '') === '';
  }

  function hideOurLines(scope) {
    try {
      if (!scope || typeof document.createTreeWalker !== 'function') return;
      var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
      var hits = [];
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.indexOf('MyStorefront ') !== -1) hits.push(node);
      }
      for (var i = 0; i < hits.length; i++) {
        var el = hits[i].parentElement;
        if (!el || (el.closest && el.closest('script,style,noscript,textarea'))) continue;
        var target = null;
        var cur = el;
        for (var d = 0; d < 6 && cur && cur !== document.body; d++) {
          if (onlyOurText(cur)) { target = cur; cur = cur.parentElement; } else break;
        }
        if (target) target.style.display = 'none';
      }
    } catch (e) {}
  }

  function startHider() {
    hideOurLines(document.body);
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    // Runs before the browser paints, so new cart rows are hidden before they show.
    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'characterData') {
          if (m.target && m.target.parentElement) hideOurLines(m.target.parentElement);
          continue;
        }
        var added = m.addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1) hideOurLines(n);
          else if (n.nodeType === 3 && n.parentElement) hideOurLines(n.parentElement);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── Main flow ────────────────────────────────────────────────────────────

  function run() {
    // Respect an explicit "do not track" decision before touching storage.
    if (!trackingAllowed()) return;

    // 1. URL → persist everywhere (URL always wins over stored value).
    var fromUrl = getUrlParam(PARAM_NAMES);
    var clickId = fromUrl || getStoredClickId();
    var timestamp = fromUrl ? Date.now() : Number((function() {
      try { return window.localStorage.getItem(STORAGE_TS_KEY); } catch(e) { return null; }
    })());

    if (fromUrl) {
      setCookie(COOKIE_NAME, fromUrl, COOKIE_DAYS);
      setLocalStorage(fromUrl, timestamp);
      // A new click replaces the creator ref. A link without one clears it.
      setStoredCreator(getCreatorFromUrl());
    } else if (clickId) {
      // Heal a localStorage-only or cookie-only state back into both.
      var remaining = Math.max(0, COOKIE_DAYS - (Date.now() - timestamp) / 864e5);
      setLocalStorage(clickId, timestamp);
      setCookie(COOKIE_NAME, clickId, remaining);
    }

    // Nothing to attribute → no cart write, no form injection, no observer.
    if (!clickId) {
      setStoredCreator(null);
      return;
    }

    var creatorRef = getStoredCreator();
    writeToCart(clickId, creatorRef);          // backward-compat fallback (once per session)
    injectIntoAllForms(clickId, creatorRef);   // primary attribution channel
    startMutationObserver(clickId, creatorRef);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
    document.addEventListener('DOMContentLoaded', startHider);
  } else {
    run();
    startHider();
  }

  // Re-run if the shopper grants consent after the initial load.
  try {
    document.addEventListener('visitorConsentCollected', function () { run(); });
  } catch (e) {}
})();
`.trim();
}
