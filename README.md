# HashTopic Postback for Shopify

**Version:** 1.0.0  
**Platform:** Shopify (Embedded App)  
**Stack:** Node.js + Express + React + Shopify Polaris

---

## Overview

HashTopic Postback for Shopify sends conversion postbacks to your webhook whenever a Shopify order is paid. It captures `click_id` from shopper URLs via a lightweight storefront script, stores it in a first-party cookie, attaches it to the order via note attributes, and fires a JSON postback on payment.

---

## Brand-Facing Setup

> **4 steps — no developer needed after installation.**
>
> 1. **Install the app** from the Shopify App Store (or install manually via the steps below).
> 2. **Paste your Webhook URL + Secret** in the HashTopic Postback app settings.
> 3. **Click "Send Test Postback"** to verify the connection. You'll see a green confirmation.
> 4. **Done!** Click IDs are captured automatically and sent with every paid order.

---

## Technical Setup

### Prerequisites
- Node.js 18+
- Shopify Partner account
- A development store for testing
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli) installed

### 1. Clone & Install
```bash
git clone https://github.com/your-org/hashtopic-postback-shopify.git
cd hashtopic-postback-shopify
npm install
cd web && npm install
cd frontend && npm install
```

### 2. Create a Shopify App
1. Go to [partners.shopify.com](https://partners.shopify.com) → Apps → Create App
2. Choose **Custom App**
3. Copy your **API Key** and **API Secret**

### 3. Configure Environment
```bash
cp .env.example .env
```
Edit `.env`:
```
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
SHOPIFY_APP_URL=https://your-ngrok-url.ngrok.io
```

Update `shopify.app.toml`:
```toml
client_id = "your_api_key"
application_url = "https://your-ngrok-url.ngrok.io"
dev_store_url = "your-store.myshopify.com"
```

### 4. Start Development Server
```bash
shopify app dev
```
This starts the backend + frontend with a tunnel and opens your dev store.

### 5. Add the Storefront Script
In your Shopify theme editor (**Online Store → Themes → Edit Code → theme.liquid**), add before `</head>`:

```html
<script src="https://YOUR_APP_URL/pixel/YOUR_SHOP.myshopify.com/capture.js" async></script>
```

This script:
- Reads configured URL parameter names (default: `click_id`)
- Stores the value in a first-party cookie (`_ht_click_id` by default)
- Cookie flags: `Secure`, `SameSite=Lax`, 30-day expiry (all configurable)

### 6. Order Note Attributes (click_id persistence)
To pass the `click_id` from cookie to the Shopify order, add this to your cart/checkout theme code:

```javascript
// In your theme JS, read the click_id cookie and write to cart attributes
const clickId = document.cookie.match(/_ht_click_id=([^;]+)/)?.[1];
if (clickId) {
  fetch('/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attributes: { _ht_click_id: decodeURIComponent(clickId) } })
  });
}
```

Shopify copies cart attributes to `order.note_attributes` automatically. The app reads `note_attributes` named `_ht_click_id` when building the postback payload.

---

## How It Works

### Architecture

```
Shopper visits ?click_id=abc123
        ↓
capture.js sets _ht_click_id cookie
        ↓
Cart attribute update → order.note_attributes._ht_click_id = "abc123"
        ↓
Order paid → Shopify sends orders/paid webhook
        ↓
App receives webhook → reads settings + note_attributes
        ↓
Builds JSON payload → POST to your Webhook URL
        ↓
Success: marks delivery "sent"
Failed: schedules retry (5 attempts over 24h)
```

### Payload Contract

```json
{
  "event": "purchase",
  "event_time": "2024-01-15T14:23:01Z",
  "click_id": "abc123",
  "order_id": "5678901234",
  "order_number": "#1001",
  "order_status": "paid",
  "currency": "USD",
  "order_total": 99.99,
  "shipping_total": 5.00,
  "tax_total": 8.50,
  "discount_total": 0.00,
  "items_count": 2,
  "customer": {
    "email": "customer@example.com",
    "phone": "+15551234567"
  },
  "store": {
    "platform": "shopify",
    "site_url": "https://your-store.myshopify.com"
  },
  "test": false
}
```

### Retry Schedule
| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | +5 minutes |
| 3 | +30 minutes |
| 4 | +2 hours |
| 5 | +24 hours |

After 5 failures the delivery is marked `failed`. Use the Deliveries log to retry manually.

---

## App Pages

### Settings (`/`)
- Webhook URL (https required)
- Webhook Secret (stored securely, never re-displayed)
- Paid Statuses (checkboxes: paid, partially_paid, etc.)
- Attribution Param Names (comma-separated)
- Cookie Name and Duration
- Debug Logging toggle
- Test Mode toggle
- **Send Test Postback** button with inline result

### Deliveries (`/deliveries`)
- Last 50 postback attempts
- Columns: Order, Timestamp, Status, Attempts, HTTP Code, Last Error, Actions
- **Retry Now** button on failed/pending deliveries

---

## Security

- All admin routes require Shopify session authentication via App Bridge
- Webhook secret stored in SQLite, never returned to frontend (only `has_secret: true/false`)
- Secret sent only in `x-webhook-secret` HTTP header, never in URLs or logs
- Shopify webhook payloads verified via HMAC by `@shopify/shopify-app-express`
- Debug logging masks customer email (`j***@example.com`) and redacts phone numbers

---

## Database

SQLite is used for session storage and delivery tracking (via `better-sqlite3`). Files:
- `database.sqlite` — Shopify session storage
- `hashtopic.sqlite` — Settings and delivery log

For production, consider upgrading to PostgreSQL or MySQL by swapping the session storage adapter and replacing the `better-sqlite3` calls in `db.js`.

---

## Deployment

### Heroku / Render / Railway
1. Set all environment variables from `.env.example`
2. Set `NODE_ENV=production`
3. Build frontend: `cd web/frontend && npm run build`
4. Start: `cd web && npm start`

### Shopify App Store Submission
1. Run `shopify app deploy` to register webhooks
2. Complete the Partner Dashboard app listing
3. Submit for review

---

## Changelog

### 1.0.0
- Initial release
- Shopify webhook handler for `orders/paid` and `orders/updated`
- Storefront pixel script for click ID capture
- 5-attempt retry with cron-based scheduler
- Polaris-based settings UI with test postback button
- Deliveries log with manual retry
- Debug logging with PII redaction
- SQLite storage for settings and delivery log
