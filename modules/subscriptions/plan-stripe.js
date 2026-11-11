'use strict';

/**
 * Plan ⇄ Stripe mapping. A Plan is a Stripe Product with its default Price:
 * Stripe is the store, the Plan entity (virtual) is only its form.
 *
 *   product.id / name / description / active   → name / plan_name / description / active
 *   product.metadata.category|order|features|mailboxes
 *   default price unit_amount / currency / recurring.interval → price / currency / interval
 *
 * Only products with `metadata.category` are plans: one-off products the
 * billing flows create (setup fees) never show up here.
 */

export const CATEGORIES = ['cloud', 'service', 'donation'];
export const INTERVALS = ['month', 'year', 'one_time'];
const METADATA_MAX = 500; // Stripe's limit per metadata value

const truthy = (v) => [1, '1', true, 'true'].includes(v);
const text = (v) => String(v ?? '').trim();

/** "a | b" (Stripe) ⇄ one feature per line (form). */
export const featuresToLines = (value) => text(value).split('|').map((f) => f.trim()).filter(Boolean).join('\n');
export const featuresToMetadata = (value) => text(value).split('\n').map((f) => f.trim()).filter(Boolean).join(' | ');

export const isPlanProduct = (product) => !!text(product?.metadata?.category);

export const TEST_PREFIX = 'test:';

/**
 * A plan's record name → { id, mode }. Plans of the mode billing runs in use
 * the Stripe product id; test plans seen from a live account carry "test:".
 */
export function parsePlanName(name, activeMode = 'live') {
  const value = text(name);
  if (activeMode === 'live' && value.startsWith(TEST_PREFIX)) return { id: value.slice(TEST_PREFIX.length), mode: 'test' };
  return { id: value, mode: activeMode };
}

export const planName = (id, mode, activeMode = 'live') => (mode === 'test' && activeMode === 'live' ? `${TEST_PREFIX}${id}` : id);

/** Form values of a Stripe product (with its default price, when it has one). */
export function planFromProduct(product, price = null, { mode = 'live', activeMode = mode } = {}) {
  price = price || (typeof product.default_price === 'object' ? product.default_price : null);
  const meta = product.metadata || {};
  return {
    name: planName(product.id, mode, activeMode),
    mode,
    plan_name: product.name,
    description: product.description || '',
    category: text(meta.category),
    order: text(meta.order),
    mailboxes: text(meta.mailboxes),
    users: text(meta.users),
    features: featuresToLines(meta.features),
    active: product.active ? 1 : 0,
    price: price?.unit_amount != null ? (price.unit_amount / 100).toFixed(2) : '',
    currency: (price?.currency || 'usd').toLowerCase(),
    interval: price ? (price.recurring?.interval || 'one_time') : 'month',
    stripe_price_id: price?.id || '',
  };
}

/** Product fields Stripe stores for a plan. Throws on values Stripe would reject. */
export function productParams(plan) {
  const category = text(plan.category).toLowerCase();
  if (!category) throw new Error('Category is required: it decides where the plan is offered.');
  const features = featuresToMetadata(plan.features);
  if (features.length > METADATA_MAX) throw new Error(`Features are too long (${features.length}/${METADATA_MAX} characters).`);
  return {
    name: text(plan.plan_name),
    description: text(plan.description),
    active: truthy(plan.active),
    // An empty value removes the key in Stripe.
    metadata: { category, order: text(plan.order), mailboxes: text(plan.mailboxes), users: text(plan.users), features },
  };
}

/** Price fields of the form, or null when no amount was entered. */
export function priceParams(plan) {
  if (text(plan.price) === '') return null;
  const amount = Math.round(Number(plan.price) * 100);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Price must be a positive amount.');
  const currency = text(plan.currency).toLowerCase() || 'usd';
  if (!/^[a-z]{3}$/.test(currency)) throw new Error('Currency must be a 3-letter code (usd, eur…).');
  const interval = INTERVALS.includes(plan.interval) ? plan.interval : 'month';
  return {
    unit_amount: amount,
    currency,
    ...(interval === 'one_time' ? {} : { recurring: { interval } }),
  };
}

/** Does the form's price differ from the Stripe price? (Stripe prices are immutable.) */
export function priceChanged(params, price) {
  if (!params) return false;
  if (!price) return true;
  return params.unit_amount !== price.unit_amount
    || params.currency !== price.currency
    || (params.recurring?.interval || null) !== (price.recurring?.interval || null);
}
