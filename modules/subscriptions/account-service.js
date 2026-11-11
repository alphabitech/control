'use strict';

/*
 * Customer self-service ("Cloud Account" portal page) — server side.
 *
 * Everything a customer sees or changes is resolved from the logged-in user
 * through the core portal identity (User → Customer Contact → Customer, see
 * loopar/core/auth/customer-scope.js); nothing here trusts a customer name
 * sent by the client.
 *
 *   Billing   → Stripe is the source of truth (subscriptions are read live).
 *   Websites  → tenants named in the customer's subscriptions / mail domains.
 *   Email     → Mail Domains owned by the customer (`Mail Domain.customer`).
 */

import { loopar, tenant, requirePortalIdentity, Op, tenantUserUsage, getTenantInstance } from 'loopar';
import { ensureCustomerContact, grantPortalAccess as grantContactAccess, customerContacts } from '../../../loopar/modules/crm/portal-access.js';
import Stripe from 'stripe';
import { keyMode } from '../stripe/stripe-keys.js';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { controlPlaneBaseUrlFromReq } from './portal-link-issuer.js';
import { completeLogin } from '../../../loopar/modules/auth/controllers/auth/mfa.js';
import { settings as mailSettings, DOMAIN, MAILBOX, ALIAS, splitAddress, remoteMailboxes } from '../mail-hosting/mail-service.js';
import { stripeIdOf, setStripeId } from './stripe-customer.js';

export const PAGE = 'Cloud Account';
export const PAGE_PATH = `/portal/${encodeURIComponent(PAGE)}/view`;

/** Stripe statuses where the service is running (past_due: Stripe is still retrying). */
export const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

const ACTIVATION_PURPOSE = 'portal-activation';
const ACTIVATION_TTL = '7d';
const PRODUCT_TTL_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Throws a user-facing error. */
export const fail = (message, code = 400) => loopar.throw({ code, title: 'Account', message });

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

/** Public base URL of the control plane: request host first, CONTROL_PLANE_URL for background jobs. */
export function baseUrl(req = null) {
  const base = controlPlaneBaseUrlFromReq(req) || process.env.CONTROL_PLANE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return String(base).replace(/\/+$/, '');
}

export const pageUrl = (req, query = '') => `${baseUrl(req)}${PAGE_PATH}${query ? `?${query}` : ''}`;

/* ------------------------------------------------------------------ */
/* Stripe                                                              */
/* ------------------------------------------------------------------ */

export async function stripeClient({ required = true } = {}) {
  const account = await loopar.getDocument('Stripe Account', null, null, { ifNotFound: null });
  if (!account?.secret_key) {
    if (required) fail('Billing is not available right now. Please try again later.', 503);
    return null;
  }
  return new Stripe(account.secret_key);
}

/** The key decides: the Secret Key's mode; the stored label only when the key doesn't tell. */
const activeModeOf = (account) => keyMode(account?.secret_key) || (account?.mode === 'live' ? 'live' : 'test');

/** The mode billing runs in ('live' | 'test'): the mode of the Secret Key. */
export async function stripeMode() {
  const account = await loopar.getDocument('Stripe Account', null, null, { ifNotFound: null });
  return activeModeOf(account);
}

/**
 * Stripe client of a given mode, for preparing Plans. The active mode uses the
 * account's key; 'test' on a live account uses its Test secret key. null when
 * that mode has no key here (a test account never reaches live).
 */
export async function stripeClientFor(mode) {
  const account = await loopar.getDocument('Stripe Account', null, null, { ifNotFound: null });
  const active = activeModeOf(account);
  const key = mode === active ? account?.secret_key : (mode === 'test' ? account?.test_secret_key : null);
  // Never hand out a client of another mode than the one asked for.
  if (!key || (keyMode(key) && keyMode(key) !== mode)) return null;
  return new Stripe(key);
}

const productCache = new Map();

async function product(stripe, id) {
  if (!id) return null;
  if (typeof id === 'object') return id;
  const hit = productCache.get(id);
  if (hit && hit.at > Date.now() - PRODUCT_TTL_MS) return hit.value;
  const value = await stripe.products.retrieve(id).catch(() => null);
  productCache.set(id, { at: Date.now(), value });
  return value;
}

/** The Stripe customer id of a local Customer, looked up by email (and stored) when missing. */
export async function stripeCustomerId(customer, stripe) {
  if (customer.stripe_customer_id) return customer.stripe_customer_id;
  const stored = await stripeIdOf(customer.name);
  if (stored) return stored;
  if (!customer.email) return null;
  const found = await stripe.customers.list({ email: customer.email, limit: 1 });
  const id = found?.data?.[0]?.id || null;
  if (id) await setStripeId(customer.name, id);
  return id;
}

/** One Stripe subscription, shaped for the portal. */
async function shapeSubscription(stripe, sub) {
  const item = sub.items?.data?.[0] || {};
  const price = item.price || {};
  const prod = await product(stripe, price.product);
  const limit = parseInt(prod?.metadata?.mailboxes ?? price.metadata?.mailboxes, 10);
  return {
    id: sub.id,
    status: sub.status,
    plan: prod?.name || price.nickname || 'Plan',
    amount: price.unit_amount ?? null,
    currency: price.currency || 'usd',
    interval: price.recurring?.interval || null,
    interval_count: price.recurring?.interval_count || 1,
    price_id: price.id || null,
    // Newer Stripe API versions moved the period onto the items.
    current_period_end: iso(sub.current_period_end ?? item.current_period_end),
    trial_end: iso(sub.trial_end),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    cancel_at: iso(sub.cancel_at),
    ended_at: iso(sub.ended_at || sub.canceled_at),
    tenant_name: sub.metadata?.tenant_name || null,
    mailbox_limit: Number.isFinite(limit) && limit >= 0 ? limit : null,
    user_limit: planLimits(prod).users ?? null,
  };
}

/** Workspace limits a plan (Stripe product) grants: { users } — absent = unlimited. */
export function planLimits(prod) {
  const users = parseInt(prod?.metadata?.users, 10);
  return Number.isFinite(users) && users > 0 ? { users } : {};
}

/**
 * Writes the plan's limits of a running Stripe subscription into its
 * workspace (sites/<tenant>/config.json), where the framework enforces them.
 * Only when they changed; a workspace that doesn't exist is skipped.
 */
export async function applyPlanLimits(stripe, sub) {
  const name = sub?.metadata?.tenant_name;
  if (!name || !LIVE_STATUSES.has(sub.status)) return false;
  const current = tenant.readTenant(name);
  if (!current) return false;
  const price = sub.items?.data?.[0]?.price || {};
  const prod = await product(stripe, typeof price.product === 'string' ? price.product : price.product?.id);
  if (!prod) return false;
  const next = { ...(current.limits || {}) };
  delete next.users;
  Object.assign(next, planLimits(prod));
  if (JSON.stringify(next) === JSON.stringify(current.limits || {})) return false;
  await tenant.saveTenant({ name, limits: next });
  return true;
}

/**
 * The customer's subscriptions, live from Stripe. Per workspace only the
 * current one is kept (a canceled sub is hidden once a newer one exists).
 */
export async function customerSubscriptions(customer, stripe = null) {
  stripe = stripe || await stripeClient({ required: false });
  if (!stripe) return [];
  const id = await stripeCustomerId(customer, stripe);
  if (!id) return [];

  const res = await stripe.subscriptions.list({ customer: id, status: 'all', limit: 100, expand: ['data.items.data.price'] });
  const subs = [];
  for (const s of res?.data || []) {
    if (s.status === 'incomplete_expired') continue;
    subs.push(await shapeSubscription(stripe, s));
  }

  const rank = (s) => (LIVE_STATUSES.has(s.status) ? 2 : s.status === 'canceled' ? 0 : 1);
  const byTenant = new Map();
  const out = [];
  for (const s of subs) {
    if (!s.tenant_name) { out.push(s); continue; }
    const prev = byTenant.get(s.tenant_name);
    if (!prev || rank(s) > rank(prev)) byTenant.set(s.tenant_name, s);
  }
  return [...out, ...byTenant.values()];
}

/** The subscription that covers a workspace (null when none). */
export function subscriptionOfTenant(subs, tenantName) {
  if (!tenantName) return null;
  return subs.find((s) => s.tenant_name === tenantName) || null;
}

/* ------------------------------------------------------------------ */
/* Customer of the logged-in user                                      */
/* ------------------------------------------------------------------ */

/**
 * The Customer of the current user, or an error the portal shows. A contact
 * of several customers gets the one with billing (a Stripe customer) first.
 */
export async function currentCustomer() {
  const { customers } = await requirePortalIdentity({ message: 'Your user is not linked to a customer account yet. Please contact support.' });
  const rows = await loopar.db.getAll('Customer', ['name', 'email'], { name: { [Op.in]: [...customers] } });
  if (!rows.length) fail('Your user is not linked to a customer account yet. Please contact support.', 403);
  for (const row of rows) row.stripe_customer_id = await stripeIdOf(row.name);
  return rows.find((r) => r.stripe_customer_id) || rows[0];
}

/* ------------------------------------------------------------------ */
/* Websites                                                            */
/* ------------------------------------------------------------------ */

/** Every workspace (tenant) of a customer, from Stripe, local subscriptions and mail domains. */
export async function customerTenantNames(customer, subs) {
  const names = new Set(subs.map((s) => s.tenant_name).filter(Boolean));
  for (const r of await loopar.db.getAll('Subscription', ['tenant_name'], { customer: customer.name })) {
    if (r.tenant_name) names.add(r.tenant_name);
  }
  for (const r of await loopar.db.getAll(DOMAIN, ['tenant_name'], { customer: customer.name })) {
    if (r.tenant_name) names.add(r.tenant_name);
  }
  return [...names];
}

export async function siteOf(name, sub) {
  const t = tenant.readTenant(name);
  if (!t) return null;
  // { limit, used }: `used` only when that workspace is loaded in this core.
  const usage = await tenantUserUsage(name, getTenantInstance);
  const url = tenant.tenantUrl(name);
  return {
    name,
    domain: t.domain,
    url,
    desk_url: `${url}/desk`,
    other_domains: Object.keys(t.sites || {}),
    status: t.status, // 'active' | 'suspended'
    plan: sub ? { plan: sub.plan, status: sub.status } : null,
    users: usage,
  };
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

export const mailboxIsActive = (m) => [m.may_send, m.may_receive, m.may_access_imap].some((v) => [1, '1', true].includes(v));

/**
 * Mailbox limit + whether new mailboxes may be added, for one domain.
 * `mailboxes`: the domain's mailboxes when the caller already read them
 * (otherwise they are read from Migadu).
 */
export async function domainAllowance(domainRow, subs, settings = null, mailboxes = null) {
  settings = settings || await mailSettings();
  const sub = subscriptionOfTenant(subs, domainRow.tenant_name);
  const used = (mailboxes || await remoteMailboxes(domainRow.name)).filter(mailboxIsActive).length;

  let limit = sub?.mailbox_limit ?? null;
  if (limit == null) limit = Number(settings.default_mailbox_limit) || 0; // 0 = no limit

  // A domain not tied to a workspace is managed by the operator: no plan gate.
  const planActive = !domainRow.tenant_name || (!!sub && LIVE_STATUSES.has(sub.status));
  let blocked = null;
  if (!planActive) {
    blocked = 'The plan that includes this email is not active.';
  } else if (limit > 0 && used >= limit) {
    blocked = `Your plan includes ${limit} active mailbox${limit === 1 ? '' : 'es'}. Deactivate one or upgrade your plan to add more.`;
  }
  return { limit, used, plan_active: planActive, blocked, plan: sub ? { plan: sub.plan, status: sub.status } : null };
}

/** A Mail Domain owned by the customer (404 otherwise). */
export async function ownedDomain(customer, domain) {
  const name = String(domain || '').trim().toLowerCase();
  const row = name ? await loopar.db.getRow(DOMAIN, { name, customer: customer.name }, ['name', 'status', 'tenant_name', 'customer']) : null;
  if (!row) fail('Domain not found.', 404);
  return row;
}

/** A Mailbox of one of the customer's domains (404 otherwise). */
export async function ownedMailbox(customer, address) {
  // Ownership comes from the address's domain (ours), before Migadu is asked.
  const at = splitAddress(address);
  if (!at) fail('Mailbox not found.', 404);
  await ownedDomain(customer, at.domain);
  const doc = await loopar.getDocument(MAILBOX, `${at.localPart}@${at.domain}`, null, { ifNotFound: null });
  if (!doc) fail('Mailbox not found.', 404);
  return doc;
}

/** A Mail Alias of one of the customer's domains (404 otherwise). */
export async function ownedAlias(customer, address) {
  const at = splitAddress(address);
  if (!at) fail('Alias not found.', 404);
  await ownedDomain(customer, at.domain);
  const doc = await loopar.getDocument(ALIAS, `${at.localPart}@${at.domain}`, null, { ifNotFound: null });
  if (!doc) fail('Alias not found.', 404);
  return doc;
}

/* ------------------------------------------------------------------ */
/* Portal access (operator side)                                       */
/* ------------------------------------------------------------------ */

/** Signed one-use link that signs the customer in to the portal. */
async function activationUrl(userName, req) {
  const raw = jwt.sign({ sub: userName, purpose: ACTIVATION_PURPOSE, jti: crypto.randomUUID() }, loopar.jwtSecret, { expiresIn: ACTIVATION_TTL });
  // Same slot as a password-reset link: the newest email is the only one that works.
  await loopar.db.updateRow('User', userName, { reset_password_token: hashToken(raw) });
  return `${baseUrl(req)}/portal/${encodeURIComponent(PAGE)}/activate?token=${encodeURIComponent(raw)}`;
}

/**
 * Validates an activation link and consumes it. Returns the User row to
 * sign in, or null when the link is invalid, expired or already used.
 */
export async function consumeActivation(raw) {
  let payload;
  try {
    payload = jwt.verify(String(raw || ''), loopar.jwtSecret);
  } catch {
    return null;
  }
  if (payload?.purpose !== ACTIVATION_PURPOSE || !payload.sub) return null;
  const user = await loopar.db.getRow('User', payload.sub, ['name', 'email', 'user_type', 'disabled', 'reset_password_token']);
  if (!user || [1, '1', true].includes(user.disabled) || user.reset_password_token !== hashToken(raw)) return null;
  await loopar.db.updateRow('User', user.name, { reset_password_token: null });
  return user;
}

/**
 * Opens a session from an activation link. Returns the page to land on:
 * the portal, the second-factor step, or the login page when the link is
 * no longer valid.
 */
export async function signInWithActivation(raw) {
  const user = await consumeActivation(raw);
  const login = `/auth/login?redirect=${encodeURIComponent(PAGE_PATH)}`;
  if (!user) return login;
  const result = await completeLogin(user, { landing: PAGE_PATH });
  if (result.mfa_required) return '/auth/login?mfa=1';
  if (result.mfa_locked || !result.session) return login;
  return PAGE_PATH;
}

async function sendInvitationEmail({ to, url, firstTime }) {
  const subject = firstTime ? 'Your Loopar account is ready' : 'Sign in to your Loopar account';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
      <h2 style="margin: 0 0 16px 0;">${firstTime ? 'Welcome to your Loopar account' : 'Your sign-in link'}</h2>
      <p>From your account you can manage your plan and payment method, open your website and manage your email addresses.</p>
      <p style="margin: 28px 0;">
        <a href="${url}" style="display:inline-block;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          Open my account
        </a>
      </p>
      <p style="color:#666;font-size:13px">This link signs you in once and expires in 7 days. Once inside, choose a password so you can sign in any time.</p>
      <p style="color:#666;font-size:13px">If the button doesn't work, copy this link into your browser:<br><span style="word-break: break-all">${url}</span></p>
    </div>
  `;
  return loopar.mail.send({ to, subject, html });
}

/**
 * Gives the Customer's contact (the one with the customer's email, created
 * when missing) a Web user and emails a sign-in link. Idempotent: an already
 * linked contact just gets a new link. Returns { user, email, created, emailed },
 * plus `url` (the one-use sign-in link) when `returnLink` is set — for the
 * operator, who may open it in a private window to see the customer's portal.
 */
export async function grantPortalAccess(customerName, { req = null, sendEmail = true, returnLink = false } = {}) {
  const customer = await loopar.db.getRow('Customer', customerName, ['name', 'email', 'customer_name']);
  if (!customer) fail(`Customer ${customerName} does not exist.`, 404);
  const email = String(customer.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) fail('The customer needs a valid email to access the portal.');

  const contact = await ensureCustomerContact(customer.name, { email, full_name: customer.customer_name || email });
  // Nobody knows the password: the customer signs in with the emailed link and chooses one.
  const { user: userName, created } = await grantContactAccess(contact, { password: 'unknown' });

  const user = await loopar.db.getRow('User', userName, ['name', 'must_change_password']);
  const firstTime = created || [1, '1', true].includes(user?.must_change_password);

  let emailed = false;
  const url = sendEmail || returnLink ? await activationUrl(userName, req) : null;
  if (sendEmail) {
    await sendInvitationEmail({ to: email, url, firstTime });
    emailed = true;
  }
  return { user: userName, email, created, emailed, ...(returnLink ? { url } : {}) };
}

/** Fire-and-forget variant for billing flows: never fails the caller. */
export function grantPortalAccessQuietly(customerName, opts = {}) {
  if (!customerName) return;
  (async () => {
    const contacts = await customerContacts(customerName);
    if (contacts.length) {
      const linked = await loopar.db.getAll('Customer Contact', ['name'], { name: { [Op.in]: contacts.map((c) => c.contact) }, user: { [Op.ne]: null } });
      if (linked.length) return; // already has access: no extra email
    }
    await grantPortalAccess(customerName, opts);
  })().catch((e) => console.warn(`[account] portal access for ${customerName} not granted:`, e?.message || e));
}

/* ------------------------------------------------------------------ */
/* Password (customer side)                                            */
/* ------------------------------------------------------------------ */

const STRONG = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*])(?=.{8,})/;

export async function setOwnPassword(password) {
  const user = loopar.auth.user();
  if (!user) fail('Sign in first.', 401);
  password = String(password || '');
  if (!STRONG.test(password)) {
    fail('Use at least 8 characters with uppercase, lowercase, a number and one of !@#$%^&*.');
  }
  await loopar.db.updateRow('User', user, {
    password: await loopar.hash(password),
    must_change_password: 0,
    reset_password_token: null,
  });
}

