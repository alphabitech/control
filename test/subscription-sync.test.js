import { test } from "node:test";
import assert from "node:assert/strict";
import "loopar";
import { stripeFields, changedFields } from "../modules/subscriptions/subscription-sync.js";

const sub = {
  id: "sub_1",
  status: "canceled",
  canceled_at: 1780574867,
  items: { data: [{ current_period_end: 1781179667, price: { id: "price_1" } }] },
};

test("stripe fields: status, period end from the item, cancel date, price", () => {
  assert.deepEqual(stripeFields(sub), {
    status: "canceled",
    current_period_end: new Date(1781179667 * 1000).toISOString(),
    canceled_at: new Date(1780574867 * 1000).toISOString(),
    ended_at: null,
    stripe_price_id: "price_1",
  });
});

test("changed fields: only what differs; dates compared as instants", () => {
  const fresh = stripeFields(sub);
  const row = {
    status: "active",
    current_period_end: "2026-06-11 12:07:47",
    canceled_at: null,
    stripe_price_id: "price_1",
  };
  const patch = changedFields(row, fresh);
  assert.deepEqual(Object.keys(patch).sort(), ["canceled_at", "status"]);
  assert.deepEqual(changedFields({ ...row, ...fresh }, fresh), {});
});
