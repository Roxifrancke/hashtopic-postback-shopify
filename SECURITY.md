# Security Policy — MyStorefront Postback

_Last updated: 2026-04-20_

## Reporting a vulnerability

Email: jordanspringveldt@gmail.com — please include reproduction steps and
affected endpoint(s). We aim to acknowledge within 2 business days and to
remediate critical issues within 7 days.

Do not open a public GitHub issue for security reports.

## Supported versions

Only the version deployed on Render at
`https://mystorefront-postback.onrender.com` is actively supported.

## Security controls

- HTTPS/TLS for all traffic.
- HMAC-SHA256 verification on every Shopify webhook (orders + GDPR).
- JWT signature verification on embedded-app API calls.
- Webhook payloads read raw before JSON parsing so HMAC is computed over the
  exact bytes Shopify signed.
- PostgreSQL encryption at rest and encrypted backups (Render-managed).
- Secrets (`SHOPIFY_API_SECRET`, `SESSION_SECRET`, DB credentials) stored only
  in Render environment variables, never committed to the repo.
- Production access limited to the app owner; 2FA enforced on Render, GitHub,
  and Shopify Partners.

## Incident response

If a security incident is suspected:

1. **Contain** — take the affected service offline via Render if needed.
2. **Rotate secrets** — regenerate `SHOPIFY_API_SECRET` in Shopify Partners /
   Dev Dashboard, rotate `SESSION_SECRET`, rotate DB credentials in Render.
3. **Assess scope** — review Render request logs and application logs
   (retained by Render) to determine what data was accessed and which shops
   were affected.
4. **Notify** — within 72 hours of confirmed breach involving personal data,
   notify affected merchants via email and, where required by law, relevant
   data protection authorities. Merchants are responsible for notifying their
   own customers.
5. **Remediate** — patch the underlying issue, deploy, and verify.
6. **Post-mortem** — document root cause, timeline, and preventive measures.

## Data retention during an incident

Logs and delivery records relevant to an incident are preserved until the
investigation concludes, even if they would normally be purged by the 90-day
retention job.

## Contact

jordanspringveldt@gmail.com
