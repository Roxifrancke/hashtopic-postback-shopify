// Tags every discount code in the store so the checkout function knows who
// it belongs to, and switches the checkout rule on. Called when MyStorefront
// saves a brand's rules, and from the discounts/create + discounts/update webhooks.

const API_VERSION = "2025-04";
const NS = "$app:mystorefront";
const TAG_KEY = "code_rule";
const RULES_KEY = "referral_rules";
const FUNCTION_TITLE = "Creator code check";

async function gql(shop, token, query, variables, version = API_VERSION) {
  const res = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
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
  if (!res.ok || ue.length || res.json?.errors) {
    return { status: notEligible(ue) ? "not_eligible" : "activate_failed", errors: ue.length ? ue : res.json?.errors };
  }
  activated.add(shop);
  return { status: existing ? "re_enabled" : "created" };
}

// ── Auto-remove: an automatic discount that runs the "MyStorefront creator
// link rules" function. Shopify only lets automatic discounts reject codes,
// so this gives the function a place to run. It never discounts anything.
// It only exists while the brand has a blocking option on, and is deleted
// when they switch back to allowing codes.
const REMOVE_FUNCTION_TITLE = "MyStorefront creator link rules";
const REMOVE_DISCOUNT_TITLE = "MyStorefront creator links (gives no discount, don't delete)";
const DISCOUNT_API_VERSION = "2026-01";

// Custom apps can only run functions on Shopify Plus stores. Report that
// clearly so MyStorefront can tell the brand the setting isn't available.
function notEligible(errors) {
  return (errors || []).some(
    (e) => String(e?.code || "").includes("NOT_ELIGIBLE") || /plus plan/i.test(String(e?.message || "")),
  );
}

function failure(res, ue, fallback) {
  return { status: notEligible(ue) ? "not_eligible" : fallback, errors: ue.length ? ue : res.json?.errors || null };
}

// Titles this rule has had, so older copies are still recognised.
const OLD_DISCOUNT_TITLES = ["MyStorefront creator code check (do not delete)"];

// The function id format can differ between APIs, so also match by the
// function's name and by our own titles.
function isOurs(node, fnId) {
  const d = node?.automaticDiscount;
  if (!d) return false;
  const fid = String(d.appDiscountType?.functionId || "");
  const idMatch = Boolean(fnId && fid && (fid === fnId || fid.endsWith(`/${fnId}`) || fnId.endsWith(`/${fid}`)));
  return (
    idMatch ||
    d.appDiscountType?.title === REMOVE_FUNCTION_TITLE ||
    d.title === REMOVE_DISCOUNT_TITLE ||
    OLD_DISCOUNT_TITLES.includes(d.title)
  );
}

// discountNodes lists every automatic discount, including app discounts.
// Its ids are generic, so convert them to automatic discount ids for the
// delete, update and activate mutations (the number is the same).
function toAutomaticId(id) {
  const num = String(id || "").split("/").pop();
  return `gid://shopify/DiscountAutomaticNode/${num}`;
}

async function findRemoveDiscounts(shop, token) {
  const out = await gql(
    shop,
    token,
    `query {
      shopifyFunctions(first: 50) { nodes { id title } }
      discountNodes(first: 100, query: "method:automatic") {
        nodes {
          id
          discount {
            __typename
            ... on DiscountAutomaticApp { title status appDiscountType { functionId title } }
          }
        }
      }
    }`,
    undefined,
    DISCOUNT_API_VERSION,
  );
  if (!out.ok || out.json?.errors) return { error: { status: "query_failed", errors: out.json?.errors || null } };

  const fn = (out.json?.data?.shopifyFunctions?.nodes || []).find((f) => f.title === REMOVE_FUNCTION_TITLE);
  if (!fn) return { error: { status: "function_not_deployed" } };

  const nodes = (out.json?.data?.discountNodes?.nodes || []).map((n) => ({
    id: toAutomaticId(n.id),
    automaticDiscount: n.discount,
  }));
  const mine = nodes.filter((n) => isOurs(n, fn.id));
  const seen = nodes.map((n) => ({ type: n.automaticDiscount?.__typename || null, title: n.automaticDiscount?.title || null }));
  return { fn, mine, seen };
}

async function deleteDiscount(shop, token, id) {
  const res = await gql(
    shop,
    token,
    `mutation($id: ID!) {
      discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message code } }
    }`,
    { id },
    DISCOUNT_API_VERSION,
  );
  const ue = res.json?.data?.discountAutomaticDelete?.userErrors || [];
  if (!res.ok || ue.length || res.json?.errors) return failure(res, ue, "remove_failed");
  return null;
}

// wanted = true while the brand blocks codes on creator links, false on allow.
export async function ensureRejectDiscount(shop, token, wanted) {
  const found = await findRemoveDiscounts(shop, token);
  if (found.error) return found.error;
  const { fn, mine, seen } = found;

  if (!wanted) {
    if (mine.length === 0) return { status: "not_needed" };
    for (const node of mine) {
      const err = await deleteDiscount(shop, token, node.id);
      if (err) return err;
    }
    return { status: "removed", count: mine.length };
  }

  // Keep one, delete any extra copies.
  const [keep, ...extra] = mine;
  for (const node of extra) {
    const err = await deleteDiscount(shop, token, node.id);
    if (err) return err;
  }

  if (keep) {
    if (keep.automaticDiscount?.title !== REMOVE_DISCOUNT_TITLE) {
      const res = await gql(
        shop,
        token,
        `mutation($id: ID!, $d: DiscountAutomaticAppInput!) {
          discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $d) { userErrors { field message code } }
        }`,
        { id: keep.id, d: { title: REMOVE_DISCOUNT_TITLE } },
        DISCOUNT_API_VERSION,
      );
      const ue = res.json?.data?.discountAutomaticAppUpdate?.userErrors || [];
      if (!res.ok || ue.length || res.json?.errors) return failure(res, ue, "rename_failed");
    }

    if (keep.automaticDiscount?.status !== "ACTIVE") {
      const res = await gql(
        shop,
        token,
        `mutation($id: ID!) { discountAutomaticActivate(id: $id) { userErrors { field message code } } }`,
        { id: keep.id },
        DISCOUNT_API_VERSION,
      );
      const ue = res.json?.data?.discountAutomaticActivate?.userErrors || [];
      if (!res.ok || ue.length || res.json?.errors) return failure(res, ue, "activate_failed");
    }
    return { status: extra.length ? "deduped" : "active", removed_extra: extra.length };
  }

  const res = await gql(
    shop,
    token,
    `mutation($d: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $d) {
        automaticAppDiscount { discountId }
        userErrors { field message code }
      }
    }`,
    {
      d: {
        title: REMOVE_DISCOUNT_TITLE,
        functionId: fn.id,
        discountClasses: ["ORDER", "PRODUCT"],
        startsAt: new Date().toISOString(),
        combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
      },
    },
    DISCOUNT_API_VERSION,
  );
  const ue = res.json?.data?.discountAutomaticAppCreate?.userErrors || [];
  if (!res.ok || ue.length || res.json?.errors) return { ...failure(res, ue, "create_failed"), seen };
  return { status: "created" };
}
