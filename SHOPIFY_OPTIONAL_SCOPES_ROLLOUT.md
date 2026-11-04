# Prepare an unreleased Shopify app version for optional discount scopes

Status: **Preparation only. Do not release a Shopify app version or merge this PR without review.**

## Why

The HashTopic GraphQL `codeDiscountNodes` diagnostic returned a permission error requiring `read_discounts`, despite successful application-only authentication. This branch keeps the app's existing required scopes untouched and declares `read_discounts` and `write_discounts` as optional. **Optional declarations do not themselves grant either permission.**

## Safety conditions

- Use only the dedicated scope branch `chore/shopify-discounts-scopes-20261104`, not the GraphQL implementation PR #4 or `main`.
- Use the original Shopify app Client ID `80133e649bd215aa494b9e54f91aa0f3`. Verify the CLI-linked app is **MyStorefront Postback** before proceeding.
- Shopify CLI app deployment versions the app configuration **and every local extension** together. Confirm all currently deployed extensions are represented in this checkout and inspect any proposed extension changes. Missing local extensions can be removed upon a later release.
- A `--no-release` deployment creates a **draft/unreleased app version** only; it does not grant scopes, change the active Shopify app version, change Render, or authorise any brand.
- If CLI asks to deploy a different app, remove an extension, or change webhook subscriptions or URLs, stop.

## Operator commands (Mac Terminal)

```bash
cd ~/Desktop
git clone -b chore/shopify-discounts-scopes-20261104 \
  https://github.com/Roxifrancke/hashtopic-postback-shopify.git \
  mystorefront-scopes-test
cd mystorefront-scopes-test
shopify version
shopify app config validate --config mystorefront-postback
```

If `shopify` is not installed or the configuration is not linked, stop and address those items first. Do not substitute a default app configuration.

After confirming that the CLI is linked to the intended MyStorefront Postback app and the complete current set of extensions is included, create **without releasing**:

```bash
shopify app deploy --config mystorefront-postback --no-release \
  --message "Optional Shopify discount scopes for HashTopic validation"
```

Check the output for the new unreleased version and review it in Shopify Dev Dashboard. **Do not run `shopify app release`, omit `--no-release`, or merge this PR yet.**

## Later rollout (separate approvals)

1. Compare the unreleased version to the current active version, including extensions and webhooks.
2. Approve releasing the version, if appropriate. Note that releasing app configurations is app-wide, even when scopes are optional.
3. Explicitly request the optional `read_discounts` permission on **HashTopic test store only**, through Shopify's supported optional-scope authorisation flow. It must be accepted by the store owner.
4. Verify the actual granted scopes and re-run PR #4's **read-only** `test-live-discounts-readonly.js`.
5. Compare GraphQL discount IDs, types, values and status against existing REST data; do not assume numeric ID equivalence without evidence.
6. Only then consider writes and authorisation for other merchants.

Official docs:
- https://shopify.dev/docs/api/shopify-cli/app/app-deploy
- https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions
- https://shopify.dev/docs/apps/launch/deployment/app-versions
