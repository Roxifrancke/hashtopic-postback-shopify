# Staging optional Shopify discount scopes without a release

Purpose: prepare an **unreleased** Shopify app version that declares optional
`read_discounts` and `write_discounts` scopes. This does **not** grant them to
HashTopic, update existing merchants, or deploy the Render web backend.

## Before running

- Check the app configuration's `client_id` matches **MyStorefront Postback**.
- Use a Shopify account authorized to deploy that app.
- Work from branch `chore/shopify-discounts-scopes-20261104`, **not** PR #4,
  `main`, or a local folder with an old checkout.
- Review the Shopify CLI deployment diff, including app extensions and webhook
  settings. Shopify app versions snapshot the whole app configuration.
- Do **not** use `--allow-deletes`, `--allow-updates`, or `--no-build` to
  suppress warnings or skip checks.
- Do **not** release this version yet.

## Commands on an operator workstation

```bash
cd ~/Desktop
git clone --branch chore/shopify-discounts-scopes-20261104 \
  https://github.com/Roxifrancke/hashtopic-postback-shopify.git \
  mystorefront-shopify-scopes
cd mystorefront-shopify-scopes
npx --yes @shopify/cli@latest version
npx --yes @shopify/cli@latest app deploy --config mystorefront-postback --no-release \
  --message "Stage optional GraphQL discount scopes; not released"
```

Shopify CLI may open a browser login. Verify the linked app is **MyStorefront
Postback**, and review all proposed configuration changes. If a warning or
unexpected diff appears, stop and share the output before proceeding.

Confirm the CLI explicitly says the version was **created but not released**.
Check the Shopify Dev Dashboard for an *unreleased* version.

## Not yet authorized

- Releasing the Shopify app version.
- Requesting optional permissions from HashTopic.
- Granting anything on PrimeState or Orphan Street Clothing.
- Merging PR #4 or #5 or deploying Render.
- Changing existing discount codes.

## Later, after operator review

Release the reviewed optional-scopes-only app version, approve the optional
scopes on HashTopic, and rerun the read-only discount diagnostic. Shopify's
official flow supports optional scope requests through App Bridge and a
merchant-approved authorization URL.

Sources:
- https://shopify.dev/docs/api/shopify-cli/app/app-deploy
- https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions
- https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes
