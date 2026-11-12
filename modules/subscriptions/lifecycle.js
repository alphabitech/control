'use strict';

import { loopar, tenant } from 'loopar';
import { syncSubscriptions } from './subscription-sync.js';
import fs from 'fs';
import path from 'pathe';

/**
 * Operator-driven cleanup: hard-deletes tenant directories on disk for
 * Subscriptions that have been canceled past the grace period.
 *
 * Suspension and resume of a tenant during the active lifecycle (past_due,
 * unpaid, deleted, payment_succeeded) is handled directly by the webhook
 * handlers using `Tenant Manager` methods — no helpers here. This file
 * exists only for the cron-style cleanup endpoint.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_DAYS = 5;

// Stored datetimes without a zone are UTC (what the Stripe sync writes).
const instant = (v) => {
  if (!v) return NaN;
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v)) {
    return new Date(`${v.replace(' ', 'T')}Z`).getTime();
  }
  return new Date(v).getTime();
};

/**
 * Tears a workspace down. Preferred path: the Tenant Manager doc does it
 * (pm2 stop+delete, caddy unregister, rm sites/<name>/). When the tenant
 * entity is gone but the directory is still there, remove it directly.
 * Returns true when the directory no longer exists.
 */
async function removeTenantFiles(tenantName) {
  const sitePath = path.join(process.cwd(), 'sites', tenantName);
  const doc = await loopar.getDocument('Tenant Manager', tenantName, null, { ifNotFound: null });
  if (doc?.name) {
    try {
      // A tenant is destroyed only once it is off. A canceled workspace was
      // stopped when it was canceled; this covers one turned back on by hand.
      if (tenant.readTenant(tenantName)?.status === 'active') await doc.stop();
      await doc.destroy();
      return !fs.existsSync(sitePath);
    } catch (err) {
      console.error(`[lifecycle/cleanup] destroy ${tenantName}:`, err.message);
      return false;
    }
  }
  if (!fs.existsSync(sitePath)) return false;
  try {
    fs.rmSync(sitePath, { recursive: true, force: true });
    console.log(`[lifecycle/cleanup] removed sites/${tenantName}`);
    return true;
  } catch (err) {
    console.error(`[lifecycle/cleanup] rm ${sitePath}:`, err.message);
    return false;
  }
}

/** Cloud Settings with their defaults (also when the record was never saved). */
export async function cloudSettings() {
  let doc = null;
  try { doc = await loopar.getDocument('Cloud Settings'); } catch (_) { /* not installed yet */ }
  const days = Number(doc?.deletion_grace_days);
  return {
    graceDays: Number.isInteger(days) && days >= 1 ? days : DEFAULT_GRACE_DAYS,
    // Only an explicit "off" stops deletions.
    autoDelete: ![0, '0', false, 'false'].includes(doc?.auto_delete_canceled),
    // Site Template a workspace gets when none was picked at checkout ('' = none).
    defaultTemplate: String(doc?.default_template || '').trim(),
  };
}

/**
 * Hard-delete the workspaces whose Subscription ended more than Cloud
 * Settings' grace period ago (ended_at, or canceled_at, + days). Returns the number
 * of tenants removed. Idempotent and safe to call repeatedly.
 *
 * The dates come from Stripe (synced first), never from a stored deadline:
 * a canceled row without them is skipped, not deleted, and a
 * change of the grace period applies to every workspace not deleted yet.
 * `delete_after` is kept only to show the planned date.
 *
 * Intended trigger: a daily OS cron calling
 * `POST /api/Signup/cleanupCanceled`.
 */
export async function cleanupCanceledTenants({ now = Date.now(), removeTenant = removeTenantFiles } = {}) {
  const { graceDays, autoDelete } = await cloudSettings();
  await syncSubscriptions({ force: true });

  let rows;
  try {
    rows = await loopar.db.getAll(
      'Subscription',
      ['name', 'tenant_name', 'canceled_at', 'ended_at', 'delete_after', 'provisioning_step'],
      { status: 'canceled' }
    );
  } catch (err) {
    console.error('[lifecycle/cleanup] could not list canceled subs:', err.message);
    return 0;
  }

  let removed = 0;
  for (const row of rows || []) {
    if (!row.tenant_name || row.provisioning_step === 'deleted') continue;
    if (row.tenant_name === loopar.tenantId) continue; // never the control plane itself

    // Counted from when the service really ended: a "cancel at period end"
    // has canceled_at at the request, ended_at at the end of the paid period.
    const endedAt = Math.max(instant(row.ended_at) || 0, instant(row.canceled_at) || 0);
    if (!endedAt) {
      console.warn(`[lifecycle/cleanup] ${row.name} is canceled but has no end date — skipped`);
      continue;
    }
    const deleteAt = endedAt + graceDays * DAY_MS;
    if (instant(row.delete_after) !== deleteAt) {
      try {
        await loopar.db.updateRow('Subscription', row.name, { delete_after: new Date(deleteAt).toISOString() });
      } catch (_) { /* display only */ }
    }
    if (!autoDelete || deleteAt > now) continue;

    if (await removeTenant(row.tenant_name)) removed++;

    // Stamp the Subscription once its workspace is gone, so it isn't retried.
    // A failed removal stays unstamped and is tried again on the next run.
    if (!fs.existsSync(path.join(process.cwd(), 'sites', row.tenant_name))) {
      try {
        await loopar.db.updateRow('Subscription', row.name, {
          tenant_provisioned: 0,
          provisioning_step:  'deleted',
        });
      } catch (_) { /* non-fatal */ }
    }
  }

  return removed;
}
