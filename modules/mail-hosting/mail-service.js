'use strict';

/*
 * Server glue between the mail entities and the Migadu / Cloudflare APIs.
 * Business rules for DNS live in dns-plan.js (pure); this file reads the
 * settings, talks to the providers and writes local records.
 */

import { cached, forget } from '../remote-cache.js';
import { loopar } from 'loopar';
import { createMigadu } from './migadu.js';
import { createCloudflare, applyPlan } from './cloudflare.js';
import { planDns, describePlan, normName, policyFromValues } from './dns-plan.js';

export const SETTINGS = 'Mail Hosting Settings';
export const DOMAIN = 'Mail Domain';
export const MAILBOX = 'Mailbox';
export const ALIAS = 'Mail Alias';
export const POLICY = 'Mail Policy';

/** Throws a user-facing validation error. */
export const fail = (message) => loopar.throw({ code: 400, title: 'Mail', message });

export const truthy = (v) => [1, '1', true, 'true'].includes(v);
export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const DOMAIN_RE = /^(?=.{3,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@;,=<>"']+@[^\s@;,=<>"']+\.[^\s@;,=<>"']+$/;

export function normalizeDomain(v) {
  const d = normName(v).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!DOMAIN_RE.test(d)) fail(`"${v}" is not a valid domain name.`);
  return d;
}

export function normalizeLocalPart(v) {
  const lp = String(v || '').trim().toLowerCase();
  if (!LOCAL_RE.test(lp) || lp.includes('..')) fail(`"${v}" is not a valid user name (letters, numbers, . _ + -).`);
  return lp;
}

export const isEmail = (v) => EMAIL_RE.test(String(v || '').trim());

/* ------------------------------------------------------------------ */
/* Remote-sync guard                                                   */
/* ------------------------------------------------------------------ */

const FROM_REMOTE = new WeakSet();

/** Marks a document as written from provider data: its hooks must not call the provider back. */
export function fromRemote(doc) {
  FROM_REMOTE.add(doc);
  return doc;
}

export const isFromRemote = (doc) => FROM_REMOTE.has(doc);

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

export const DEFAULT_WEBMAIL_URL = 'https://webmail.migadu.com';

export async function settings() {
  let doc = null;
  try {
    doc = await loopar.getDocument(SETTINGS);
  } catch {
    doc = null;
  }
  return {
    migadu_user: doc?.migadu_user || '',
    migadu_api_key: doc?.migadu_api_key || '',
    cloudflare_api_token: doc?.cloudflare_api_token || '',
    default_mail_policy: doc?.default_mail_policy || '',
    webmail_url: doc?.webmail_url || DEFAULT_WEBMAIL_URL,
    default_mailbox_limit: Math.max(0, parseInt(doc?.default_mailbox_limit, 10) || 0),
  };
}

export async function migadu() {
  const s = await settings();
  if (!s.migadu_user || !s.migadu_api_key) fail('Configure the Migadu user and API key in Mail Hosting Settings first.');
  return createMigadu({ user: s.migadu_user, apiKey: s.migadu_api_key });
}

export async function cloudflare() {
  const s = await settings();
  if (!s.cloudflare_api_token) fail('Configure the Cloudflare API token in Mail Hosting Settings first.');
  return createCloudflare({ token: s.cloudflare_api_token });
}

/** Runs a provider call and turns its error into a user-facing one. */
export async function remote(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.name === 'MigaduError' || e?.name === 'CloudflareError') fail(e.message);
    throw e;
  }
}

/** Request input: query string, JSON body and form data merged (later wins). */
export function input(ctrl) {
  const parse = (v) => (typeof v === 'string' && loopar.utils.isJSON(v) ? JSON.parse(v) : v);
  const out = { ...(ctrl.query || {}), ...(ctrl.body || {}), ...(ctrl.data || {}) };
  for (const k of Object.keys(out)) out[k] = parse(out[k]);
  return out;
}

/** The record targeted by `?name=` (404 when missing). */
export async function targetDoc(ctrl) {
  const name = ctrl.query?.name || input(ctrl).name;
  if (!name) loopar.throw({ code: 400, message: 'Missing document name.' });
  const doc = await loopar.getDocument(ctrl.document, name, null, { ifNotFound: null });
  if (!doc) loopar.throw({ code: 404, message: `${ctrl.document} ${name} does not exist.` });
  return doc;
}

export const domainStatus = (remoteDomain) => {
  const state = String(remoteDomain?.state || '').toLowerCase();
  if (state === 'active') return 'Active';
  if (remoteDomain?.deactivated_at) return 'Inactive';
  return 'Pending';
};

/* ------------------------------------------------------------------ */
/* Domains                                                             */
/* ------------------------------------------------------------------ */

/** Gets the domain in Migadu, creating it when missing. */
export async function ensureRemoteDomain(domain, { createDefaultAddresses = true } = {}) {
  const api = await migadu();
  return await remote(async () => (await api.getDomain(domain)) || (await api.createDomain(domain, { createDefaultAddresses })));
}

export async function remoteDomainStatus(domain) {
  return domainStatus(await ensureRemoteDomain(domain));
}

/**
 * Writes the DNS records Migadu needs into the domain's Cloudflare zone.
 * Returns { zone, ops, warnings, errors, report }.
 */
/**
 * Mail policy that governs a domain's SPF/DMARC: the domain's own, else the
 * default in Mail Hosting Settings. Null = conservative (merge SPF, keep a
 * valid DMARC). Returns { name, policy }.
 */
export async function domainPolicy(domain) {
  const own = (await loopar.db.getAll(DOMAIN, ['mail_policy'], { name: domain }))[0]?.mail_policy;
  const name = own || (await settings()).default_mail_policy;
  if (!name) return { name: null, policy: null };
  const row = (await loopar.db.getAll(POLICY, ['*'], { name }))[0];
  if (!row) fail(`Mail Policy "${name}" does not exist.`);
  return { name, policy: policyFromValues(row) };
}

export async function configureDns(domain, { dryRun = false } = {}) {
  const api = await migadu();
  const cf = await cloudflare();
  const { name: policyName, policy } = await domainPolicy(domain);

  const wanted = await remote(() => api.records(domain));
  const zone = await remote(() => cf.findZone(domain));
  if (!zone) fail(`No Cloudflare zone found for ${domain}. Add the domain to Cloudflare (or check that the token can see it).`);

  const existing = (await remote(() => cf.listRecords(zone.id))).map((r) => ({
    id: r.id, type: r.type, name: r.name, content: r.content, priority: r.priority, proxied: r.proxied,
  }));

  const plan = planDns({
    domain,
    migadu: wanted,
    existing,
    policy,
  });

  const ops = dryRun ? plan.ops : await applyPlan(cf, zone.id, plan.ops);
  const errors = ops.filter((o) => o.error).map((o) => `${o.op} ${o.type} ${o.name}: ${o.error}`);
  const header = `${dryRun ? 'DNS plan' : 'DNS applied'} for ${domain} (Cloudflare zone ${zone.name}, `
    + `${policyName ? `policy ${policyName}` : 'no mail policy'}) — ${now()}`;
  const report = `${header}\n\n${describePlan({ ops, warnings: plan.warnings })}`;
  return { zone, ops, warnings: plan.warnings, errors, report };
}

/** Plain-text summary of Migadu's diagnostics payload (shape is undocumented). */
export function describeDiagnostics(diag) {
  if (!diag || typeof diag !== 'object') return String(diag ?? '');
  const lines = [];
  const walk = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      else lines.push(`${key}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
    }
  };
  walk(diag);
  return lines.join('\n');
}

/**
 * Runs Migadu's checks and activates the domain when they pass.
 * Returns { status, activated, message, report }.
 */
export async function checkAndActivate(domain) {
  const api = await migadu();
  let current = await remote(() => api.getDomain(domain));
  if (!current) fail(`${domain} does not exist in Migadu.`);

  let diagnostics = null;
  try {
    diagnostics = await api.diagnostics(domain);
  } catch (e) {
    diagnostics = { error: e.message };
  }

  let activated = false;
  let message;
  if (domainStatus(current) === 'Active') {
    message = 'Domain is active in Migadu.';
  } else {
    const res = await remote(() => api.activate(domain));
    activated = res.ok;
    message = res.ok ? 'Domain activated in Migadu.' : `Not activated yet: ${res.message}`;
    current = res.ok ? res.domain || (await api.getDomain(domain)) : current;
  }

  const status = domainStatus(current);
  const report = [
    `Migadu check for ${domain} — ${now()}`,
    `Status: ${status}${current?.can_send === false ? ' (sending disabled)' : ''}${current?.can_receive === false ? ' (receiving disabled)' : ''}`,
    message,
    '',
    'Diagnostics:',
    describeDiagnostics(diagnostics),
  ].join('\n');
  return { status, activated, message, report, activatedAt: current?.activated_at || null };
}

/* ------------------------------------------------------------------ */
/* Mailbox password                                                    */
/* ------------------------------------------------------------------ */

/** Asks Migadu to email the owner a link to choose a new password. */
export async function sendMailboxInvitation(doc, recoveryEmail) {
  const email = String(recoveryEmail || doc.recovery_email || '').trim();
  if (!isEmail(email)) fail('Enter the email where the invitation should go.');
  if (email.toLowerCase() === doc.name) fail('The invitation must go to a different address than the mailbox itself.');

  const api = await migadu();
  await remote(() => api.updateMailbox(doc.domain, doc.local_part, {
    password_method: 'invitation',
    password_recovery_email: email,
  }));
  forgetMail(doc.domain);
  return email;
}

/** Sets the password directly. It goes to Migadu only; Loopar does not store it. */
export async function setMailboxPassword(doc, password) {
  password = String(password ?? '');
  if (password.length < 10) fail('Use at least 10 characters.');
  const api = await migadu();
  await remote(() => api.updateMailbox(doc.domain, doc.local_part, { password }));
}

/* ------------------------------------------------------------------ */
/* Import from Migadu                                                  */
/* ------------------------------------------------------------------ */

const one = async (entity, fields, filter) => (await loopar.db.getAll(entity, fields, filter))[0] || null;

/** "user@domain.com" → { localPart, domain } (null when it isn't an address). */
export function splitAddress(address) {
  const [localPart, domain, ...rest] = String(address || '').trim().toLowerCase().split('@');
  return localPart && domain && !rest.length ? { localPart, domain } : null;
}

/** Mailboxes of one domain, from Migadu (shared for a few seconds: see remote-cache.js). */
export async function remoteMailboxes(domain, api = null) {
  return await cached(`mail:${domain}:mailboxes`, async () => {
    api = api || await migadu();
    return (await remote(() => api.listMailboxes(domain))).map((m) => mailboxValues(domain, m));
  });
}

/** Aliases of one domain, from Migadu (shared for a few seconds). */
export async function remoteAliases(domain, api = null) {
  return await cached(`mail:${domain}:aliases`, async () => {
    api = api || await migadu();
    return (await remote(() => api.listAliases(domain))).map((a) => aliasValues(domain, a));
  });
}

/** A mailbox or alias of `domain` changed through Loopar: the next read asks Migadu again. */
export const forgetMail = (domain) => forget(`mail:${domain}:`);

/**
 * Mailboxes or aliases of every Mail Domain registered here, live from
 * Migadu (one call per domain, in parallel), sorted by address.
 */
export async function remoteRecords(list) {
  const domains = await loopar.db.getAll(DOMAIN, ['name']);
  if (!domains.length) return [];
  const api = await migadu();
  const rows = (await Promise.all(domains.map((d) => list(d.name, api)))).flat();
  return rows.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
}

/** Form values of a Migadu mailbox. */
export function mailboxValues(domain, m) {
  const lp = String(m.local_part).toLowerCase();
  return {
    name: `${lp}@${domain}`,
    address: `${lp}@${domain}`,
    domain,
    local_part: lp,
    display_name: m.name || '',
    recovery_email: m.password_recovery_email || '',
    // Inactive: can't send, receive or sign in — the mailbox and its mail are kept.
    status: [m.may_send, m.may_receive, m.may_access_imap].every((v) => v === false) ? 'Inactive' : 'Active',
    may_send: m.may_send === false ? 0 : 1,
    may_receive: m.may_receive === false ? 0 : 1,
    may_access_imap: m.may_access_imap === false ? 0 : 1,
    is_internal: m.is_internal ? 1 : 0,
  };
}

/** Form values of a Migadu alias. */
export function aliasValues(domain, a) {
  const lp = String(a.local_part).toLowerCase();
  const dest = Array.isArray(a.destinations) ? a.destinations : String(a.destinations || '').split(',');
  return {
    name: `${lp}@${domain}`,
    address: `${lp}@${domain}`,
    domain,
    local_part: lp,
    destinations: dest.map((x) => String(x).trim()).filter(Boolean).join('\n'),
    is_internal: a.is_internal ? 1 : 0,
  };
}

async function upsertLocal(entity, values) {
  const exists = await one(entity, ['name'], { name: values.name });
  if (exists) {
    const { name, ...rest } = values;
    await loopar.db.updateRow(entity, name, rest);
    return 'updated';
  }
  const doc = await loopar.newDocument(entity, values);
  fromRemote(doc);
  await doc.save();
  return 'created';
}

/** Every Migadu domain → a Mail Domain here (mailboxes and aliases are read live, never copied). */
export async function importAll() {
  const api = await migadu();
  const domains = await remote(() => api.listDomains());
  const summary = [];
  for (const d of domains) {
    const name = normName(d.name);
    if (!name) continue;
    const values = {
      name,
      status: domainStatus(d),
      activated_at: d.activated_at || '',
    };
    let result;
    try {
      result = await upsertLocal(DOMAIN, values);
    } catch (e) {
      summary.push(`${name}: failed — ${e?.message || e}`);
      continue;
    }
    summary.push(`${name}: ${result}`);
  }
  return summary;
}
