// Removes discount codes the brand doesn't allow on creator-referred carts.
// Runs from a hidden automatic discount the app creates in each store.
//
// Rules come from the shop metafield MyStorefront saves:
//   { "block": true, "codes": { "CODE": "creatorref" } }
// "Don't allow any codes" is sent as block: true with no codes, so every
// entered code is removed. Automatic discounts are never touched.

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

export function cartLinesDiscountsGenerateRun(input) {
  const rules = parse(input?.shop?.metafield?.value);
  if (!rules || rules.block !== true) return NONE;

  const cart = input?.cart || {};

  // Cart attribute first. Line items cover Buy It Now, which skips the cart.
  let ref = clean(cart.attribute?.value);
  if (!ref) {
    for (const line of cart.lines || []) {
      const v = clean(line?.attribute?.value);
      if (v) {
        ref = v;
        break;
      }
    }
  }
  if (!ref) return NONE;

  const allowed = rules.codes && typeof rules.codes === "object" ? rules.codes : {};
  const reject = [];
  for (const entered of input?.enteredDiscountCodes || []) {
    if (!entered?.rejectable) continue;
    const code = String(entered.code || "");
    const owner = allowed[code.toUpperCase()];
    if (!owner || clean(owner) !== ref) reject.push({ code });
  }

  if (reject.length === 0) return NONE;
  return {
    operations: [{ enteredDiscountCodesReject: { codes: reject, message: MESSAGE } }],
  };
}
