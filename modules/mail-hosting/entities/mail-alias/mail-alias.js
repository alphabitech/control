'use strict';

import { BaseDocument, loopar } from 'loopar';
import {
  DOMAIN, fail, truthy, isEmail, normalizeDomain, normalizeLocalPart, splitAddress,
  migadu, remote, aliasValues, remoteAliases, remoteRecords, forgetMail,
} from '../../mail-service.js';

/** Destinations text (one per line or comma separated) → clean list. */
export function parseDestinations(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Mail Alias — virtual: no table. An address in Migadu that forwards to one
 * or more mailboxes of the same domain (e.g. ventas@ → ana@, luis@).
 * Listing, opening, saving and deleting talk to Migadu directly.
 */
export default class MailAlias extends BaseDocument {
  #remote = null;

  constructor(props) {
    super(props);
  }

  async __init__(ifNotFound) {
    if (this.__DOCUMENT_NAME__) {
      const at = splitAddress(this.__DOCUMENT_NAME__);
      const api = await migadu();
      const found = at ? await remote(() => api.getAlias(at.domain, at.localPart)) : null;

      if (found) {
        this.#remote = aliasValues(at.domain, found);
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
        loopar.throw({ code: 404, message: `Mail Alias ${this.__DOCUMENT_NAME__}: not found in Migadu` });
      }
    }

    await super.__init__();
    if (this.__DOCUMENT_NAME__) this.name = this.__DOCUMENT_NAME__;
  }

  /** Every alias of the domains registered here (lists and desk figures). */
  async virtualRecords() {
    return await remoteRecords(remoteAliases);
  }

  async save() {
    const stored = this.#remote;
    if (stored) {
      for (const f of ['name', 'address', 'domain', 'local_part', 'is_internal']) this[f] = stored[f];
    } else {
      this.domain = normalizeDomain(this.domain);
      this.local_part = normalizeLocalPart(this.local_part);
      this.name = this.address = `${this.local_part}@${this.domain}`;
      this.is_internal = truthy(this.is_internal) ? 1 : 0;
    }

    const list = parseDestinations(this.destinations);
    this.destinations = list.join('\n');

    if (!list.length) fail('Add at least one destination.');
    const bad = list.filter((x) => !isEmail(x));
    if (bad.length) fail(`Not valid email addresses: ${bad.join(', ')}`);
    const foreign = list.filter((x) => !x.endsWith(`@${this.domain}`));
    if (foreign.length) fail(`Migadu aliases can only deliver to addresses of ${this.domain}: ${foreign.join(', ')}`);
    if (list.includes(this.name)) fail('An alias cannot deliver to itself.');

    const api = await migadu();
    if (!stored) {
      if (!(await loopar.db.getAll(DOMAIN, ['name'], { name: this.domain })).length) fail(`Mail Domain ${this.domain} does not exist.`);
      await this.validate();
      if (await remote(() => api.getAlias(this.domain, this.local_part))) fail(`${this.name} already exists.`);
      if (await remote(() => api.getMailbox(this.domain, this.local_part))) fail(`${this.name} is already a mailbox.`);
      await remote(() => api.createAlias(this.domain, {
        local_part: this.local_part,
        destinations: list,
        ...(this.is_internal ? { is_internal: true } : {}),
      }));
      this.__IS_NEW__ = false;
    } else if (this.destinations !== stored.destinations) {
      await remote(() => api.updateAlias(this.domain, this.local_part, { destinations: list }));
    }
    forgetMail(this.domain);
    return true;
  }

  /** Deletes the alias in Migadu. */
  async delete() {
    if (!this.#remote) loopar.throw({ code: 404, message: `Mail Alias ${this.name}: not found in Migadu` });
    const api = await migadu();
    await remote(() => api.deleteAlias(this.#remote.domain, this.#remote.local_part));
    forgetMail(this.#remote.domain);
    return true;
  }
}
