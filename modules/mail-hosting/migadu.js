'use strict';

/*
 * Minimal Migadu API client (https://www.migadu.com/api).
 * Pure: takes credentials and a fetch implementation, no loopar.
 */

export class MigaduError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'MigaduError';
    this.status = status;
    this.body = body;
  }
}

/** The array inside a list response, whatever key Migadu wraps it in. */
export function listOf(res, key) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res[key])) return res[key];
  const first = res && Object.values(res).find(Array.isArray);
  return first || [];
}

const enc = encodeURIComponent;

export function createMigadu({ user, apiKey, fetch = globalThis.fetch, base = 'https://api.migadu.com/v1', timeoutMs = 20000 } = {}) {
  if (!user || !apiKey) throw new MigaduError('Migadu credentials are not configured (Mail Hosting Settings).');
  const auth = 'Basic ' + Buffer.from(`${user}:${apiKey}`).toString('base64');

  async function request(method, path, body) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch (e) {
      throw new MigaduError(`Migadu is unreachable: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    } finally {
      timer && clearTimeout(timer);
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!res.ok) {
      const detail = (data && typeof data === 'object' && (data.message || data.error || data.errors && JSON.stringify(data.errors)))
        || (typeof data === 'string' && data.slice(0, 300)) || res.statusText;
      const hint = res.status === 401 ? ' (check the Migadu user and API key)' : '';
      throw new MigaduError(`Migadu ${method} ${path} failed (${res.status}): ${detail}${hint}`, { status: res.status, body: data });
    }
    return data;
  }

  const orNull = async (p) => {
    try { return await p; } catch (e) { if (e.status === 404) return null; throw e; }
  };

  const d = (domain) => `/domains/${enc(domain)}`;

  return {
    request,

    // Domains
    listDomains: async () => listOf(await request('GET', '/domains'), 'domains'),
    getDomain: (domain) => orNull(request('GET', d(domain))),
    createDomain: (domain, { createDefaultAddresses = true } = {}) =>
      request('POST', '/domains', { name: domain, hosted_dns: false, create_default_addresses: !!createDefaultAddresses }),
    records: (domain) => request('GET', `${d(domain)}/records`),
    diagnostics: (domain) => request('GET', `${d(domain)}/diagnostics`),
    usage: (domain) => request('GET', `${d(domain)}/usage`),
    /** { ok: true, domain } or { ok: false, error, message } (422 = DNS checks failed). */
    activate: async (domain) => {
      try {
        return { ok: true, domain: await request('GET', `${d(domain)}/activate`) };
      } catch (e) {
        if (e.status === 422 || e.status === 400) {
          return { ok: false, error: e.body?.error || 'activation_failed', message: e.body?.message || e.message };
        }
        throw e;
      }
    },

    // Mailboxes
    listMailboxes: async (domain) => listOf(await request('GET', `${d(domain)}/mailboxes`), 'mailboxes'),
    getMailbox: (domain, localPart) => orNull(request('GET', `${d(domain)}/mailboxes/${enc(localPart)}`)),
    createMailbox: (domain, body) => request('POST', `${d(domain)}/mailboxes`, body),
    updateMailbox: (domain, localPart, body) => request('PUT', `${d(domain)}/mailboxes/${enc(localPart)}`, body),
    deleteMailbox: (domain, localPart) => orNull(request('DELETE', `${d(domain)}/mailboxes/${enc(localPart)}`)),

    // Aliases
    listAliases: async (domain) => listOf(await request('GET', `${d(domain)}/aliases`), 'address_aliases'),
    getAlias: (domain, localPart) => orNull(request('GET', `${d(domain)}/aliases/${enc(localPart)}`)),
    createAlias: (domain, body) => request('POST', `${d(domain)}/aliases`, body),
    updateAlias: (domain, localPart, body) => request('PUT', `${d(domain)}/aliases/${enc(localPart)}`, body),
    deleteAlias: (domain, localPart) => orNull(request('DELETE', `${d(domain)}/aliases/${enc(localPart)}`)),
  };
}
