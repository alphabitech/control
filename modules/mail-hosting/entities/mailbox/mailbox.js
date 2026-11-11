'use strict';

import { BaseDocument, loopar } from 'loopar';
import {
  DOMAIN, fail, truthy, isEmail, normalizeDomain, normalizeLocalPart, splitAddress,
  migadu, remote, mailboxValues, remoteMailboxes, remoteRecords, forgetMail,
} from '../../mail-service.js';

/** Fields Migadu lets change after creation. */
const EDITABLE = ['display_name', 'recovery_email', 'may_send', 'may_receive', 'may_access_imap'];
const FLAGS = ['may_send', 'may_receive', 'may_access_imap'];

const missing = (v) => v == null || v === '';
const flag = (v) => (truthy(v) ? 1 : 0);

/**
 * Mailbox — virtual: no table. Records are the mailboxes in Migadu of the
 * domains registered here; listing, opening, saving and deleting talk to
 * Migadu directly. New mailboxes are created by invitation: Migadu emails
 * the recovery address and the owner chooses the password, so Loopar never
 * knows it. Deleting DEACTIVATES the mailbox (no sending, receiving or
 * sign-in): its mail is kept and it can be turned on again. Removing a
 * mailbox and its mail for good is done in Migadu's panel.
 */
export default class Mailbox extends BaseDocument {
  #remote = null;

  constructor(props) {
    super(props);
  }

  async __init__(ifNotFound) {
    if (this.__DOCUMENT_NAME__) {
      const at = splitAddress(this.__DOCUMENT_NAME__);
      const api = await migadu();
      const found = at ? await remote(() => api.getMailbox(at.domain, at.localPart)) : null;

      if (found) {
        this.#remote = mailboxValues(at.domain, found);
        // Migadu fills the form; values sent by the request (a save) win.
        this.__DATA__ = {
          ...this.#remote,
          ...Object.fromEntries(Object.entries(this.__DATA__ || {}).filter(([, v]) => v != null)),
        };
        this.__IS_NEW__ = false;
      } else if (ifNotFound === 'new') {
        this.__IS_NEW__ = true;
      } else if (ifNotFound === 'null' || ifNotFound === null) {
        return null;
      } else {
        loopar.throw({ code: 404, message: `Mailbox ${this.__DOCUMENT_NAME__}: not found in Migadu` });
      }
    }

    await super.__init__();
    if (this.__DOCUMENT_NAME__) this.name = this.__DOCUMENT_NAME__;
  }

  /** Every mailbox of the domains registered here (lists and desk figures). */
  async virtualRecords() {
    return await remoteRecords(remoteMailboxes);
  }

  async save() {
    this.recovery_email = String(this.recovery_email || '').trim();
    return this.#remote ? await this.#update() : await this.#create();
  }

  async #update() {
    const stored = this.#remote;
    // Identity is fixed; a save that leaves a permission out keeps the current one.
    for (const f of ['name', 'address', 'domain', 'local_part', 'is_internal', 'status']) this[f] = stored[f];
    for (const f of FLAGS) this[f] = missing(this[f]) ? flag(stored[f]) : flag(this[f]);

    const changed = EDITABLE.filter((f) => String(this[f] ?? '') !== String(stored[f] ?? ''));
    if (!changed.length) return true;
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
    forgetMail(this.domain);
    return true;
  }

  async #create() {
    this.domain = normalizeDomain(this.domain);
    this.local_part = normalizeLocalPart(this.local_part);
    this.name = this.address = `${this.local_part}@${this.domain}`;
    this.is_internal = flag(this.is_internal);
    for (const f of FLAGS) this[f] = missing(this[f]) ? 1 : flag(this[f]);

    if (!(await loopar.db.getAll(DOMAIN, ['name'], { name: this.domain })).length) fail(`Mail Domain ${this.domain} does not exist.`);
    if (!isEmail(this.recovery_email)) fail('Enter the email where the owner will receive the invitation to set the password.');
    if (this.recovery_email.toLowerCase() === this.name) fail('The invitation must go to a different address than the new mailbox.');
    await this.validate();

    const api = await migadu();
    if (await remote(() => api.getMailbox(this.domain, this.local_part))) fail(`${this.name} already exists.`);
    if (await remote(() => api.getAlias(this.domain, this.local_part))) fail(`${this.name} is already an alias.`);

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
    forgetMail(this.domain);
    this.__IS_NEW__ = false;
    return true;
  }

  /** Deactivates the mailbox in Migadu; nothing is erased. */
  async delete() {
    if (!this.#remote) loopar.throw({ code: 404, message: `Mailbox ${this.name}: not found in Migadu` });
    const api = await migadu();
    await remote(() => api.updateMailbox(this.#remote.domain, this.#remote.local_part, {
      may_send: false, may_receive: false, may_access_imap: false,
    }));
    forgetMail(this.#remote.domain);
    return true;
  }
}
