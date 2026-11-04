'use strict';

import { PageController, loopar } from 'loopar';
import {
  fail, pageUrl, stripeClient, stripeCustomerId, customerSubscriptions, subscriptionOfTenant,
  currentCustomer, customerTenantNames, siteOf, mailboxIsActive, domainAllowance,
  ownedDomain, ownedMailbox, ownedAlias, signInWithActivation, setOwnPassword,
} from '../../account-service.js';
import {
  DOMAIN, MAILBOX, ALIAS, input, truthy, settings as mailSettings,
  sendMailboxInvitation, setMailboxPassword,
} from '../../../mail-hosting/mail-service.js';

const byName = (a, b) => String(a.address).localeCompare(String(b.address));

/**
 * Customer self-service portal (`/portal/Cloud Account/view`), for the Web
 * user of a contact of the Customer (core portal identity). Every action resolves
 * the customer from the session and checks that each domain, mailbox or
 * alias it touches belongs to that customer.
 */
export default class CloudAccountController extends PageController {
  // Any logged-in user may call these; each one resolves its own customer.
  static freeActions = [
    'view', 'summary', 'billingPortal', 'resubscribe', 'setPassword',
    'createMailbox', 'updateMailbox', 'setMailboxActive', 'mailboxInvitation', 'mailboxPassword',
    'saveAlias', 'deleteAlias',
  ];
  static postOnlyActions = [
    'billingPortal', 'resubscribe', 'setPassword',
    'createMailbox', 'updateMailbox', 'setMailboxActive', 'mailboxInvitation', 'mailboxPassword',
    'saveAlias', 'deleteAlias',
  ];

  constructor(props) {
    super(props);
  }

  /** GET /portal/Cloud Account/activate?token= — the emailed one-use sign-in link. */
  async publicActionActivate() {
    return this.redirect(await signInWithActivation(this.query?.token), { hard: true });
  }

  /* ---------------------------------------------------------------- */
  /* Overview                                                          */
  /* ---------------------------------------------------------------- */

  async actionSummary() {
    const customer = await currentCustomer();

    let plans = [];
    let billingError = null;
    let hasBilling = false;
    try {
      const stripe = await stripeClient({ required: false });
      if (stripe) {
        customer.stripe_customer_id = await stripeCustomerId(customer, stripe);
        hasBilling = !!customer.stripe_customer_id;
        plans = await customerSubscriptions(customer, stripe);
      }
    } catch (e) {
      console.warn('[cloud-account] billing summary failed:', e?.message || e);
      billingError = 'We could not load your billing details right now. Please try again in a moment.';
    }

    const settings = await mailSettings();
    const sites = (await customerTenantNames(customer, plans))
      .map((name) => siteOf(name, subscriptionOfTenant(plans, name)))
      .filter(Boolean);

    const domains = [];
    for (const d of await loopar.db.getAll(DOMAIN, ['name', 'status', 'tenant_name'], { customer: customer.name })) {
      const mailboxes = (await loopar.db.getAll(
        MAILBOX,
        ['name', 'local_part', 'display_name', 'recovery_email', 'may_send', 'may_receive', 'may_access_imap', 'invited_at'],
        { domain: d.name },
      )).map((m) => ({
        address: m.name,
        local_part: m.local_part,
        display_name: m.display_name || '',
        recovery_email: m.recovery_email || '',
        active: mailboxIsActive(m),
        invited_at: m.invited_at || null,
      })).sort(byName);

      const aliases = (await loopar.db.getAll(ALIAS, ['name', 'local_part', 'destinations'], { domain: d.name }))
        .map((a) => ({
          address: a.name,
          local_part: a.local_part,
          destinations: String(a.destinations || '').split(/[\s,;]+/).filter(Boolean),
        })).sort(byName);

      domains.push({
        name: d.name,
        status: d.status,
        tenant_name: d.tenant_name || null,
        ...(await domainAllowance(d, plans, settings)),
        mailboxes,
        aliases,
      });
    }
    domains.sort((a, b) => a.name.localeCompare(b.name));

    const user = await loopar.db.getRow('User', loopar.auth.user(), ['name', 'email', 'must_change_password']);

    // Data endpoint: a plain object without `message`, so the client keeps the payload.
    return {
      account: {
        email: customer.email,
        user: user?.name || null,
        must_change_password: truthy(user?.must_change_password),
      },
      billing: {
        available: hasBilling,
        error: billingError,
        plans: plans.map((p) => ({ ...p, can_resubscribe: p.status === 'canceled' && !!p.tenant_name && !!p.price_id })),
      },
      sites,
      mail: { webmail_url: settings.webmail_url, domains },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Account                                                           */
  /* ---------------------------------------------------------------- */

  async actionSetPassword() {
    await setOwnPassword(input(this).password);
    return await this.success('Password saved. Use it with your email to sign in.');
  }

  /* ---------------------------------------------------------------- */
  /* Billing                                                           */
  /* ---------------------------------------------------------------- */

  /** A fresh Stripe Customer Portal session (payment method, cancel, renew, invoices). */
  async actionBillingPortal() {
    const customer = await currentCustomer();
    const stripe = await stripeClient();
    const id = await stripeCustomerId(customer, stripe);
    if (!id) fail('There is no billing account for you yet.');
    try {
      const session = await stripe.billingPortal.sessions.create({ customer: id, return_url: pageUrl(this.req) });
      return { url: session.url };
    } catch (e) {
      console.error('[cloud-account] billing portal session failed:', e?.message || e);
      fail('We could not open the billing portal right now. Please try again in a moment.', 502);
    }
  }

  /**
   * Starts a Checkout for a canceled workspace plan (same price). The local
   * Subscription is created as already provisioned: the webhook links it and
   * `customer.subscription.updated` brings the workspace back online.
   */
  async actionResubscribe() {
    const customer = await currentCustomer();
    const stripe = await stripeClient();
    const stripeId = await stripeCustomerId(customer, stripe);
    if (!stripeId) fail('There is no billing account for you yet.');

    const { subscription } = input(this);
    const sub = (await customerSubscriptions(customer, stripe)).find((s) => s.id === subscription);
    if (!sub) fail('Subscription not found.', 404);
    // The list keeps one subscription per workspace, the live one first:
    // a canceled entry means that workspace has no live plan.
    if (sub.status !== 'canceled') fail('This plan is not canceled. Use "Manage billing" to change it.');
    if (!sub.tenant_name || !sub.price_id) fail('This plan cannot be restarted from here. Please contact support.');

    const price = await stripe.prices.retrieve(sub.price_id).catch(() => null);
    if (!price?.active) fail('This plan is no longer offered. Please contact support to choose a new one.');

    const subName = `sub_portal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const metadata = {
      subscription_id: subName,
      tenant_name: sub.tenant_name,
      existing_tenant: 'true',
      plan_name: sub.plan,
      price_id: sub.price_id,
      created_by: 'portal',
    };

    const local = await loopar.newDocument('Subscription');
    local.name = subName;
    local.customer = customer.name;
    local.stripe_price_id = sub.price_id;
    local.plan_name = sub.plan;
    local.tenant_name = sub.tenant_name;
    local.tenant_provisioned = 1; // the workspace exists: never provision it again
    local.provisioning_step = 'ready';
    local.status = 'pending';
    await local.save();

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeId,
        line_items: [{ price: sub.price_id, quantity: 1 }],
        success_url: pageUrl(this.req, 'checkout=success'),
        cancel_url: pageUrl(this.req, 'checkout=cancel'),
        metadata,
        subscription_data: { metadata },
      });
      return { url: session.url };
    } catch (e) {
      console.error('[cloud-account] checkout session failed:', e?.message || e);
      fail('We could not start the checkout right now. Please try again in a moment.', 502);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Email                                                             */
  /* ---------------------------------------------------------------- */

  /** Domain + allowance, checked against the customer's live plans. */
  async #allowance(customer, domain) {
    const row = await ownedDomain(customer, domain);
    const plans = row.tenant_name ? await customerSubscriptions(customer) : [];
    return { row, allowance: await domainAllowance(row, plans) };
  }

  async actionCreateMailbox() {
    const customer = await currentCustomer();
    const { domain, local_part, display_name, recovery_email } = input(this);
    const { row, allowance } = await this.#allowance(customer, domain);
    if (allowance.blocked) fail(allowance.blocked);

    const doc = await loopar.newDocument(MAILBOX, {
      domain: row.name,
      local_part,
      display_name: String(display_name || '').trim().slice(0, 100),
      recovery_email,
      may_send: 1,
      may_receive: 1,
      may_access_imap: 1,
      is_internal: 0,
    });
    await doc.save();
    return await this.success(`${doc.name} was created. We emailed ${doc.recovery_email} a link to choose its password.`);
  }

  async actionUpdateMailbox() {
    const customer = await currentCustomer();
    const { address, display_name } = input(this);
    const doc = await ownedMailbox(customer, address);
    doc.display_name = String(display_name ?? '').trim().slice(0, 100);
    await doc.save();
    return await this.success(`${doc.name} updated.`);
  }

  /**
   * Deactivate = no sending, no receiving, no sign-in; the mailbox and its
   * mail are kept. Reactivating counts against the plan's limit again.
   */
  async actionSetMailboxActive() {
    const customer = await currentCustomer();
    const { address, active } = input(this);
    const doc = await ownedMailbox(customer, address);
    const on = truthy(active);

    if (on && !mailboxIsActive(doc)) {
      const { allowance } = await this.#allowance(customer, doc.domain);
      if (allowance.blocked) fail(allowance.blocked);
    }

    doc.may_send = doc.may_receive = doc.may_access_imap = on ? 1 : 0;
    await doc.save();
    return await this.success(on ? `${doc.name} is active again.` : `${doc.name} was deactivated. Its mail is kept.`);
  }

  async actionMailboxInvitation() {
    const customer = await currentCustomer();
    const { address, recovery_email } = input(this);
    const doc = await ownedMailbox(customer, address);
    const email = await sendMailboxInvitation(doc, recovery_email);
    return await this.success(`We emailed ${email} a link to choose the password of ${doc.name}.`);
  }

  async actionMailboxPassword() {
    const customer = await currentCustomer();
    const { address } = input(this);
    const doc = await ownedMailbox(customer, address);
    // The password comes from the body only (never logged or stored in Loopar).
    await setMailboxPassword(doc, this.body?.password);
    return await this.success(`Password updated for ${doc.name}.`);
  }

  /** Creates an alias, or changes the destinations of an existing one (`address`). */
  async actionSaveAlias() {
    const customer = await currentCustomer();
    const { address, domain, local_part, destinations } = input(this);
    const text = Array.isArray(destinations) ? destinations.join('\n') : String(destinations || '');

    if (address) {
      const doc = await ownedAlias(customer, address);
      doc.destinations = text;
      await doc.save();
      return await this.success(`${doc.name} updated.`);
    }

    const { row, allowance } = await this.#allowance(customer, domain);
    if (!allowance.plan_active) fail(allowance.blocked);
    const doc = await loopar.newDocument(ALIAS, { domain: row.name, local_part, destinations: text, is_internal: 0 });
    await doc.save();
    return await this.success(`${doc.name} was created.`);
  }

  async actionDeleteAlias() {
    const customer = await currentCustomer();
    const doc = await ownedAlias(customer, input(this).address);
    const name = doc.name;
    await doc.delete();
    return await this.success(`${name} was deleted.`);
  }
}
