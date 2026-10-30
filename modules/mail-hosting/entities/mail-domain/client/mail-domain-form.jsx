'use strict';

import { FormLayout } from '@loopar/form';
import { useRecordActions, call, confirm } from '../../../client/mail-ui.jsx';

const usesCloudflare = (d) => d.dns_provider !== 'Manual';

export default function MailDomainForm() {
  useRecordActions([
    {
      key: 'preview_dns', label: 'Preview DNS', when: usesCloudflare,
      run: (name) => call('Mail Domain', 'previewDns', { name }),
    },
    {
      key: 'configure_dns', label: 'Configure DNS', variant: 'default', when: usesCloudflare,
      run: async (name) => {
        await confirm(`Write the mail records for ${name} in Cloudflare? An existing SPF is merged, and MX records of other providers are removed.`);
        await call('Mail Domain', 'configureDns', { name });
      },
    },
    {
      key: 'check', label: 'Check & activate',
      run: (name) => call('Mail Domain', 'checkDomain', { name }),
    },
    {
      key: 'sync', label: 'Sync mailboxes',
      run: (name) => call('Mail Domain', 'syncContent', { name }),
    },
  ]);
  return <FormLayout />;
}
