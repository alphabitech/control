'use strict';

import { FormLayout } from '@loopar/form';
import { useDocument } from '@loopar/document';
import { useRecordActions, call, confirm } from '../../../client/mail-ui.jsx';

const usesCloudflare = (d) => d.dns_provider !== 'Manual';
const isActive = (d) => d.status === 'Active';
const dnsDone = (d) => isActive(d) || !!d.dns_configured_at;

/**
 * The setup is a sequence: the domain exists in Migadu (on save) → DNS records
 * → activation. "Configure DNS" also tries the activation, so with Cloudflare
 * one click usually finishes; "Check & activate" is the retry, and the only
 * step for manual DNS. The highlighted button is always the next step.
 */
function nextStep(d) {
  if (isActive(d)) return null;
  if (usesCloudflare(d) && !dnsDone(d)) return 'dns';
  return 'check';
}

function Step({ n, label, done, current, hint }) {
  const dot = done
    ? 'bg-green-600 text-white'
    : current
      ? 'bg-primary text-primary-foreground'
      : 'bg-muted text-muted-foreground';
  return (
    <li className="flex min-w-0 flex-1 items-start gap-2">
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${dot}`}>
        {done ? '✓' : n}
      </span>
      <span className="min-w-0">
        <span className={`block text-sm ${current ? 'font-semibold' : done ? '' : 'text-muted-foreground'}`}>{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </li>
  );
}

/** `setup_steps` slot: where the domain is in the setup and what to press next. */
function SetupSteps() {
  const { Document = {} } = useDocument() || {};
  if (Document.isNew) return null;
  const d = Document.data || {};
  const next = nextStep(d);
  const cf = usesCloudflare(d);

  return (
    <ol className="mb-4 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:gap-4">
      <Step n={1} label="Domain in Migadu" done />
      <Step
        n={2}
        label={cf ? 'DNS in Cloudflare' : 'DNS (manual)'}
        done={dnsDone(d)}
        current={next === 'dns' || (!cf && next === 'check')}
        hint={next === 'dns' ? 'Press Configure DNS (it also activates)' : !cf && !isActive(d) ? "Copy Migadu's records into your DNS provider" : null}
      />
      <Step
        n={3}
        label="Active"
        done={isActive(d)}
        current={next === 'check'}
        hint={next === 'check' ? 'Press Check & activate (DNS can take a few minutes)' : isActive(d) ? 'Create the mailboxes' : null}
      />
    </ol>
  );
}

const SLOTS = { setup_steps: SetupSteps };

export default function MailDomainForm() {
  useRecordActions([
    {
      key: 'preview_dns', label: 'Preview DNS', when: usesCloudflare,
      run: (name) => call('Mail Domain', 'previewDns', { name }),
    },
    {
      key: 'configure_dns', label: 'Configure DNS', when: usesCloudflare,
      variant: (d) => (nextStep(d) === 'dns' ? 'default' : 'secondary'),
      run: async (name) => {
        await confirm(`Write the mail records for ${name} in Cloudflare and activate the domain in Migadu? MX records of other providers are removed; SPF and DMARC follow the domain's mail policy.`);
        await call('Mail Domain', 'configureDns', { name });
      },
    },
    {
      key: 'check', label: 'Check & activate',
      variant: (d) => (nextStep(d) === 'check' ? 'default' : 'secondary'),
      run: (name) => call('Mail Domain', 'checkDomain', { name }),
    },
  ]);
  return <FormLayout slots={SLOTS} />;
}
