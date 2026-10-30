'use strict';

/*
 * Server glue between the mail entities and the Migadu / Cloudflare APIs.
 * Business rules for DNS live in dns-plan.js (pure); this file reads the
 * settings, talks to the providers and writes local records.
 */

import { loopar } from 'loopar';
import { createMigadu } from './migadu.js';
import { createCloudflare, applyPlan } from './cloudflare.js';
import { planDns, describePlan, normName } from './dns-plan.js';

export const SETTINGS = 'Mail Hosting Settings';
export const DOMAIN = 'Mail Domain';
export const MAILBOX = 'Mailbox';
export const ALIAS = 'Mail Alias';

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
    dmarc_policy: doc?.dmarc_policy || 'quarantine',
    dmarc_report_email: doc?.dmarc_report_email || '',
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
export async function configureDns(domain, { dryRun = false } = {}) {
  const api = await migadu();
  const cf = await cloudflare();
  const s = await settings();

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
    dmarc: { policy: s.dmarc_policy, rua: s.dmarc_report_email },
  });

  const ops = dryRun ? plan.ops : await applyPlan(cf, zone.id, plan.ops);
  const errors = ops.filter((o) => o.error).map((o) => `${o.op} ${o.type} ${o.name}: ${o.error}`);
  const header = `${dryRun ? 'DNS plan' : 'DNS applied'} for ${domain} (Cloudflare zone ${zone.name}) — ${now()}`;
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
/* Import from Migadu                                                  */
/* ------------------------------------------------------------------ */

const one = async (entity, fields, filter) => (await loopar.db.getAll(entity, fields, filter))[0] || null;

/** Local values of a Migadu mailbox. */
export function mailboxValues(domain, m) {
  const lp = String(m.local_part).toLowerCase();
  return {
    name: `${lp}@${domain}`,
    address: `${lp}@${domain}`,
    domain,
    local_part: lp,
    // Only when Migadu returns them: an import never blanks local values.
    ...(m.name ? { display_name: m.name } : {}),
    ...(m.password_recovery_email ? { recovery_email: m.password_recovery_email } : {}),
    may_send: m.may_send === false ? 0 : 1,
    may_receive: m.may_receive === false ? 0 : 1,
    may_access_imap: m.may_access_imap === false ? 0 : 1,
    is_internal: m.is_internal ? 1 : 0,
  };
}

/** Local values of a Migadu alias. */
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

/**
 * Mailboxes and aliases of one domain, Migadu → local. Local-only rows are
 * reported, not deleted. A record that cannot be saved is reported in
 * `failed` and the rest still import.
 */
export async function importDomainContent(domain) {
  const api = await migadu();
  const counts = { mailboxes: { created: 0, updated: 0 }, aliases: { created: 0, updated: 0 }, localOnly: [], failed: [] };

  const pull = async (entity, values, bucket) => {
    try {
      bucket[await upsertLocal(entity, values)]++;
    } catch (e) {
      counts.failed.push(`${values.name}: ${e?.message || e}`);
    }
  };

  const mailboxes = await remote(() => api.listMailboxes(domain));
  const remoteMb = new Set();
  for (const m of mailboxes) {
    const values = mailboxValues(domain, m);
    remoteMb.add(values.name);
    await pull(MAILBOX, values, counts.mailboxes);
  }

  const aliases = await remote(() => api.listAliases(domain));
  const remoteAl = new Set();
  for (const a of aliases) {
    const values = aliasValues(domain, a);
    remoteAl.add(values.name);
    await pull(ALIAS, values, counts.aliases);
  }

  for (const r of await loopar.db.getAll(MAILBOX, ['name'], { domain })) if (!remoteMb.has(r.name)) counts.localOnly.push(r.name);
  for (const r of await loopar.db.getAll(ALIAS, ['name'], { domain })) if (!remoteAl.has(r.name)) counts.localOnly.push(r.name);
  return counts;
}

/** Every Migadu domain (and its mailboxes/aliases) → local records. */
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
    const content = await importDomainContent(name);
    const failed = content.failed.length ? ` — failed: ${content.failed.join('; ')}` : '';
    summary.push(`${name}: domain ${result}, ${content.mailboxes.created + content.mailboxes.updated} mailbox(es), ${content.aliases.created + content.aliases.updated} alias(es)${failed}`);
  }
  return summary;
}
