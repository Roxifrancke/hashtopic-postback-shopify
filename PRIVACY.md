# Privacy Policy — MyStorefront Postback

_Last updated: 2026-04-20_

MyStorefront Postback ("the app", "we") is a Shopify app that forwards order
events from a merchant's Shopify store to an affiliate postback URL configured
by the merchant. This policy describes what data we process, how, and why.

## Who is the data controller?

The Shopify merchant who installs the app is the data controller for their
customers' personal data. We act as a data processor on their behalf, limited
to the purposes described below.

## What data we process

When a Shopify order is paid or updated, Shopify sends us a webhook. We only
process orders that contain a `click_id` note attribute (orders driven by an
affiliate click). For those orders we read:

- Order ID, order number, financial status
- Order total, currency, shipping total, tax total, discount total
- Line-item count
- `click_id` note attribute value
- Customer email (if present on the order)
- Customer phone (if present on the order)
- Shop domain

Orders without a `click_id` are ignored entirely — nothing about them is stored
or forwarded.

## What we store at rest

The following is stored in our PostgreSQL database, hosted on Render:

- **Settings** per shop: postback URL, shared secret (encrypted by DB
  provider), paid-status list, and integration keys.
- **Delivery records** per shop: shop domain, Shopify order ID, order number,
  delivery status (sent / pending / failed), attempt count, HTTP response code,
  error message, timestamps.

**We do not store customer email, phone, name, or address at rest.** Customer
contact fields are forwarded in-transit to the merchant's configured postback
URL and are not retained in our database.

## What we forward

To the postback URL configured by the merchant, we send a JSON payload
containing `click_id`, order ID, order total, currency, metadata (order number,
status, totals, item count), and `customer.email` / `customer.phone` if present
on the order. The postback URL is owned and controlled by the merchant (or by
the affiliate network the merchant has contracted with).

## Why we process this data

- **App functionality** — forward order data to the merchant's configured
  postback URL so they can attribute sales to affiliate clicks.
- **Analytics** — affiliate networks use the forwarded data to measure
  conversions and detect duplicate or fraudulent activity.

We do not use the data for any other purpose. We do not sell personal data.

## Legal basis (GDPR)

The merchant's legitimate interest in attributing sales to marketing channels,
and contractual necessity where the merchant has agreements with affiliate
networks.

## Retention

- Delivery records older than 90 days are automatically purged.
- Settings are retained while the app is installed and are deleted within 48
  hours of uninstall, via Shopify's `shop/redact` GDPR webhook.
- Customer PII — not retained at rest.

## Subprocessors

- **Render** — application and database hosting
- **Shopify** — the source of all webhook data

The merchant's configured postback URL is not our subprocessor; it is a
destination chosen by the merchant.

## Security

- All data is transmitted over HTTPS/TLS.
- The PostgreSQL database is encrypted at rest and backups are encrypted, as
  provided by Render.
- Webhook requests are validated using HMAC-SHA256 against the shared secret.
- Access to production systems is limited to authorized developers with
  individual credentials and two-factor authentication.

## Customer rights

We support Shopify's mandatory GDPR webhooks at `/api/webhooks/gdpr/`:

- `customers/data_request` — because we do not store customer PII at rest,
  there is no stored data to return. Any PII is held by the merchant in
  Shopify.
- `customers/redact` — no stored customer PII to redact.
- `shop/redact` — all shop data (settings + delivery records) is deleted.

## Contact

For questions about this policy, email: jordanspringveldt@gmail.com
