'use strict';

/**
 * Keeps the local Subscription rows in step with Stripe (the source of truth)
 * when they are read: lists, records and the Cloud home sync before showing.
 *
 * One `subscriptions.list` call (paged by 100) refreshes every row, at most
 * once per SYNC_TTL_MS per tenant; concurrent readers share the call in
 * flight. A failure (Stripe down, no key) is logged and the stored rows are
 * shown as they are — reading never fails because of the sync.
 */

import { loopar, Op } from 'loopar';
import { stripeClient, applyPlanLimits } from './account-service.js';

const SYNC_TTL_MS = 60 * 1000;
const FIELDS = ['name', 'stripe_subscription_id', 'status', 'current_period_end', 'canceled_at', 'ended_at', 'stripe_price_id'];

const lastSync = new Map();   // tenant → ms of the last finished sync
const inFlight = new Map();   // tenant → Promise of the running sync

const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);
// Stored datetimes without a zone are UTC (what we write); never the server's local time.
const instant = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v)
  ? new Date(`${v.replace(' ', 'T')}Z`) : new Date(v)).getTime();
const sameInstant = (a, b) => (!a && !b) || (!!a && !!b && instant(a) === instant(b));

/** Local columns Stripe decides for one subscription. */
export function stripeFields(sub) {
  const item = sub.items?.data?.[0] || {};
  return {
    status: sub.status,
    // Newer Stripe API versions moved the period onto the items.
    current_period_end: iso(sub.current_period_end ?? item.current_period_end),
    canceled_at: iso(sub.canceled_at),
    // Set when the subscription actually ended (a cancel at period end ends later than canceled_at).
    ended_at: iso(sub.ended_at),
    stripe_price_id: item.price?.id || null,
  };
}

/** Only the columns whose value changed (dates compared as instants). */
export function changedFields(row, fresh) {
  const out = {};
  for (const [key, value] of Object.entries(fresh)) {
    const dated = key.endsWith('_end') || key.endsWith('_at');
    const same = dated ? sameInstant(row[key], value) : (row[key] ?? null) === (value ?? null);
    if (!same) out[key] = value;
  }
  return out;
}

async function apply(rows, subsById) {
  let updated = 0;
  for (const row of rows) {
    const sub = subsById.get(row.stripe_subscription_id);
    if (!sub) continue;
    const patch = changedFields(row, stripeFields(sub));
    if (!Object.keys(patch).length) continue;
    await loopar.db.updateRow('Subscription', row.name, patch);
    updated++;
  }
  return updated;
}

async function run() {
  const stripe = await stripeClient({ required: false });
  if (!stripe) return 0;
  const rows = await loopar.db.getAll('Subscription', FIELDS, { stripe_subscription_id: { [Op.ne]: null } });
  if (!rows.length) return 0;

  const subsById = new Map();
  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    subsById.set(sub.id, sub);
    // The plan's limits follow the subscription into its workspace.
    await applyPlanLimits(stripe, sub).catch((e) => console.warn(`[subscription-sync] limits of ${sub.id} not applied:`, e?.message || e));
  }
  return await apply(rows, subsById);
}

/** Refreshes every Subscription from Stripe; throttled unless `force`. */
export async function syncSubscriptions({ force = false } = {}) {
  const tenant = loopar.tenantId;
  if (!force && Date.now() - (lastSync.get(tenant) || 0) < SYNC_TTL_MS) return 0;
  if (inFlight.has(tenant)) return await inFlight.get(tenant);

  const job = run()
    .then((n) => { lastSync.set(tenant, Date.now()); return n; })
    .catch((e) => { console.warn('[subscription-sync] Stripe sync skipped:', e?.message || e); return 0; })
    .finally(() => inFlight.delete(tenant));
  inFlight.set(tenant, job);
  return await job;
}

/** Refreshes one Subscription from Stripe (opening a record). */
export async function syncSubscription(name) {
  try {
    const row = await loopar.db.getRow('Subscription', name, FIELDS);
    if (!row?.stripe_subscription_id) return false;
    const stripe = await stripeClient({ required: false });
    if (!stripe) return false;
    const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    return (await apply([row], new Map([[sub.id, sub]]))) > 0;
  } catch (e) {
    console.warn(`[subscription-sync] ${name} not synced:`, e?.message || e);
    return false;
  }
}
