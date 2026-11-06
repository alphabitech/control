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

/** DMARC tags in order, e.g. "v=DMARC1; p=none; rua=…" → [["v","DMARC1"],["p","none"],["rua","…"]]. */
export function parseDmarc(txt) {
  const tags = [];
  for (const part of String(txt || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (key && !tags.some(([k]) => k === key)) tags.push([key, value]);
  }
  return tags;
}

const serializeDmarc = (tags) => tags.map(([k, v]) => `${k}=${k === 'v' ? 'DMARC1' : v}`).join('; ');
const sameDmarc = (a, b) => serializeDmarc(parseDmarc(a)) === serializeDmarc(parseDmarc(b));

/**
 * DMARC value from a policy, keeping every tag the policy doesn't set (rua of
 * an existing record, pct, adkim…). `dmarc`: { policy, subdomain, reports, rua }
 *   policy:    keep | none | quarantine | reject   (keep = current p, quarantine if none)
 *   subdomain: inherit | none | quarantine | reject (inherit = no sp tag)
 *   reports:   keep | custom | none                 (custom = rua → `rua`)
 */
export function composeDmarc(existing, dmarc = {}) {
  const tags = new Map(parseDmarc(existing));
  tags.delete('v');
  const p = ['none', 'quarantine', 'reject'].includes(dmarc.policy) ? dmarc.policy : null;
  if (p) tags.set('p', p);
  else if (!/^(none|quarantine|reject)$/i.test(tags.get('p') || '')) tags.set('p', 'quarantine');

  if (dmarc.subdomain === 'inherit') tags.delete('sp');
  else if (['none', 'quarantine', 'reject'].includes(dmarc.subdomain)) tags.set('sp', dmarc.subdomain);

  if (dmarc.reports === 'none') tags.delete('rua');
  else if (dmarc.reports === 'custom' && dmarc.rua) tags.set('rua', `mailto:${String(dmarc.rua).replace(/^mailto:/i, '')}`);

  const { p: policy, ...rest } = Object.fromEntries(tags);
  return serializeDmarc([['v', 'DMARC1'], ['p', policy], ...Object.entries(rest)]);
}

/** Senders a policy can authorize with a switch: field → SPF term. */
export const KNOWN_SENDERS = {
  sender_google: 'include:_spf.google.com',
  sender_microsoft: 'include:spf.protection.outlook.com',
  sender_amazon_ses: 'include:amazonses.com',
  sender_sendgrid: 'include:sendgrid.net',
  sender_mailgun: 'include:mailgun.org',
  sender_brevo: 'include:spf.brevo.com',
  sender_zoho: 'include:zoho.com',
};

const SPF_TERM = /^[+\-~?]?(include:[a-z0-9._-]+|ip4:[0-9./]+|ip6:[0-9a-f:./]+|a|a:[a-z0-9._-]+|mx|mx:[a-z0-9._-]+|exists:[a-z0-9._%{}-]+)$/i;

/** Extra SPF terms from free text (one per line or space separated). Bare domains become include:. */
export function parseSpfTerms(text) {
  const terms = [];
  const invalid = [];
  for (let t of String(text || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) {
    if (/^[a-z0-9._-]+\.[a-z]{2,}$/i.test(t)) t = `include:${t}`;
    if (SPF_TERM.test(t)) terms.push(t.toLowerCase());
    else invalid.push(t);
  }
  return { terms, invalid };
}

/**
 * Plain policy object from a Mail Policy record (or null = conservative: merge
 * SPF, keep a valid DMARC).
 */
export function policyFromValues(v) {
  if (!v) return null;
  const on = (x) => [1, '1', true, 'true'].includes(x);
  const extra = [
    ...Object.entries(KNOWN_SENDERS).filter(([field]) => on(v[field])).map(([, term]) => term),
    ...parseSpfTerms(v.spf_custom).terms,
  ];
  return {
    spf: {
      mode: v.spf_mode === 'merge' ? 'merge' : 'strict',
      all: v.spf_all === '~all' ? '~' : '-',
      extra: [...new Set(extra)],
    },
    dmarc: {
      policy: v.dmarc_policy || 'quarantine',
      subdomain: v.dmarc_subdomain || 'inherit',
      reports: v.dmarc_reports || 'keep',
      rua: v.dmarc_rua || '',
    },
  };
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

/** Adds terms to an SPF value before its "all"/redirect (no duplicates). */
export function mergeSpfExtra(value, terms) {
  const parts = String(value).trim().split(/\s+/);
  const tailIndex = parts.findIndex((t) => /^[+\-~?]?all$/i.test(t) || /^redirect=/i.test(t));
  const head = tailIndex < 0 ? parts : parts.slice(0, tailIndex);
  const tail = tailIndex < 0 ? [] : parts.slice(tailIndex);
  for (const t of terms) if (!head.some((x) => x.toLowerCase() === t.toLowerCase())) head.push(t);
  return [...head, ...tail].join(' ');
}

/**
 * Migadu's /records payload → flat list of wanted records (FQDN names).
 */
export function wantedRecords(migadu, domain) {
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
    out.push({ role: 'dmarc', type: 'TXT', name: fqdn(migadu.dmarc.name, domain), content: String(migadu.dmarc.value).trim() });
  }
  return out;
}

/**
 * existing: [{ id, type, name, content, priority, proxied }] from the provider.
 * Returns { ops: [{ op, type, name, content, priority, id, reason }], warnings }.
 * op is one of create | update | delete | keep.
 */
export function planDns({ domain, migadu, existing = [], policy = null }) {
  const d = normName(domain);
  const want = wantedRecords(migadu, d);
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

  // SPF: a single record. Strict policy = exactly Migadu + the policy's
  // senders; merge (or no policy) = whatever is there plus Migadu.
  const wantSpf = want.find((x) => x.role === 'spf');
  if (wantSpf) {
    const include = (wantSpf.content.split(/\s+/).find((t) => /^include:/i.test(t))) || SPF_INCLUDE_DEFAULT;
    const extra = policy?.spf?.extra || [];
    const spf = at(d, 'TXT').filter((r) => isSpf(r.content));
    let value;
    let reason;
    if (policy?.spf?.mode === 'strict') {
      value = ['v=spf1', include, ...extra.filter((t) => t.toLowerCase() !== include.toLowerCase()), `${policy.spf.all}all`].join(' ');
      reason = 'SPF set by the mail policy';
      const lookups = spfLookupCount(value);
      if (lookups > 10) warnings.push(`SPF needs ${lookups} DNS lookups (the limit is 10); some receivers will treat it as invalid.`);
    } else if (spf.length) {
      const merged = mergeSpf([...spf.map((r) => r.content)], include);
      const withExtra = extra.length ? mergeSpfExtra(merged.value, extra) : merged.value;
      warnings.push(...merged.warnings);
      value = withExtra;
      reason = spf.length > 1 ? `merged ${spf.length} SPF records into one` : 'mail server added to existing SPF';
    } else {
      value = extra.length ? mergeSpfExtra(wantSpf.content, extra) : wantSpf.content;
      reason = 'SPF';
    }

    if (!spf.length) {
      create({ ...wantSpf, content: value }, reason);
    } else {
      const [first, ...rest] = spf;
      if (value === first.content.replace(/\s+/g, ' ')) keep(first, 'SPF');
      else update(first, { ...wantSpf, content: value }, reason);
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

  // DMARC: a single record. With a policy its p/sp/rua are set (other tags of
  // the current record are kept); without one a valid record is respected.
  const wantDmarc = want.find((x) => x.role === 'dmarc');
  const dmarcCname = wantDmarc && at(wantDmarc.name, 'CNAME')[0];
  if (dmarcCname) {
    keep(dmarcCname, 'DMARC delegated by CNAME');
    warnings.push(`${wantDmarc.name} is a CNAME to ${dmarcCname.content} (delegated DMARC); left as is.`);
  } else if (wantDmarc) {
    const txt = at(wantDmarc.name, 'TXT');
    const rank = { reject: 0, quarantine: 1, none: 2 };
    // The strictest valid record is the base when there are duplicates.
    const valid = txt.filter((r) => isValidDmarc(r.content))
      .sort((a, b) => rank[dmarcPolicy(a.content)] - rank[dmarcPolicy(b.content)]);
    const base = valid[0] || txt[0] || null;

    let value;
    let reason;
    if (policy?.dmarc) {
      value = composeDmarc(valid[0]?.content || '', policy.dmarc);
      reason = 'DMARC set by the mail policy';
    } else if (valid[0]) {
      value = valid[0].content;
      reason = `DMARC (policy ${dmarcPolicy(valid[0].content)})`;
    } else {
      value = wantDmarc.content;
      reason = txt.length ? 'invalid DMARC record replaced' : 'DMARC';
    }

    if (!base) create({ ...wantDmarc, content: value }, reason);
    else if (isValidDmarc(base.content) && sameDmarc(base.content, value)) keep(base, reason);
    else update(base, { ...wantDmarc, content: value }, reason);
    for (const r of txt) if (r !== base) remove(r, isDmarc(r.content) ? 'duplicate DMARC record' : 'invalid DMARC record');
    if (dmarcPolicy(value) === 'none') warnings.push('DMARC policy is "none": spoofed mail is still delivered. Consider quarantine.');
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
