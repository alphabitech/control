'use strict';

import { useEffect, useState } from 'react';
import loopar from 'loopar';
import { PageLayout } from '@loopar/page';
import { Button } from '@cn/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cn/components/ui/dropdown-menu';
import { cn } from '@cn/lib/utils';
import {
  AtSign, CreditCard, ExternalLink, Forward, Globe, KeyRound, LayoutDashboard, Mail, MailPlus,
  MoreHorizontal, Plus, RefreshCw, ShieldAlert,
} from 'lucide-react';
import { ask, call, confirm } from '../../../../mail-hosting/client/mail-ui.jsx';

const PAGE = 'Cloud Account';

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                     */
/* ------------------------------------------------------------------ */

const TONES = {
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  red: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
  gray: 'bg-muted text-muted-foreground border-border',
};

const STATUS = {
  active: ['Active', 'green'],
  trialing: ['Trial', 'green'],
  past_due: ['Payment due', 'amber'],
  unpaid: ['Unpaid', 'red'],
  canceled: ['Canceled', 'red'],
  incomplete: ['Incomplete', 'amber'],
  paused: ['Paused', 'amber'],
  suspended: ['Suspended', 'red'],
  online: ['Online', 'green'],
  inactive: ['Inactive', 'gray'],
  pending: ['Pending setup', 'amber'],
};

function Status({ status }) {
  const key = String(status || '').toLowerCase();
  const [text, tone] = STATUS[key] || [status || '—', 'gray'];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone])}>
      <span className="size-1.5 rounded-full bg-current" />
      {text}
    </span>
  );
}

function Section({ icon: Icon, title, right, children }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 md:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {Icon && <Icon className="h-4 w-4 text-primary" />}
          {title}
        </h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }) => <p className="text-sm text-muted-foreground">{children}</p>;

const date = (v) => (v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null);

function price(p) {
  if (p.amount == null) return null;
  const amount = new Intl.NumberFormat(undefined, { style: 'currency', currency: (p.currency || 'usd').toUpperCase() }).format(p.amount / 100);
  if (!p.interval) return amount;
  return `${amount} / ${p.interval_count > 1 ? `${p.interval_count} ${p.interval}s` : p.interval}`;
}

/** Runs a server call; the toast already explains a failure. */
async function run(fn, after) {
  try {
    const r = await fn();
    after && after(r);
    return r;
  } catch {
    return null;
  }
}

/** Server calls that answer { url }: go there. */
async function goTo(action, body) {
  const r = await run(() => call(PAGE, action, { body }));
  if (r?.url) window.location.href = r.url;
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

function PasswordBanner({ onDone }) {
  const choose = async () => {
    const v = await ask({
      title: 'Choose your password',
      message: 'You will sign in with your email and this password.',
      fields: [
        { name: 'password', label: 'Password', type: 'password', help: 'At least 8 characters, with uppercase, lowercase, a number and one of !@#$%^&*' },
        { name: 'confirm', label: 'Repeat password', type: 'password' },
      ],
    });
    if (v.password !== v.confirm) {
      loopar.notify({ type: 'error', message: 'The passwords do not match.' });
      return;
    }
    await run(() => call(PAGE, 'setPassword', { body: { password: v.password } }), onDone);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 shrink-0 text-amber-600" />
        <div className="text-sm">
          <div className="font-medium">Choose a password for your account</div>
          <div className="text-muted-foreground">You signed in with an emailed link. Set a password to sign in any time.</div>
        </div>
      </div>
      <Button size="sm" onClick={choose}>Choose password</Button>
    </div>
  );
}

function Billing({ billing }) {
  const plans = billing.plans || [];
  const restart = async (p) => {
    await confirm(`Restart ${p.plan}${p.tenant_name ? ` for ${p.tenant_name}` : ''}? You will be taken to a secure checkout.`);
    await goTo('resubscribe', { subscription: p.id });
  };

  return (
    <Section
      icon={CreditCard}
      title="Plan & billing"
      right={billing.available && (
        <Button size="sm" variant="outline" onClick={() => goTo('billingPortal')}>
          <CreditCard className="mr-1 h-4 w-4" /> Manage billing
        </Button>
      )}
    >
      {billing.error && <Empty>{billing.error}</Empty>}
      {!billing.error && !plans.length && <Empty>You have no plans yet.</Empty>}
      <ul className="divide-y divide-border">
        {plans.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.plan}</span>
                <Status status={p.status} />
              </div>
              <div className="text-sm text-muted-foreground">
                {[
                  price(p),
                  p.tenant_name && `Workspace ${p.tenant_name}`,
                  p.status === 'trialing' && p.trial_end && `Trial ends ${date(p.trial_end)}`,
                  p.status === 'canceled' && p.ended_at && `Ended ${date(p.ended_at)}`,
                  p.status !== 'canceled' && p.cancel_at_period_end && `Cancels on ${date(p.cancel_at || p.current_period_end)}`,
                  p.status !== 'canceled' && !p.cancel_at_period_end && p.status !== 'trialing' && p.current_period_end && `Renews ${date(p.current_period_end)}`,
                ].filter(Boolean).join(' · ')}
              </div>
              {p.status === 'past_due' && (
                <div className="text-sm text-amber-700 dark:text-amber-400">We could not charge your card. Update your payment method in “Manage billing” to avoid a suspension.</div>
              )}
            </div>
            {p.can_resubscribe && (
              <Button size="sm" onClick={() => restart(p)}>
                <RefreshCw className="mr-1 h-4 w-4" /> Restart plan
              </Button>
            )}
          </li>
        ))}
      </ul>
      {billing.available && (
        <p className="text-xs text-muted-foreground">
          In “Manage billing” you can change your card, download invoices, cancel your plan or undo a scheduled cancellation.
        </p>
      )}
    </Section>
  );
}

function Sites({ sites }) {
  return (
    <Section icon={Globe} title="Websites">
      {!sites.length && <Empty>You have no websites with us yet.</Empty>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {sites.map((s) => (
          <li key={s.name} className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{s.domain}</div>
                {s.other_domains.length > 0 && <div className="truncate text-xs text-muted-foreground">Also: {s.other_domains.join(', ')}</div>}
              </div>
              <Status status={s.status === 'active' ? 'online' : 'suspended'} />
            </div>
            {s.status !== 'active' && (
              <p className="text-xs text-muted-foreground">This website is offline. Check the plan above, or contact support.</p>
            )}
            {s.users?.limit ? (
              <p className="text-xs text-muted-foreground">
                {s.users.used != null ? `${s.users.used} of ${s.users.limit} users` : `${s.users.limit} users included`}
                {s.users.used != null && s.users.used >= s.users.limit ? ' — upgrade your plan to add more.' : ''}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" asChild>
                <a href={s.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1 h-4 w-4" /> Open website</a>
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={s.desk_url} target="_blank" rel="noopener noreferrer"><LayoutDashboard className="mr-1 h-4 w-4" /> Open desk</a>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function MailboxActions({ m, reload }) {
  const rename = async () => {
    const v = await ask({
      title: `Name of ${m.address}`,
      message: 'The name people see next to your address.',
      fields: [{ name: 'display_name', label: 'Display name', default: m.display_name }],
    });
    await run(() => call(PAGE, 'updateMailbox', { body: { address: m.address, display_name: v.display_name } }), reload);
  };
  const invite = async () => {
    const v = await ask({
      title: 'Send password link',
      message: `We will email a link to choose the password of ${m.address}.`,
      fields: [{ name: 'recovery_email', label: 'Send to', type: 'email', default: m.recovery_email, help: 'Must be a different address than the mailbox itself.' }],
    });
    await run(() => call(PAGE, 'mailboxInvitation', { body: { address: m.address, recovery_email: v.recovery_email } }), reload);
  };
  const password = async () => {
    const v = await ask({
      title: `Set password for ${m.address}`,
      message: 'Share it with the person who uses this mailbox. We do not store it.',
      fields: [{ name: 'password', label: 'New password', type: 'password', help: 'At least 10 characters.' }],
    });
    await run(() => call(PAGE, 'mailboxPassword', { body: { address: m.address, password: v.password } }), reload);
  };
  const toggle = async () => {
    if (m.active) {
      await confirm(`Deactivate ${m.address}? It will stop sending and receiving and nobody can sign in to it. Its mail is kept and you can turn it back on later.`);
    }
    await run(() => call(PAGE, 'setMailboxActive', { body: { address: m.address, active: m.active ? 0 : 1 } }), reload);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`Actions for ${m.address}`}><MoreHorizontal className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={rename}>Edit name</DropdownMenuItem>
        <DropdownMenuItem onSelect={invite}>Send password link</DropdownMenuItem>
        <DropdownMenuItem onSelect={password}>Set password</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={toggle} className={m.active ? 'text-red-600' : ''}>
          {m.active ? 'Deactivate' : 'Activate'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Aliases({ domain, reload }) {
  const save = async (alias) => {
    const v = await ask({
      title: alias ? `Edit ${alias.address}` : `New alias on ${domain.name}`,
      message: 'Mail sent to the alias is delivered to the addresses you list.',
      fields: [
        ...(alias ? [] : [{ name: 'local_part', label: `Alias (before @${domain.name})` }]),
        {
          name: 'destinations', label: 'Deliver to', default: alias ? alias.destinations.join(', ') : '',
          help: `Addresses of ${domain.name}, separated by commas.`,
        },
      ],
    });
    await run(() => call(PAGE, 'saveAlias', {
      body: alias ? { address: alias.address, destinations: v.destinations } : { domain: domain.name, local_part: v.local_part, destinations: v.destinations },
    }), reload);
  };
  const remove = async (alias) => {
    await confirm(`Delete the alias ${alias.address}? Mail sent to it will no longer be delivered.`);
    await run(() => call(PAGE, 'deleteAlias', { body: { address: alias.address } }), reload);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium"><Forward className="h-4 w-4 text-muted-foreground" /> Aliases</h4>
        {domain.plan_active && (
          <Button size="sm" variant="ghost" onClick={() => save(null)}><Plus className="mr-1 h-4 w-4" /> New alias</Button>
        )}
      </div>
      {!domain.aliases.length && <Empty>No aliases.</Empty>}
      <ul className="divide-y divide-border">
        {domain.aliases.map((a) => (
          <li key={a.address} className="flex items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">{a.address}</div>
              <div className="truncate text-muted-foreground">→ {a.destinations.join(', ')}</div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" onClick={() => save(a)}>Edit</Button>
              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => remove(a)}>Delete</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Domain({ domain, reload }) {
  const create = async () => {
    const v = await ask({
      title: `New mailbox on ${domain.name}`,
      message: 'We will email a link to choose its password.',
      fields: [
        { name: 'local_part', label: `Address (before @${domain.name})` },
        { name: 'display_name', label: 'Name', help: 'For example the name of the person who will use it.' },
        { name: 'recovery_email', label: 'Send the password link to', type: 'email', help: 'A different address the person can read today.' },
      ],
    });
    await run(() => call(PAGE, 'createMailbox', { body: { domain: domain.name, ...v } }), reload);
  };

  return (
    <div className="space-y-4 rounded-lg border border-border p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{domain.name}</span>
            {String(domain.status).toLowerCase() !== 'active' && <Status status={domain.status} />}
          </div>
          <div className="text-xs text-muted-foreground">
            {domain.limit > 0 ? `${domain.used} of ${domain.limit} mailboxes in use` : `${domain.used} active mailbox${domain.used === 1 ? '' : 'es'}`}
          </div>
        </div>
        <Button size="sm" onClick={create} disabled={!!domain.blocked} title={domain.blocked || ''}>
          <MailPlus className="mr-1 h-4 w-4" /> New mailbox
        </Button>
      </div>
      {domain.blocked && <p className="text-xs text-muted-foreground">{domain.blocked}</p>}
      {domain.mail_error && <p className="text-xs text-destructive">{domain.mail_error}</p>}

      {!domain.mailboxes.length && <Empty>No mailboxes yet.</Empty>}
      <ul className="divide-y divide-border">
        {domain.mailboxes.map((m) => (
          <li key={m.address} className="flex items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className={cn('truncate text-sm font-medium', !m.active && 'text-muted-foreground')}>{m.address}</div>
              {m.display_name && <div className="truncate text-xs text-muted-foreground">{m.display_name}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!m.active && <Status status="inactive" />}
              <MailboxActions m={m} reload={reload} />
            </div>
          </li>
        ))}
      </ul>

      <Aliases domain={domain} reload={reload} />
    </div>
  );
}

function Email({ mail, reload }) {
  return (
    <Section
      icon={Mail}
      title="Email"
      right={mail.domains.length > 0 && (
        <Button size="sm" asChild>
          <a href={mail.webmail_url} target="_blank" rel="noopener noreferrer"><AtSign className="mr-1 h-4 w-4" /> Open my email</a>
        </Button>
      )}
    >
      {!mail.domains.length && <Empty>You have no email domains with us yet.</Empty>}
      {mail.domains.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Sign in to your email at <a className="underline" href={mail.webmail_url} target="_blank" rel="noopener noreferrer">{mail.webmail_url.replace(/^https?:\/\//, '')}</a> with your full address and its password.
        </p>
      )}
      <div className="space-y-4">
        {mail.domains.map((d) => <Domain key={d.name} domain={d} reload={reload} />)}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function Account() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let alive = true;
    call(PAGE, 'summary', { freeze: false })
      .then((r) => alive && (setData(r), setError(null)))
      .catch((e) => alive && setError(e?.message || 'We could not load your account.'));
    return () => { alive = false; };
  }, [tick]);

  // Back from Stripe Checkout.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get('checkout');
    if (!state) return;
    loopar.notify(state === 'success'
      ? { type: 'success', message: 'Thank you! Your plan is being reactivated; it can take a minute to show here.' }
      : { type: 'warning', message: 'Checkout was canceled. Nothing was charged.' });
    params.delete('checkout');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center space-y-2">
        <ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return <p className="p-6 text-center text-sm text-muted-foreground">Loading your account…</p>;

  return (
    <div className="space-y-5 py-2">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">My account</h1>
          <p className="text-sm text-muted-foreground">{data.account.email}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={reload}><RefreshCw className="mr-1 h-4 w-4" /> Refresh</Button>
      </header>

      {data.account.must_change_password && <PasswordBanner onDone={reload} />}
      <Billing billing={data.billing} />
      <Sites sites={data.sites} />
      <Email mail={data.mail} reload={reload} />

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <KeyRound className="h-3.5 w-3.5" /> Signed in as {data.account.user}.
      </p>
    </div>
  );
}

const SLOTS = { account: () => <Account /> };

export default function CloudAccountPage() {
  return <PageLayout slots={SLOTS} />;
}
