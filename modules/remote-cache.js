'use strict';

/**
 * Short in-memory cache for reads of an external source of truth (Stripe,
 * Migadu). Nothing is stored on disk: a value lives a few seconds, per
 * tenant, so the burst of reads one screen makes (a list, its counters, a
 * dashboard) costs one API call instead of many. Writes made through Loopar
 * drop the affected keys at once; changes made directly in the external
 * panel show up when the entry expires.
 *
 * Failures are never cached, and concurrent readers share the call in flight.
 */

import { loopar } from 'loopar';

export const REMOTE_TTL_MS = 30 * 1000;

const entries = new Map();   // key → { value, at }
const inFlight = new Map();  // key → Promise

const scoped = (key) => `${loopar.tenantId || '-'}:${key}`;

export async function cached(key, load, ttl = REMOTE_TTL_MS) {
  const k = scoped(key);
  const hit = entries.get(k);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (inFlight.has(k)) return await inFlight.get(k);

  const job = Promise.resolve().then(load)
    .then((value) => { entries.set(k, { value, at: Date.now() }); return value; })
    .finally(() => inFlight.delete(k));
  inFlight.set(k, job);
  return await job;
}

/** Drops every entry of this tenant whose key starts with `prefix`. */
export function forget(prefix = '') {
  const p = scoped(prefix);
  for (const k of [...entries.keys()]) if (k.startsWith(p)) entries.delete(k);
}
