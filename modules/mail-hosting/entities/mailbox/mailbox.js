'use strict';

import { BaseDocument, loopar } from 'loopar';
import {
  DOMAIN, MAILBOX, ALIAS, fail, truthy, now, isEmail, normalizeDomain, normalizeLocalPart,
  migadu, remote, isFromRemote,
} from '../../mail-service.js';

/** Fields mirrored to Migadu on every save. */
const SYNCED = ['display_name', 'recovery_email', 'may_send', 'may_receive', 'may_access_imap'];
const FLAGS = ['may_send', 'may_receive', 'may_access_imap'];
/** Fixed after creation. */
const IMMUTABLE = ['domain', 'local_part', 'address', 'is_internal', 'invited_at'];

const missing = (v) => v == null || v === '';
const flag = (v) => (truthy(v) ? 1 : 0);

/**
 * A mailbox in Migadu. New mailboxes are created by invitation: Migadu emails
 * the recovery address and the owner chooses the password, so Loopar never
 * knows it. Deleting the record deletes the mailbox (and its mail) in Migadu.
 */
export default class Mailbox extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.recovery_email = String(this.recovery_email || '').trim();
    if (this.__IS_NEW__) return await this.#create();

    const stored = await loopar.db.getRow(MAILBOX, this.__DOCUMENT_NAME__ || this.name, [...IMMUTABLE, ...SYNCED]);
    if (!stored) return;
    for (const f of IMMUTABLE) this[f] = stored[f];
    // A save that leaves a permission out keeps the stored one (never re-enables by omission).
    for (const f of FLAGS) this[f] = missing(this[f]) ? flag(stored[f]) : flag(this[f]);
    if (isFromRemote(this)) return;

    const changed = SYNCED.filter((f) => String(this[f] ?? '') !== String(stored[f] ?? ''));
    if (!changed.length) return;
    if (changed.includes('recovery_email')) {
      if (!this.recovery_email) fail('The recovery email cannot be empty in Migadu: enter the new address instead.');
      if (!isEmail(this.recovery_email)) fail('The recovery email is not valid.');
    }

    const api = await migadu();
    await remote(() => api.updateMailbox(this.domain, this.local_part, {
      name: this.display_name || this.local_part,
      may_send: !!this.may_send,
      may_receive: !!this.may_receive,
      may_access_imap: !!this.may_access_imap,
      ...(this.recovery_email ? { password_recovery_email: this.recovery_email } : {}),
    }));
  }

  async #create() {
    this.domain = normalizeDomain(this.domain);
    this.local_part = normalizeLocalPart(this.local_part);
    this.name = this.address = `${this.local_part}@${this.domain}`;
    this.is_internal = flag(this.is_internal);
    for (const f of FLAGS) this[f] = missing(this[f]) ? 1 : flag(this[f]);
    if (isFromRemote(this)) return;

    if (!(await loopar.db.getAll(DOMAIN, ['name'], { name: this.domain })).length) fail(`Mail Domain ${this.domain} does not exist.`);
    if ((await loopar.db.getAll(MAILBOX, ['name'], { name: this.name })).length) fail(`${this.name} already exists.`);
    if ((await loopar.db.getAll(ALIAS, ['name'], { name: this.name })).length) fail(`${this.name} is already an alias.`);
    if (!isEmail(this.recovery_email)) fail('Enter the email where the owner will receive the invitation to set the password.');
    if (this.recovery_email.toLowerCase() === this.name) fail('The invitation must go to a different address than the new mailbox.');
    // Validate the record before Migadu is touched, so a local failure can't leave an orphan mailbox.
    await this.validate();

    const api = await migadu();
    await remote(() => api.createMailbox(this.domain, {
      local_part: this.local_part,
      name: this.display_name || this.local_part,
      password_method: 'invitation',
      password_recovery_email: this.recovery_email,
      ...(this.is_internal ? { is_internal: true } : {}),
    }));

    // Migadu's create call does not take the permission flags: apply them after.
    // If that fails, the new (still empty) mailbox is removed so it never stays more permissive than asked.
    if (!this.may_send || !this.may_receive || !this.may_access_imap) {
      try {
        await api.updateMailbox(this.domain, this.local_part, {
          may_send: !!this.may_send,
          may_receive: !!this.may_receive,
          may_access_imap: !!this.may_access_imap,
        });
      } catch (e) {
        await api.deleteMailbox(this.domain, this.local_part).catch(() => null);
        fail(`The mailbox could not be restricted, so it was not created: ${e.message}`);
      }
    }
    this.invited_at = now();
  }

  /**
   * Removes the record first and the Migadu mailbox after: if Loopar refuses
   * the delete, the mail is untouched. If Migadu fails after that, the error
   * says so and "Sync mailboxes" brings the record back.
   */
  async delete() {
    const { domain, local_part: localPart, name } = this;
    await super.delete(...arguments);
    if (isFromRemote(this)) return;

    const api = await migadu();
    try {
      await api.deleteMailbox(domain, localPart);
    } catch (e) {
      fail(`${name} was removed from Loopar but Migadu did not delete it: ${e.message}. Delete it in Migadu, or run "Sync mailboxes" on the domain to bring it back.`);
    }
  }
}
