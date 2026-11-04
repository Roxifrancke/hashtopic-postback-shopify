/**
 * LOOPBACK-ONLY research receiver. NEVER deploy this on Render or expose publicly.
 *
 * Accepts expressly synthetic Shopify-shaped events and emits candidate-only matches.
 * No real shopper data, tokens, paid-order verification, or commissions.
 *
 * Run: PIXEL_PROTOTYPE_MODE=synthetic node web/prototypes/shopify-web-pixel/staging-receiver.mjs
 * POST Shopify-shaped synthetic JSON to http://127.0.0.1:48731/observations
 */
import http from "node:http";
import { toPixelAttributionObservation, proposeAttributionCandidate } from "../../backend/web-pixel-attribution-prototype.js";

const TEST_SHOP = "mystorefront-test.myshopify.com";
const MAX_BODY_BYTES = 8192;
const MAX_RECORDS = 100;
const MAX_AGE_MS = 60 * 60 * 1000;
const PORT = 48731;

function isSyntheticEvent(event) {
  return event && typeof event === "object" &&
    typeof event.id === "string" && /^synthetic-event-[a-zA-Z0-9_-]{1,72}$/.test(event.id) &&
    typeof event.clientId === "string" && /^synthetic-client-[a-zA-Z0-9_-]{1,72}$/.test(event.clientId) &&
    (event.name === "page_viewed" || event.name === "checkout_completed") &&
    (event.name !== "page_viewed" ||
      typeof event.context?.document?.location?.href === "string" &&
      event.context.document.location.href.startsWith("https://example.test/") &&
      /[?&]click_id=test_[a-zA-Z0-9_-]{4,80}(?:&|$)/.test(event.context.document.location.href)) &&
    (event.name !== "checkout_completed" ||
      /^gid:\/\/shopify\/Order\/[0-9]+$/.test(event.data?.checkout?.order?.id ?? ""));
}

/** In-memory, non-persistent candidate reconciler. Multiple referrals are resolved
 * deterministically by latest timestamp, NOT by arrival order. */
export function makeSyntheticReceiver({ now = () => Date.now() } = {}) {
  const observations = new Map();
  const seenEvents = new Set();

  function observe(event) {
    if (!isSyntheticEvent(event)) return { status: 400, body: { error: "synthetic_events_only" } };
    const current = now();
    const normalized = toPixelAttributionObservation({ event, shop: TEST_SHOP, nowMs: current });
    if (!normalized) return { status: 400, body: { error: "invalid_synthetic_event" } };
    if (seenEvents.has(normalized.event_id)) return { status: 200, body: { status: "duplicate_ignored" } };

    for (const [id, entry] of observations) {
      if (current - entry.arrivedAt > MAX_AGE_MS) {
        observations.delete(id);
        seenEvents.delete(id);
      }
    }
    if (observations.size >= MAX_RECORDS) {
      const oldest = observations.keys().next().value;
      observations.delete(oldest);
      seenEvents.delete(oldest);
    }
    seenEvents.add(normalized.event_id);
    observations.set(normalized.event_id, { observation: normalized, arrivedAt: current });
    if (normalized.event_name === "page_viewed") {
      return { status: 202, body: { status: "synthetic_referral_observed", recorded: true } };
    }

    const matches = [...observations.values()]
      .map(x => x.observation)
      .filter(x => x.event_name === "page_viewed" && x.client_id === normalized.client_id)
      .sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));
    for (const referral of matches) {
      const candidate = proposeAttributionCandidate(referral, normalized, current);
      if (candidate) {
        // Never expose the client ID, full URL, or any customer/order details.
        return { status: 202, body: {
          status: "candidate_only", order_id: candidate.order_id,
          click_id: candidate.click_id, verified_paid_order: false, commission_created: false,
        }};
      }
    }
    return { status: 202, body: { status: "checkout_without_match", commission_created: false } };
  }

  return { observe };
}

export function createLoopbackServer(receiver = makeSyntheticReceiver()) {
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/observations") {
      return send(404, { error: "not_found" });
    }
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
      return send(415, { error: "json_required" });
    }
    let body = "";
    let length = 0;
    req.on("data", chunk => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        if (payload?.shop !== TEST_SHOP) return send(400, { error: "unexpected_test_shop" });
        const result = receiver.observe(payload.event);
        return send(result.status, result.body);
      } catch {
        return send(400, { error: "invalid_json" });
      }
    });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.env.PIXEL_PROTOTYPE_MODE !== "synthetic" || process.env.NODE_ENV === "production") {
    console.error("Refusing to start outside synthetic non-production mode.");
    process.exit(1);
  }
  createLoopbackServer().listen(PORT, "127.0.0.1", () => {
    console.log(`Synthetic-only pixel receiver listening on http://127.0.0.1:${PORT}`);
  });
}
