'use strict';

import { BaseController, loopar } from 'loopar';
import { MAILBOX, fail, now, isEmail, input, targetDoc, migadu, remote } from '../../mail-service.js';

export default class MailboxController extends BaseController {
  static postOnlyActions = ['sendInvitation', 'setPassword'];

  constructor(props) {
    super(props);
  }

  /** Asks Migadu to email the owner a link to choose a new password. */
  async actionSendInvitation() {
    const doc = await targetDoc(this);
    const email = String(input(this).recovery_email || doc.recovery_email || '').trim();
    if (!isEmail(email)) fail('Enter the email where the invitation should go.');
    if (email.toLowerCase() === doc.name) fail('The invitation must go to a different address than the mailbox itself.');

    const api = await migadu();
    await remote(() => api.updateMailbox(doc.domain, doc.local_part, {
      password_method: 'invitation',
      password_recovery_email: email,
    }));
    await loopar.db.updateRow(MAILBOX, doc.name, { recovery_email: email, invited_at: now() });
    return await this.success(`Invitation sent to ${email}.`, { refresh: 'soft' });
  }

  /** Sets the password directly. It goes to Migadu only; Loopar does not store it. */
  async actionSetPassword() {
    const doc = await targetDoc(this);
    const password = String(this.body?.password ?? '');
    if (password.length < 10) fail('Use at least 10 characters.');

    const api = await migadu();
    await remote(() => api.updateMailbox(doc.domain, doc.local_part, { password }));
    return await this.success(`Password updated for ${doc.name}. It was not stored in Loopar.`, { refresh: 'soft' });
  }
}
