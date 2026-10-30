'use strict';

/*
 * Pure DNS planning for a Migadu-hosted domain (no loopar, no network).
 *
 * Given the records Migadu asks for (GET /domains/{d}/records) and the
 * records the DNS provider currently has, decides what to create, update,
 * delete or keep so mail works without breaking what is already there:
 *   - one SPF record only (an existing one is merged, never duplicated),
 *   - one DMARC record only (a valid existing policy is respected),
 *   - MX records of other providers are removed (mail would be split),
 *   - DKIM CNAMEs are never proxied.
 */

const SPF_INCLUDE_DEFAULT = 'include:spf.migadu.com';
const SPF_LOOKUP_TERMS = /^[+\-~?]?(include:|a\b|a:|a\/|mx\b|mx:|mx\/|ptr\b|ptr:|exists:)/i;

/** Lowercase, no trailing dot. */
export const normName = (v) => String(v || '').trim().toLowerCase().replace(/\.$/, '');

/** Record name as Migadu writes it ("@", "key1._domainkey") → FQDN. */
export function fqdn(name, domain) {
  const n = normName(name);
  const d = normName(domain);
  if (!n || n === '@') return d;
  if (n === d || n.endsWith(`.${d}`)) return n;
  return `${n}.${d}`;
}

/**
 * TXT content as plain text. Providers may return it quoted, and long values
 * split in several quoted strings ("abc" "def").
 */
export function unquoteTxt(content) {
  const s = String(content ?? '').trim();
  if (!s.startsWith('"')) return s;
  const parts = s.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return s;
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

export const isSpf = (txt) => /^v=spf1(\s|$)/i.test(String(txt || '').trim());
export const isDmarc = (txt) => /^v=DMARC1\s*;/i.test(String(txt || '').trim());

/** A DMARC record that receivers will accept: v=DMARC1 first and a valid p= tag. */
export function isValidDmarc(txt) {
  const s = String(txt || '').trim();
  if (!isDmarc(s)) return false;
  const tags = s.split(';').map((t) => t.trim()).filter(Boolean);
  const p = tags.find((t) => /^p\s*=/i.test(t));
  return !!p && /^p\s*=\s*(none|quarantine|reject)$/i.test(p);
}

export function dmarcPolicy(txt) {
  const m = String(txt || '').match(/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\s*(?:;|$)/i);
  return m ? m[1].toLowerCase() : null;
}

/** DMARC value to publish: Migadu's suggestion with our policy and optional rua. */
export function buildDmarc({ policy = 'quarantine', rua = '' } = {}) {
  const p = ['none', 'quarantine', 'reject'].includes(policy) ? policy : 'quarantine';
  const parts = ['v=DMARC1', `p=${p}`];
  if (rua) parts.push(`rua=mailto:${String(rua).replace(/^mailto:/i, '')}`);
  return `${parts.join('; ')};`;
}

/** DNS-lookup terms in an SPF value (RFC 7208 caps them at 10). */
export function spfLookupCount(value) {
  return String(value || '').split(/\s+/).filter((t) => SPF_LOOKUP_TERMS.test(t) || /^redirect=/i.test(t)).length;
}

/**
 * Merges SPF values into one that also authorizes `include`.
 * Returns { value, changed, warnings }.
 */
export function mergeSpf(values, include = SPF_INCLUDE_DEFAULT) {
  const warnings = [];
  const terms = [];
  const qualifiers = [];
  let redirect = null;

  for (const v of values) {
    for (const t of String(v).trim().split(/\s+/).slice(1)) {
      if (!t) continue;
      const all = t.match(/^([+\-~?]?)all$/i);
      if (all) { qualifiers.push(all[1] || '+'); continue; }
      if (/^redirect=/i.test(t)) { redirect = redirect || t; continue; }
      if (!terms.some((x) => x.toLowerCase() === t.toLowerCase())) terms.push(t);
    }
  }

  const hasInclude = terms.some((t) => t.toLowerCase() === include.toLowerCase());
  if (!hasInclude) terms.push(include);

  let tail;
  if (redirect && !qualifiers.length) {
    tail = redirect;
    warnings.push(`SPF uses "${redirect}"; ${include} was added before it — review that the redirected policy still applies.`);
  } else {
    if (redirect) warnings.push(`SPF had both "all" and "${redirect}"; the redirect was dropped (it is ignored when "all" is present).`);
    const unique = [...new Set(qualifiers)];
    let q;
    if (!unique.length) q = '-';
    else if (unique.length === 1) q = unique[0];
    else q = '~';
    if (q === '+') {
      q = '~';
      warnings.push('SPF ended in "+all" (anyone may send as this domain); it was tightened to "~all".');
    }
    tail = `${q}all`;
  }

  const value = ['v=spf1', ...terms, tail].join(' ');
  const changed = values.length !== 1 || value !== String(values[0]).trim().replace(/\s+/g, ' ');
  const lookups = spfLookupCount(value);
  if (lookups > 10) warnings.push(`SPF needs ${lookups} DNS lookups (the limit is 10); some receivers will treat it as invalid.`);
  return { value, changed, warnings };
}

/**
 * Migadu's /records payload → flat list of wanted records (FQDN names).
 */
export function wantedRecords(migadu, domain, { dmarc } = {}) {
  const out = [];
  const add = (r, role) => r && out.push({
    role,
    type: String(r.type || '').toUpperCase(),
    name: fqdn(r.name, domain),
    content: normName(r.type).toLowerCase() === 'txt' ? String(r.value).trim() : normName(r.value),
    priority: r.priority != null ? Number(r.priority) : undefined,
  });

  add(migadu?.dns_verification, 'verification');
  for (const r of migadu?.mx_records || []) add(r, 'mx');
  add(migadu?.spf, 'spf');
  for (const r of migadu?.dkim || []) add(r, 'dkim');
  if (migadu?.dmarc) {
    const value = dmarc ? buildDmarc(dmarc) : String(migadu.dmarc.value).trim();
    out.push({ role: 'dmarc', type: 'TXT', name: fqdn(migadu.dmarc.name, domain), content: value });
  }
  return out;
}

/**
 * existing: [{ id, type, name, content, priority, proxied }] from the provider.
 * Returns { ops: [{ op, type, name, content, priority, id, reason }], warnings }.
 * op is one of create | update | delete | keep.
 */
export function planDns({ domain, migadu, existing = [], dmarc = null }) {
  const d = normName(domain);
  const want = wantedRecords(migadu, d, { dmarc });
  const recs = existing.map((r) => ({
    ...r,
    type: String(r.type || '').toUpperCase(),
    name: normName(r.name),
    content: String(r.type).toUpperCase() === 'TXT' ? unquoteTxt(r.content) : normName(r.content),
    priority: r.priority != null ? Number(r.priority) : undefined,
  }));
  const at = (name, type) => recs.filter((r) => r.name === name && (!type || r.type === type));

  const ops = [];
  const warnings = [];
  const keep = (r, reason) => ops.push({ op: 'keep', type: r.type, name: r.name, content: r.content, priority: r.priority, id: r.id, reason });
  const create = (w, reason) => ops.push({ op: 'create', type: w.type, name: w.name, content: w.content, priority: w.priority, reason });
  const update = (r, w, reason) => ops.push({ op: 'update', id: r.id, type: w.type, name: w.name, content: w.content, priority: w.priority, from: r.content, reason });
  const remove = (r, reason) => ops.push({ op: 'delete', id: r.id, type: r.type, name: r.name, content: r.content, priority: r.priority, reason });

  // Verification TXT: one more TXT at the apex, never replaces others.
  for (const w of want.filter((x) => x.role === 'verification')) {
    const found = at(w.name, 'TXT').find((r) => r.content === w.content);
    found ? keep(found, 'verification') : create(w, 'domain verification');
  }

  // MX: exactly Migadu's hosts.
  const wantMx = want.filter((x) => x.role === 'mx');
  if (wantMx.length) {
    const mx = at(d, 'MX');
    const used = new Set();
    for (const w of wantMx) {
      const found = mx.find((r) => r.content === w.content);
      if (!found) { create(w, 'mail server'); continue; }
      used.add(found.id);
      if (w.priority != null && found.priority !== w.priority) update(found, w, `priority ${found.priority} → ${w.priority}`);
      else keep(found, 'mail server');
    }
    for (const r of mx) if (!used.has(r.id)) remove(r, 'MX of another provider (mail would be split between providers)');
  }

  // SPF: a single record.
  const wantSpf = want.find((x) => x.role === 'spf');
  if (wantSpf) {
    const include = (wantSpf.content.split(/\s+/).find((t) => /^include:/i.test(t))) || SPF_INCLUDE_DEFAULT;
    const spf = at(d, 'TXT').filter((r) => isSpf(r.content));
    if (!spf.length) {
      create(wantSpf, 'SPF');
    } else {
      const merged = mergeSpf(spf.map((r) => r.content), include);
      warnings.push(...merged.warnings);
      const [first, ...rest] = spf;
      if (merged.value === first.content) keep(first, 'SPF already authorizes the mail server');
      else update(first, { ...wantSpf, content: merged.value }, spf.length > 1 ? `merged ${spf.length} SPF records into one` : 'mail server added to existing SPF');
      for (const r of rest) remove(r, 'duplicate SPF record (only one is allowed)');
    }
  }

  // DKIM: CNAMEs, never proxied.
  for (const w of want.filter((x) => x.role === 'dkim')) {
    const here = at(w.name);
    const cname = here.find((r) => r.type === 'CNAME');
    const others = here.filter((r) => r.type !== 'CNAME');
    if (others.length) {
      warnings.push(`${w.name} has ${others.map((r) => r.type).join(', ')} record(s); a CNAME cannot coexist with them. Remove them and run again.`);
      continue;
    }
    if (!cname) create(w, 'DKIM key');
    else if (cname.content !== w.content) update(cname, w, 'DKIM target changed');
    else if (cname.proxied) update(cname, w, 'DKIM must not be proxied');
    else keep(cname, 'DKIM key');
  }

  // DMARC: a single valid record; an existing valid policy is respected.
  const wantDmarc = want.find((x) => x.role === 'dmarc');
  const dmarcCname = wantDmarc && at(wantDmarc.name, 'CNAME')[0];
  if (dmarcCname) {
    keep(dmarcCname, 'DMARC delegated by CNAME');
    warnings.push(`${wantDmarc.name} is a CNAME to ${dmarcCname.content} (delegated DMARC); left as is.`);
  } else if (wantDmarc) {
    const txt = at(wantDmarc.name, 'TXT');
    const rank = { reject: 0, quarantine: 1, none: 2 };
    // The strictest valid policy wins when there are duplicates.
    const valid = txt.filter((r) => isValidDmarc(r.content))
      .sort((a, b) => rank[dmarcPolicy(a.content)] - rank[dmarcPolicy(b.content)]);
    if (valid.length) {
      const [first] = valid;
      keep(first, `DMARC (policy ${dmarcPolicy(first.content)})`);
      if (dmarcPolicy(first.content) === 'none') warnings.push('DMARC policy is "none": spoofed mail is still delivered. Consider quarantine.');
      for (const r of txt) if (r !== first) remove(r, isDmarc(r.content) ? 'duplicate DMARC record' : 'invalid DMARC record');
    } else if (txt.length) {
      const [first, ...rest] = txt;
      update(first, wantDmarc, 'invalid DMARC record replaced');
      for (const r of rest) remove(r, 'invalid DMARC record');
    } else {
      create(wantDmarc, 'DMARC');
    }
  }

  return { ops, warnings };
}

/** Human-readable summary of a plan/apply result. */
export function describePlan({ ops = [], warnings = [], errors = [] }) {
  const sign = { create: '+', update: '~', delete: '-', keep: '=' };
  const lines = ops.map((o) => {
    const prio = o.priority != null && o.type === 'MX' ? ` ${o.priority}` : '';
    const err = o.error ? `  ✗ ${o.error}` : '';
    return `${sign[o.op] || '?'} ${o.type}${prio} ${o.name} → ${o.content}  (${o.reason})${err}`;
  });
  if (warnings.length) lines.push('', 'Warnings:', ...warnings.map((w) => `! ${w}`));
  if (errors.length) lines.push('', 'Errors:', ...errors.map((e) => `✗ ${e}`));
  return lines.join('\n');
}
