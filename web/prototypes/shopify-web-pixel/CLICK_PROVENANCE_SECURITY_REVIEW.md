# MyStorefront click provenance gate for Web Pixel attribution

**2026-11-04 verification against the current MyStorefront project**
`4eab06f5-090c-47b2-a089-08e606446bea`, read-only.

## Confirmed in the deployed source and policies

- `supabase/functions/affiliate-redirect/index.ts` uses a server-side
  Supabase service credential and generates `crypto.randomUUID()` click IDs.
  It inserts `affiliate_clicks` then redirects to the merchant with
  `click_id` on the destination URL. The current code continues redirecting
  even when the click INSERT fails.
- `src/lib/tracking.ts` contains `trackOutboundClick`, a browser-side
  legacy function which also generates UUID click IDs and inserts into
  `affiliate_clicks`.
- Current RLS policy `Validated affiliate click inserts` allows certain
  anonymous INSERTs where the link exists, creator ownership matches and a
  36-character anonymous session ID is provided. These conditions do not
  cryptographically authenticate a click's origin. No insert trigger
  currently attests to issuance.
- `affiliate_clicks` has a unique `click_id` but no trusted
  provenance/issuer column or immutable server-attestation evidence.
- HashTopic has 50 click rows in the last 30 days. Their format and
  associated links are consistent, but **none was independently proven to
  have originated from the trusted redirect rather than a client insert**.
  Rows with `source_page='share_link'` cannot be assumed safe: this field
  is client-supplied.

## Security decision

No referral is eligible for the new Web Pixel paid-order path solely
because a matching `affiliate_clicks` row exists. The staging verifier
returns `click_record_found_unproven`, with
`provenance_verified:false`, `consent_eligible:false`,
`commission_created:false` and `can_send_postback:false`.
The one-shot audit cannot claim source verification.

Before the new path is enabled, MyStorefront must establish a
**server-issued, independently verified click provenance** mechanism.
A safe design is a protected issuance table (or verifiable signed proof)
written only by a trusted redirect handler, with insert privileges denied
to browsers; link, creator, brand, timestamp and attribution policy must
be bound to the issued proof. Fix the redirect's fail-open behavior when
its tracking INSERT fails. The legacy browser-side click flow needs a
separate compatibility decision. Do not retroactively treat historical
click rows as attested. Add specific retention and consent handling.

A dedicated least-privilege, read-only verifier identity should be
provisioned after the provenance data model and policies are approved.
Never copy a service-role key into a Web Pixel or GitHub source, and never
use a browser-supplied consent flag as authority.

## Scope

This change is a **staging-only fail-closed policy correction**, not a
migration or production behavior change. No database schema, storefront,
Shopify app, webhook, Render settings, payout rules, live brand analytics,
or existing affiliate workflow has been changed.
