'use strict';

/*
 * Minimal Cloudflare DNS client (API v4, bearer token with Zone:DNS:Edit).
 * Pure: takes a token and a fetch implementation, no loopar.
 */

export class CloudflareError extends Error {
  constructor(message, { status, errors } = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.status = status;
    this.errors = errors;
  }
}

const enc = encodeURIComponent;
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME']);

export function createCloudflare({ token, fetch = globalThis.fetch, base = 'https://api.cloudflare.com/client/v4', timeoutMs = 20000 } = {}) {
  if (!token) throw new CloudflareError('Cloudflare API token is not configured (Mail Hosting Settings).');

  async function request(method, path, body) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch (e) {
      throw new CloudflareError(`Cloudflare is unreachable: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    } finally {
      timer && clearTimeout(timer);
    }

    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data?.success) {
      const errors = data?.errors || [];
      const detail = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || res.statusText;
      const hint = res.status === 403 || res.status === 401 ? ' (the token needs Zone → DNS → Edit on this zone)' : '';
      throw new CloudflareError(`Cloudflare ${method} ${path} failed (${res.status}): ${detail}${hint}`, { status: res.status, errors });
    }
    return data;
  }

  /** Record payload Cloudflare accepts. */
  function payload(rec) {
    const type = String(rec.type).toUpperCase();
    return {
      type,
      name: rec.name,
      content: rec.content,
      ttl: 1,
      ...(type === 'MX' ? { priority: Number(rec.priority ?? 10) } : {}),
      ...(PROXIABLE.has(type) ? { proxied: false } : {}),
    };
  }

  return {
    request,

    /** Zone that holds `domain` (tries the domain, then its parents). */
    async findZone(domain) {
      const labels = String(domain).toLowerCase().replace(/\.$/, '').split('.');
      for (let i = 0; i <= labels.length - 2; i++) {
        const candidate = labels.slice(i).join('.');
        const data = await request('GET', `/zones?name=${enc(candidate)}`);
        if (data.result?.length) return data.result[0];
      }
      return null;
    },

    async listRecords(zoneId) {
      const out = [];
      for (let page = 1; page < 100; page++) {
        const data = await request('GET', `/zones/${enc(zoneId)}/dns_records?per_page=500&page=${page}`);
        out.push(...(data.result || []));
        const info = data.result_info;
        if (!info || page >= (info.total_pages || 1)) break;
      }
      return out;
    },

    createRecord: async (zoneId, rec) => (await request('POST', `/zones/${enc(zoneId)}/dns_records`, payload(rec))).result,
    updateRecord: async (zoneId, id, rec) => (await request('PATCH', `/zones/${enc(zoneId)}/dns_records/${enc(id)}`, payload(rec))).result,
    deleteRecord: async (zoneId, id) => (await request('DELETE', `/zones/${enc(zoneId)}/dns_records/${enc(id)}`)).result,
  };
}

/**
 * Applies planDns() ops to a zone. Returns the ops with `error` set on failures.
 * Creates and updates run first; a delete runs only when every write for the
 * same type and name succeeded, so a failed write never leaves the domain
 * without its replacement (e.g. foreign MX removed but Migadu MX missing).
 */
export async function applyPlan(cf, zoneId, ops) {
  const done = [];
  const failed = new Set();
  const slot = (o) => `${o.type}|${o.name}`;

  for (const op of ops.filter((o) => o.op === 'create' || o.op === 'update')) {
    const out = { ...op };
    try {
      if (op.op === 'create') out.id = (await cf.createRecord(zoneId, op)).id;
      else await cf.updateRecord(zoneId, op.id, op);
    } catch (e) {
      out.error = e.message;
      failed.add(slot(op));
    }
    done.push(out);
  }

  for (const op of ops.filter((o) => o.op === 'delete')) {
    const out = { ...op };
    if (failed.has(slot(op))) {
      out.error = 'skipped: its replacement could not be written';
    } else {
      try {
        await cf.deleteRecord(zoneId, op.id);
      } catch (e) {
        out.error = e.message;
      }
    }
    done.push(out);
  }

  for (const op of ops.filter((o) => o.op === 'keep')) done.push({ ...op });
  return done;
}
