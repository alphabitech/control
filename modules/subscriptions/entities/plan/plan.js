'use strict';

import { BaseDocument, loopar } from 'loopar';
import { stripeClientFor, stripeMode } from '../../account-service.js';
import { invalidatePlansCache } from '../../controllers/signup/signup-controller.js';
import { cached, forget } from '../../../remote-cache.js';
import {
  planFromProduct, productParams, priceParams, priceChanged, isPlanProduct, parsePlanName, planName,
} from '../../plan-stripe.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,60}$/;

/** Stripe errors as form errors. */
async function stripeCall(fn) {
  try { return await fn(); }
  catch (e) { loopar.throw({ code: e?.statusCode === 404 ? 404 : 400, title: 'Stripe', message: e?.message || String(e) }); }
}

async function clientOf(mode) {
  const stripe = await stripeClientFor(mode);
  if (!stripe) {
    loopar.throw(mode === 'test'
      ? 'Stripe test mode is not configured: add the Test secret key in Stripe Account.'
      : 'Stripe live mode is not available on this account.');
  }
  return stripe;
}

const priceData = (price) => ({ unit_amount: price.unit_amount, currency: price.currency, ...(price.recurring ? { recurring: price.recurring } : {}) });

/**
 * Plan — virtual: no table. Records are Stripe Products (with their default
 * Price); listing, opening, saving and deleting talk to Stripe directly, so
 * the desk and Stripe can't drift apart.
 *
 * A live account can also keep plans in Stripe's test mode (record names
 * "test:<id>"): they are prepared and reviewed there, never offered to
 * customers (the pricing page and checkout use the live key only), and
 * `publish()` copies one to live.
 */
export default class Plan extends BaseDocument {
  #product = null;
  #price = null;
  #mode = null;

  constructor(props) {
    super(props);
  }

  async __init__(ifNotFound) {
    if (this.__DOCUMENT_NAME__) {
      const activeMode = await stripeMode();
      const { id, mode } = parsePlanName(this.__DOCUMENT_NAME__, activeMode);
      const stripe = await clientOf(mode);
      let product = null;
      try {
        product = await stripe.products.retrieve(id, { expand: ['default_price'] });
      } catch (e) {
        if (e?.statusCode !== 404) loopar.throw({ code: 400, title: 'Stripe', message: e?.message || String(e) });
      }

      if (product && isPlanProduct(product)) {
        let price = typeof product.default_price === 'object' ? product.default_price : null;
        if (!price) price = (await stripe.prices.list({ product: product.id, active: true, limit: 1 })).data[0] || null;
        this.#product = product;
        this.#price = price;
        this.#mode = mode;
        // Stripe fills the form; values sent by the request (a save) win.
        this.__DATA__ = {
          ...planFromProduct(product, price, { mode, activeMode }),
          ...Object.fromEntries(Object.entries(this.__DATA__ || {}).filter(([, v]) => v != null)),
        };
        this.__IS_NEW__ = false;
      } else if (ifNotFound === 'new') {
        this.__IS_NEW__ = true;
      } else if (ifNotFound === 'null' || ifNotFound === null) {
        return null;
      } else {
        loopar.throw({ code: 404, message: `Plan ${this.__DOCUMENT_NAME__}: not found in Stripe` });
      }
    }

    await super.__init__();
    if (this.__DOCUMENT_NAME__) this.name = this.__DOCUMENT_NAME__;
  }

  /** Every plan in Stripe: the active mode's, plus the test ones a live account keeps. */
  async virtualRecords() {
    const activeMode = await stripeMode();
    const modes = activeMode === 'live' ? ['live', 'test'] : ['test'];
    const lists = await Promise.all(modes.map((mode) => cached(`stripe:plans:${mode}`, () => this.#rows(mode, activeMode))));
    return lists.flat();
  }

  async save() {
    const activeMode = await stripeMode();
    await super.validate();

    let product, price;
    try {
      product = productParams(await this.rawValues());
      price = priceParams(await this.rawValues());
    } catch (e) { loopar.throw(e.message); }

    if (!this.#product) {
      const mode = this.mode === 'test' ? 'test' : (this.mode === 'live' ? 'live' : activeMode);
      const stripe = await clientOf(mode);
      if (!ID_RE.test(String(this.name || ''))) loopar.throw('ID: use letters, numbers, dashes or underscores (e.g. cloud-pro).');
      if (!price) loopar.throw('Price is required for a new plan.');
      const id = this.name;
      await stripeCall(() => stripe.products.create({ id, ...product, default_price_data: priceData(price) }));
      this.mode = mode;
      this.name = planName(id, mode, activeMode);
    } else {
      const stripe = await clientOf(this.#mode);
      const id = this.#product.id;
      this.mode = this.#mode;
      await stripeCall(() => stripe.products.update(id, product));
      // A Stripe price can't be edited: a new amount is a new price. The old
      // one is archived (current subscribers keep paying it).
      if (priceChanged(price, this.#price)) {
        const created = await stripeCall(() => stripe.prices.create({ product: id, ...price }));
        await stripeCall(() => stripe.products.update(id, { default_price: created.id }));
        if (this.#price) await stripeCall(() => stripe.prices.update(this.#price.id, { active: false }));
      }
    }

    this.#forget();
    this.__IS_NEW__ = false;
    return true;
  }

  /**
   * Copies this test plan to live: same id, name, category, limits, features
   * and price. Refused when live already has that id — from then on they are
   * two independent plans. Returns the live plan's record name.
   */
  async publish() {
    if (!this.#product || this.#mode !== 'test') loopar.throw('Only a plan in test mode can be published to live.');
    if (await stripeMode() !== 'live') loopar.throw('This account runs in test mode: there is no live mode to publish to.');

    const values = planFromProduct(this.#product, this.#price, { mode: 'test', activeMode: 'live' });
    const product = productParams(values);
    const price = priceParams(values);
    if (!price) loopar.throw('Give the plan a price before publishing it.');

    const live = await clientOf('live');
    const id = this.#product.id;
    const exists = await live.products.retrieve(id).then(() => true).catch((e) => {
      if (e?.statusCode === 404) return false;
      loopar.throw({ code: 400, title: 'Stripe', message: e?.message || String(e) });
    });
    if (exists) loopar.throw(`Live already has a plan "${id}". Edit that one; a test plan is only published once.`);

    await stripeCall(() => live.products.create({ id, ...product, default_price_data: priceData(price) }));
    this.#forget();
    return id;
  }

  /** Stripe keeps products that were ever sold: deleting a plan archives it. */
  async delete() {
    if (!this.#product) loopar.throw({ code: 404, message: `Plan ${this.name}: not found in Stripe` });
    const stripe = await clientOf(this.#mode);
    await stripeCall(() => stripe.products.update(this.#product.id, { active: false }));
    this.#forget();
    return true;
  }

  #forget() {
    invalidatePlansCache();
    forget('stripe:plans');
  }

  async #rows(mode, activeMode) {
    const stripe = await stripeClientFor(mode);
    if (!stripe) return []; // that mode has no key here: nothing to show
    const rows = [];
    await stripeCall(async () => {
      for await (const product of stripe.products.list({ limit: 100, expand: ['data.default_price'] })) {
        if (isPlanProduct(product)) rows.push(planFromProduct(product, null, { mode, activeMode }));
      }
    });
    const order = (r) => (Number.isFinite(parseInt(r.order, 10)) ? parseInt(r.order, 10) : 9999);
    return rows.sort((a, b) => b.active - a.active || a.category.localeCompare(b.category) || order(a) - order(b) || a.plan_name.localeCompare(b.plan_name));
  }
}
