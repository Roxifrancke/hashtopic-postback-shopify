// Tests for the v1.3 storefront capture script (extensions side).
//
// The script runs inside merchant storefronts, so a regression here silently
// loses attribution — these tests build a tiny DOM/window/document harness
// in pure Node (no jsdom) and exercise the actual generated source so we
// catch problems before they ship.
//
// Run with: npm test  (uses Node's built-in test runner)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Pull generateCaptureScript out of the route file without booting Express ─
//
// The route file imports express, which we don't want to instantiate in a
// unit test. Instead we read the source, slice out the generator function,
// and eval it in isolation. This is intentionally low-tech — no transpilers,
// no extra deps.

const __dirname = dirname(fileURLToPath(import.meta.url));
const routeSrc = readFileSync(
  join(__dirname, "..", "backend", "routes", "pixel-script.js"),
  "utf8"
);

const fnStart = routeSrc.indexOf("function generateCaptureScript");
assert.ok(fnStart !== -1, "Could not locate generateCaptureScript in source");
const fnSource = routeSrc.slice(fnStart);
// eslint-disable-next-line no-new-func
const generateCaptureScript = new Function(
  fnSource + "\nreturn generateCaptureScript;"
)();

// ── Minimal browser harness ─────────────────────────────────────────────────
//
// We don't need jsdom — only the surface area the capture script touches:
//   - window.location, window.localStorage
//   - document.cookie, document.readyState, document.body
//   - document.createElement / querySelector / querySelectorAll
//   - MutationObserver
//   - fetch, URLSearchParams, setTimeout
//
// Building it by hand keeps the test fast and avoids the dep entirely.

function makeElement(tagName) {
  const tag = tagName.toUpperCase();
  const el = {
    tagName: tag,
    nodeType: 1,
    children: [],
    parentNode: null,
    attributes: {},
    id: "",
    type: "",
    name: "",
    value: "",
    getAttribute(name) {
      // id/name/type/value are stored as own props, others in attributes.
      if (name === "id") return this.id || null;
      if (name === "name") return this.name || null;
      if (name === "type") return this.type || null;
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    setAttribute(name, value) {
      if (name === "id") this.id = value;
      else if (name === "name") this.name = value;
      else if (name === "type") this.type = value;
      else this.attributes[name] = value;
    },
    hasAttribute(name) {
      if (name === "id") return Boolean(this.id);
      if (name === "name") return Boolean(this.name);
      if (name === "type") return Boolean(this.type);
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      // Fire mutation observers attached to ancestors.
      let p = this;
      while (p) {
        if (p._observers) {
          for (const obs of p._observers) {
            obs._queue.push({ addedNodes: [child] });
          }
        }
        p = p.parentNode;
      }
      return child;
    },
    querySelector(selector) {
      return runSelectorAll(this, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return runSelectorAll(this, selector);
    },
  };
  return el;
}

// Tiny selector engine — supports: tag, [name="value"], 'form'.
function runSelectorAll(root, selector) {
  const out = [];
  const matchers = parseSelector(selector);
  function visit(node) {
    if (node.nodeType === 1 && matchers.every((m) => m(node))) {
      out.push(node);
    }
    if (node.children) for (const c of node.children) visit(c);
  }
  if (root.children) for (const c of root.children) visit(c);
  return out;
}

function parseSelector(selector) {
  const matchers = [];
  // Tag prefix (e.g. "form", "input").
  const tagMatch = selector.match(/^([a-z]+)/i);
  if (tagMatch) {
    const tag = tagMatch[1].toUpperCase();
    matchers.push((n) => n.tagName === tag);
    selector = selector.slice(tagMatch[0].length);
  }
  // Attribute selectors: [name="value"]  (only the form we use)
  const attrRegex = /\[([a-z_-]+)="([^"]*)"\]/gi;
  let m;
  while ((m = attrRegex.exec(selector)) !== null) {
    const attr = m[1];
    const val = m[2];
    matchers.push((n) => n.getAttribute(attr) === val);
  }
  return matchers;
}

function makeBrowserEnv({ url = "https://shop.example.com/products/test", cookie = "" } = {}) {
  const body = makeElement("body");
  const head = makeElement("head");
  body._observers = [];

  const localStorageStore = {};

  const env = {
    window: {
      location: parseUrl(url),
      localStorage: {
        getItem: (k) => (k in localStorageStore ? localStorageStore[k] : null),
        setItem: (k, v) => {
          localStorageStore[k] = String(v);
        },
        removeItem: (k) => {
          delete localStorageStore[k];
        },
      },
    },
    document: {
      readyState: "complete",
      cookie: cookie,
      body,
      head,
      documentElement: makeElement("html"),
      createElement: (tag) => makeElement(tag),
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      addEventListener: () => {},
    },
    fetch: () => Promise.resolve({ ok: true }), // no-op
    setTimeout,
    URLSearchParams,
    location: null, // overwritten below
    MutationObserver: class {
      constructor(cb) {
        this._cb = cb;
        this._queue = [];
        this._target = null;
      }
      observe(target) {
        this._target = target;
        target._observers = target._observers || [];
        target._observers.push(this);
      }
      // Test helper: process queued mutations synchronously.
      _flush() {
        if (this._queue.length) {
          const batch = this._queue;
          this._queue = [];
          this._cb(batch);
        }
      }
    },
    _localStorageStore: localStorageStore,
  };
  env.location = env.window.location;
  return env;
}

function parseUrl(url) {
  const u = new URL(url);
  return {
    href: u.href,
    protocol: u.protocol,
    host: u.host,
    pathname: u.pathname,
    search: u.search,
  };
}

function runCaptureScript(env) {
  const script = generateCaptureScript(["click_id"], "click_id", 30);
  // Run inside an isolated function so the script's IIFE picks up our env
  // rather than Node globals.
  const runner = new Function(
    "window",
    "document",
    "fetch",
    "location",
    "URLSearchParams",
    "setTimeout",
    "MutationObserver",
    script
  );
  runner(
    env.window,
    env.document,
    env.fetch,
    env.location,
    env.URLSearchParams,
    env.setTimeout,
    env.MutationObserver
  );
}

function flushObservers(env) {
  const observers = env.document.body._observers || [];
  for (const obs of observers) obs._flush();
}

function makeProductForm(doc, { id = "", action = "/cart/add" } = {}) {
  const form = doc.createElement("form");
  if (action) form.setAttribute("action", action);
  if (id) form.id = id;
  doc.body.appendChild(form);
  return form;
}

// ── Tests: form injection from URL param ────────────────────────────────────

test("capture script — injects hidden input into product form when click_id in URL", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=urlclick" });
  const form = makeProductForm(env.document);

  runCaptureScript(env);

  const inputs = form.querySelectorAll('input[name="properties[click_id]"]');
  assert.equal(inputs.length, 1, "exactly one hidden input should be injected");
  assert.equal(inputs[0].value, "urlclick");
  assert.equal(inputs[0].type, "hidden");
});

test("capture script — persists URL click_id to localStorage", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=storeme" });
  makeProductForm(env.document);

  runCaptureScript(env);

  assert.equal(env._localStorageStore.mystorefront_click_id, "storeme");
});

// ── Tests: localStorage fallback when URL param absent ──────────────────────

test("capture script — uses localStorage when URL param absent", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x" });
  env.window.localStorage.setItem("mystorefront_click_id", "from_storage");
  const form = makeProductForm(env.document);

  runCaptureScript(env);

  const input = form.querySelector('input[name="properties[click_id]"]');
  assert.ok(input, "input should be injected from localStorage value");
  assert.equal(input.value, "from_storage");
});

test("capture script — does nothing when no URL param and no stored click_id", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x" });
  const form = makeProductForm(env.document);

  runCaptureScript(env);

  const inputs = form.querySelectorAll('input[name="properties[click_id]"]');
  assert.equal(inputs.length, 0, "no injection when nothing to attribute");
});

// ── Tests: idempotency / no overwrite ───────────────────────────────────────

test("capture script — does not overwrite existing properties[click_id] input", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=urlclick" });
  const form = makeProductForm(env.document);
  // Theme or another script already placed one — must be preserved.
  const existing = env.document.createElement("input");
  existing.type = "hidden";
  existing.name = "properties[click_id]";
  existing.value = "preserve_me";
  form.appendChild(existing);

  runCaptureScript(env);

  const inputs = form.querySelectorAll('input[name="properties[click_id]"]');
  assert.equal(inputs.length, 1, "should not duplicate");
  assert.equal(inputs[0].value, "preserve_me", "existing value must be preserved");
});

test("capture script — re-running injection is safe (no duplicates)", () => {
  // Simulates the MutationObserver re-firing on the same form.
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=urlclick" });
  const form = makeProductForm(env.document);

  runCaptureScript(env);
  // Trigger another mutation pass — inject-into-form should be idempotent.
  env.document.body.appendChild(makeElement("div")); // triggers observer
  flushObservers(env);

  const inputs = form.querySelectorAll('input[name="properties[click_id]"]');
  assert.equal(inputs.length, 1, "still exactly one injection");
});

// ── Tests: form detection heuristics ────────────────────────────────────────

test("capture script — does NOT inject into non-product forms", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=urlclick" });
  // Newsletter signup, search, etc. — not /cart/add and no product-form id.
  const newsletter = env.document.createElement("form");
  newsletter.setAttribute("action", "/contact");
  env.document.body.appendChild(newsletter);

  runCaptureScript(env);

  const inputs = newsletter.querySelectorAll('input[name="properties[click_id]"]');
  assert.equal(inputs.length, 0, "non-product forms must be left alone");
});

test("capture script — recognises legacy product_form_* id pattern", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=urlclick" });
  // Some themes use product_form_<id> with no action attribute.
  const form = env.document.createElement("form");
  form.id = "product_form_12345";
  env.document.body.appendChild(form);

  runCaptureScript(env);

  const input = form.querySelector('input[name="properties[click_id]"]');
  assert.ok(input, "legacy product_form_* id should be detected");
  assert.equal(input.value, "urlclick");
});

test("capture script — recognises data-product-form attribute", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=urlclick" });
  const form = env.document.createElement("form");
  form.setAttribute("data-product-form", "");
  env.document.body.appendChild(form);

  runCaptureScript(env);

  const input = form.querySelector('input[name="properties[click_id]"]');
  assert.ok(input, "data-product-form attribute should be detected");
});

// ── Tests: dynamic forms via MutationObserver ───────────────────────────────

test("capture script — injects into AJAX/quick-view form added after load", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=urlclick" });
  // Initial render: no product form yet (e.g. SPA / quick-view modal pattern).
  runCaptureScript(env);

  // Later: a quick-view modal injects a product form.
  const lateForm = env.document.createElement("form");
  lateForm.setAttribute("action", "/cart/add");
  env.document.body.appendChild(lateForm);
  flushObservers(env);

  const input = lateForm.querySelector('input[name="properties[click_id]"]');
  assert.ok(input, "MutationObserver should inject into late-added form");
  assert.equal(input.value, "urlclick");
});

test("capture script — injects into product form nested inside an added wrapper", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=urlclick" });
  runCaptureScript(env);

  // Modal wrapper added in one mutation, with form already inside it.
  const modal = env.document.createElement("div");
  const nestedForm = env.document.createElement("form");
  nestedForm.setAttribute("action", "/cart/add");
  modal.appendChild(nestedForm);
  env.document.body.appendChild(modal);
  flushObservers(env);

  const input = nestedForm.querySelector('input[name="properties[click_id]"]');
  assert.ok(input, "should walk into the added subtree to find product forms");
  assert.equal(input.value, "urlclick");
});

// ── Tests: URL beats stored value ───────────────────────────────────────────

test("capture script — URL param overrides existing localStorage value", () => {
  const env = makeBrowserEnv({ url: "https://shop.example.com/products/x?click_id=newer" });
  env.window.localStorage.setItem("mystorefront_click_id", "older");
  const form = makeProductForm(env.document);

  runCaptureScript(env);

  assert.equal(env._localStorageStore.mystorefront_click_id, "newer");
  const input = form.querySelector('input[name="properties[click_id]"]');
  assert.equal(input.value, "newer");
});
