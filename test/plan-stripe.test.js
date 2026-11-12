import { test } from "node:test";
import assert from "node:assert/strict";
import { planFromProduct, productParams, priceParams, priceChanged, isPlanProduct, parsePlanName, planName } from "../modules/subscriptions/plan-stripe.js";

const product = {
  id: "cloud-pro", name: "Loopar Cloud Pro", description: "", active: true,
  metadata: { category: "cloud", order: "2", features: "Website | Email", mailboxes: "5" },
  default_price: { id: "price_1", unit_amount: 6500, currency: "usd", recurring: { interval: "month" } },
};

test("plan from product: fields, price in units, features one per line", () => {
  const plan = planFromProduct(product);
  assert.equal(plan.name, "cloud-pro");
  assert.equal(plan.price, "65.00");
  assert.equal(plan.interval, "month");
  assert.equal(plan.features, "Website\nEmail");
  assert.equal(plan.stripe_price_id, "price_1");
});

test("only products with a category are plans (setup-fee products are not)", () => {
  assert.equal(isPlanProduct(product), true);
  assert.equal(isPlanProduct({ metadata: { kind: "setup_installments" } }), false);
});

test("round trip: an unchanged form changes nothing in the price", () => {
  const plan = planFromProduct(product);
  assert.equal(priceChanged(priceParams(plan), product.default_price), false);
  assert.deepEqual(productParams(plan).metadata, { category: "cloud", order: "2", mailboxes: "5", users: "", custom_domain: "", features: "Website | Email" });
});

test("price: amount, currency or interval changes need a new Stripe price", () => {
  const plan = planFromProduct(product);
  assert.equal(priceChanged(priceParams({ ...plan, price: "70" }), product.default_price), true);
  assert.equal(priceChanged(priceParams({ ...plan, interval: "year" }), product.default_price), true);
  assert.deepEqual(priceParams({ ...plan, interval: "one_time" }), { unit_amount: 6500, currency: "usd" });
  assert.equal(priceParams({ ...plan, price: "" }), null);
});

test("validation: category required, features within Stripe's metadata limit", () => {
  assert.throws(() => productParams({ plan_name: "x", category: "" }), /Category is required/);
  assert.throws(() => productParams({ plan_name: "x", category: "cloud", features: "a".repeat(501) }), /too long/);
  assert.throws(() => priceParams({ price: "abc" }), /positive amount/);
});

test("modes: test plans of a live account carry the test: prefix; the active mode uses the plain id", () => {
  assert.equal(planFromProduct(product, null, { mode: "test", activeMode: "live" }).name, "test:cloud-pro");
  assert.equal(planFromProduct(product, null, { mode: "live", activeMode: "live" }).name, "cloud-pro");
  assert.equal(planFromProduct(product, null, { mode: "test", activeMode: "test" }).name, "cloud-pro");
  assert.deepEqual(parsePlanName("test:cloud-pro", "live"), { id: "cloud-pro", mode: "test" });
  assert.deepEqual(parsePlanName("cloud-pro", "live"), { id: "cloud-pro", mode: "live" });
  // A test account has no live mode to reach: the prefix means nothing there.
  assert.deepEqual(parsePlanName("cloud-pro", "test"), { id: "cloud-pro", mode: "test" });
  assert.equal(planName("x", "test", "live"), "test:x");
});

test("limits: users travel in the product metadata", () => {
  const plan = planFromProduct({ ...product, metadata: { ...product.metadata, users: "10" } });
  assert.equal(plan.users, "10");
  assert.equal(productParams(plan).metadata.users, "10");
});

test("the key decides the mode", async () => {
  const { keyMode } = await import("../../loopar/modules/stripe/stripe-accounts.js");
  assert.equal(keyMode("sk_live_abc"), "live");
  assert.equal(keyMode("sk_test_abc"), "test");
  assert.equal(keyMode("rk_live_abc"), "live");
  assert.equal(keyMode("pk_test_abc"), "test");
  assert.equal(keyMode(""), null);
  assert.equal(keyMode("••••••••"), null);
});

test("custom domain: included unless the plan turns it off; only \"0\" is stored", async () => {
  const { planFromProduct, productParams } = await import("../modules/subscriptions/plan-stripe.js");
  const base = { plan_name: "X", category: "cloud" };

  assert.equal(productParams({ ...base, custom_domain: 0 }).metadata.custom_domain, "0");
  assert.equal(productParams({ ...base, custom_domain: 1 }).metadata.custom_domain, "");
  assert.equal(productParams(base).metadata.custom_domain, "");

  const product = (metadata) => ({ id: "p", name: "X", active: true, metadata });
  assert.equal(planFromProduct(product({ category: "cloud" })).custom_domain, 1);
  assert.equal(planFromProduct(product({ category: "cloud", custom_domain: "0" })).custom_domain, 0);
});
