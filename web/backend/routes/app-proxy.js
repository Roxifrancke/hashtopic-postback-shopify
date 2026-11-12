import { Router } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { getSettings } from "../db.js";

// Shopify app proxy: store.com/apps/mystorefront/r?click_id=...&ref=...&to=/path
// A tiny page on the store's own domain that tags the cart with the click and
// creator, then sends the shopper on. Works with no theme embed switched on.

const CLICK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function verifyProxySignature(query, secret) {
  if (!secret || !query || typeof query.signature !== "string") return false;
  const { signature, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("");
  const digest = createHmac("sha256", secret).update(message).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Only same-store relative paths, never another site.
export function safeDestination(to, clickId, ref) {
  let path = typeof to === "string" ? to.trim() : "";
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) path = "/";
  let u;
  try {
    u = new URL(path, "https://store.invalid");
  } catch {
    u = new URL("/", "https://store.invalid");
  }
  if (u.host !== "store.invalid") u = new URL("/", "https://store.invalid");
  u.searchParams.set("click_id", clickId);
  if (ref) u.searchParams.set("ref", ref);
  return u.pathname + u.search + u.hash;
}

const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

export function appProxyRouter() {
  const router = Router();

  router.get("/r", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!verifyProxySignature(req.query, process.env.SHOPIFY_API_SECRET || "")) {
      return res.status(401).type("text/plain").send("Unauthorized");
    }

    const clickId = String(req.query.click_id || "");
    const refRaw = String(req.query.ref || "").trim();
    const ref = REF_RE.test(refRaw) ? refRaw : "";

    if (!CLICK_ID_RE.test(clickId)) {
      // Nothing to tag. Just continue to the store.
      return res.redirect(302, safeDestination(req.query.to, "", "").split("?")[0] || "/");
    }

    const settings = await getSettings(String(req.query.shop || "")).catch(() => null);
    const cookieName = settings?.cookie_name || "click_id";
    const cookieDays = Math.min(365, Math.max(1, parseInt(settings?.cookie_days || 30, 10)));
    const dest = safeDestination(req.query.to, clickId, ref);

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Loading…</title></head>
<body style="font-family:sans-serif;text-align:center;padding-top:20vh;color:#555">
<p>Loading…</p>
<noscript><a href=${js(dest)}>Continue</a></noscript>
<script>
(function(){
  var C=${js(clickId)}, R=${js(ref)}, D=${js(dest)}, CN=${js(cookieName)}, DAYS=${cookieDays};
  try {
    localStorage.setItem('mystorefront_click_id', C);
    localStorage.setItem('mystorefront_click_id_ts', String(Date.now()));
    if (R) localStorage.setItem('mystorefront_creator_ref', R); else localStorage.removeItem('mystorefront_creator_ref');
  } catch (e) {}
  try {
    var exp = new Date(Date.now() + DAYS * 864e5).toUTCString();
    document.cookie = CN + '=' + encodeURIComponent(C) + '; expires=' + exp + '; path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  } catch (e) {}
  try { sessionStorage.setItem('mystorefront_cart_written', C + '|' + (R || '')); } catch (e) {}
  var done = false;
  function go(){ if (done) return; done = true; location.replace(D); }
  try {
    fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: { 'MyStorefront click_id': C, 'MyStorefront creator': R || '' } })
    }).then(go, go);
  } catch (e) { go(); }
  setTimeout(go, 1500);
})();
</script>
</body></html>`;

    return res.status(200).type("text/html").send(html);
  });

  return router;
}
