'use strict';

import { FormLayout } from '@loopar/form';
import { useRecordActions, call, ask } from '../../../client/mail-ui.jsx';

export default function MailboxForm() {
  useRecordActions([
    {
      key: 'invite', label: 'Send invitation',
      run: async (name, data) => {
        const v = await ask({
          title: 'Send password invitation',
          message: `Migadu will email a link to choose the password of ${name}.`,
          fields: [{ name: 'recovery_email', label: 'Send to', type: 'email', default: data.recovery_email || '' }],
        });
        await call('Mailbox', 'sendInvitation', { name, body: v });
      },
    },
    {
      key: 'password', label: 'Set password', variant: 'outline',
      run: async (name) => {
        const v = await ask({
          title: 'Set password',
          message: `New password for ${name}. It is sent to Migadu only and is not stored in Loopar.`,
          fields: [{ name: 'password', label: 'Password', type: 'password', help: 'At least 10 characters.' }],
        });
        await call('Mailbox', 'setPassword', { name, body: v });
      },
    },
  ]);
  return <FormLayout />;
}
