'use strict';

import { BaseController } from 'loopar';
import { input, targetDoc, sendMailboxInvitation, setMailboxPassword } from '../../mail-service.js';

export default class MailboxController extends BaseController {
  static postOnlyActions = ['sendInvitation', 'setPassword'];

  constructor(props) {
    super(props);
  }

  /** "Delete" deactivates: the mailbox and its mail stay in Migadu. */
  async actionDelete() {
    const doc = await targetDoc(this);
    await doc.delete();
    return this.redirect('list', { notify: `${doc.name} was deactivated. Its mail is kept; turn its permissions back on to reactivate it.` });
  }

  /** Asks Migadu to email the owner a link to choose a new password. */
  async actionSendInvitation() {
    const doc = await targetDoc(this);
    const email = await sendMailboxInvitation(doc, input(this).recovery_email);
    return await this.success(`Invitation sent to ${email}.`, { refresh: 'soft' });
  }

  /** Sets the password directly. It goes to Migadu only; Loopar does not store it. */
  async actionSetPassword() {
    const doc = await targetDoc(this);
    await setMailboxPassword(doc, this.body?.password);
    return await this.success(`Password updated for ${doc.name}. It was not stored in Loopar.`, { refresh: 'soft' });
  }
}
