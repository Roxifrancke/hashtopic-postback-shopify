// Tags every discount code in the store so the checkout function knows who
// it belongs to, and switches the checkout rule on. Called when MyStorefront
// saves a brand's rules, and from the discounts/create + discounts/update webhooks.

const API_VERSION = "2025-04";
const NS = "$app:mystorefront";
const TAG_KEY = "code_rule";
const RULES_KEY = "referral_rules";
const FUNCTION_TITLE = "Creator code check";

async function gql(shop, token, query, variables) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

const CODES_FRAGMENT = `
  codeDiscount {
    ... on DiscountCodeBasic { codes(first: 5) { nodes { code } } }
    ... on DiscountCodeBxgy { codes(first: 5) { nodes { code } } }
    ... on DiscountCodeFreeShipping { codes(first: 5) { nodes { code } } }
    ... on DiscountCodeApp { codes(first: 5) { nodes { code } } }
  }`;

const SET = `mutation($m: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $m) { metafields { id } userErrors { field message code } }
}`;

function creatorFor(node, codes) {
  const list = node?.codeDiscount?.codes?.nodes || [];
  for (const c of list) {
    const ref = codes[String(c?.code || "").toUpperCase()];
    if (ref) return ref;
  }
  return null;
}

function tagInput(ownerId, creator) {
  return { ownerId, namespace: NS, key: TAG_KEY, type: "json", value: JSON.stringify({ creator }) };
}

export async function readRules(shop, token) {
  const out = await gql(shop, token, `query { shop { metafield(namespace: "${NS}", key: "${RULES_KEY}") { value } } }`);
  try {
    return JSON.parse(out.json?.data?.shop?.metafield?.value || "null");
  } catch {
    return null;
  }
}

export async function tagAllCodes(shop, token, rules) {
  const codes = rules?.codes || {};
  const inputs = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const out = await gql(
      shop,
      token,
      `query($after: String) {
        codeDiscountNodes(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id ${CODES_FRAGMENT} }
        }
      }`,
      { after },
    );
    const conn = out.json?.data?.codeDiscountNodes;
    if (!out.ok || !conn) return { status: "list_failed", http: out.status, errors: out.json?.errors || null };
    for (const node of conn.nodes || []) inputs.push(tagInput(node.id, creatorFor(node, codes)));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  let tagged = 0;
  const errors = [];
  for (let i = 0; i < inputs.length; i += 25) {
    const out = await gql(shop, token, SET, { m: inputs.slice(i, i + 25) });
    const ue = out.json?.data?.metafieldsSet?.userErrors || [];
    if (!out.ok || ue.length || out.json?.errors) errors.push(...(ue.length ? ue : out.json?.errors || [{ message: `HTTP ${out.status}` }]));
    else tagged += Math.min(25, inputs.length - i);
  }
  return { status: errors.length ? "partial" : "ok", tagged, total: inputs.length, errors: errors.slice(0, 5) };
}

export async function tagOneDiscount(shop, token, gid) {
  if (!gid || !String(gid).includes("DiscountCodeNode")) return { status: "skipped_not_code" };
  const rules = await readRules(shop, token);
  if (!rules) return { status: "no_rules" };
  const out = await gql(shop, token, `query($id: ID!) { node(id: $id) { ... on DiscountCodeNode { id ${CODES_FRAGMENT} } } }`, { id: gid });
  const node = out.json?.data?.node;
  if (!node?.id) return { status: "not_found" };
  const saved = await gql(shop, token, SET, { m: [tagInput(node.id, creatorFor(node, rules.codes || {}))] });
  const ue = saved.json?.data?.metafieldsSet?.userErrors || [];
  return ue.length ? { status: "failed", errors: ue } : { status: "ok" };
}

const activated = new Set();

export async function ensureValidation(shop, token) {
  if (activated.has(shop)) return { status: "already_confirmed" };
  const out = await gql(
    shop,
    token,
    `query {
      validations(first: 25) { nodes { id enabled shopifyFunction { id } } }
      shopifyFunctions(first: 25) { nodes { id title } }
    }`,
  );
  if (!out.ok || out.json?.errors) return { status: "query_failed", errors: out.json?.errors || null };

  const fn = (out.json?.data?.shopifyFunctions?.nodes || []).find((f) => f.title === FUNCTION_TITLE);
  if (!fn) return { status: "function_not_deployed" };

  const existing = (out.json?.data?.validations?.nodes || []).find((v) => v.shopifyFunction?.id === fn.id);
  if (existing?.enabled) {
    activated.add(shop);
    return { status: "enabled" };
  }

  const mutation = existing
    ? gql(shop, token, `mutation($id: ID!) { validationUpdate(id: $id, validation: { enable: true }) { userErrors { field message } } }`, { id: existing.id })
    : gql(
        shop,
        token,
        `mutation($fid: String!) {
          validationCreate(validation: { functionId: $fid, enable: true, blockOnFailure: false, title: "MyStorefront creator code check" }) {
            validation { id }
            userErrors { field message }
          }
        }`,
        { fid: fn.id },
      );
  const res = await mutation;
  const ue = res.json?.data?.validationUpdate?.userErrors || res.json?.data?.validationCreate?.userErrors || [];
  if (!res.ok || ue.length || res.json?.errors) return { status: "activate_failed", errors: ue.length ? ue : res.json?.errors };
  activated.add(shop);
  return { status: existing ? "re_enabled" : "created" };
}
