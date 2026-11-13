// Blocks discount codes on creator-referred carts when the brand chose Block.
//
// Each code in the store carries a tag set by the app: { "creator": "<ref>" }
// for a creator's own code, or { "creator": null } for an unassigned code.
// Untagged discounts (automatic sales) are never blocked.

const MESSAGE = "Discount codes cannot be combined with creator referral links.";
const NONE = { operations: [] };

function parse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function cartValidationsGenerateRun(input) {
  const rules = parse(input?.shop?.metafield?.value);
  if (!rules || rules.block !== true) return NONE;

  const cart = input?.cart || {};

  // The cart attribute is the source of truth. Line items are only used when
  // it's missing (Buy It Now skips the cart).
  let ref = clean(cart.attribute?.value) || clean(cart.legacyAttribute?.value);
  if (!ref) {
    for (const line of cart.lines || []) {
      const v = clean(line?.attribute?.value) || clean(line?.legacyAttribute?.value);
      if (v) {
        ref = v;
        break;
      }
    }
  }
  if (!ref) return NONE;

  const blocked = (cart.discountApplications || []).some((d) => {
    const tag = parse(d?.metafield?.value);
    if (!tag || !Object.prototype.hasOwnProperty.call(tag, "creator")) return false;
    return !tag.creator || clean(tag.creator) !== ref;
  });

  if (!blocked) return NONE;
  return {
    operations: [{ validationAdd: { errors: [{ message: MESSAGE, target: "$.cart" }] } }],
  };
}
