'use strict';

import { ListLayout } from '@loopar/list';
import { Button } from '@cn/components/ui/button';
import { Download } from 'lucide-react';
import { call, confirm } from '../../../client/mail-ui.jsx';

/** Mail Domain list — adds "Import from Migadu" (domains, mailboxes and aliases). */
export default function MailDomainList() {
  const importAll = async () => {
    await confirm('Import every domain, mailbox and alias from Migadu? Existing records are updated; nothing is deleted.');
    await call('Mail Domain', 'importAll').catch(() => null);
  };

  const actions = {
    importFromMigadu: (
      <Button key="importFromMigadu" onClick={importAll} size="sm" variant="outline">
        <Download className="h-4 w-4 mr-1" />
        Import from Migadu
      </Button>
    ),
  };

  return <ListLayout actions={actions} />;
}
