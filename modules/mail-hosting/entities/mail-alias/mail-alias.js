'use strict';

import { BaseDocument, loopar } from 'loopar';
import {
  DOMAIN, MAILBOX, ALIAS, fail, truthy, isEmail, normalizeDomain, normalizeLocalPart,
  migadu, remote, isFromRemote,
} from '../../mail-service.js';

const IMMUTABLE = ['domain', 'local_part', 'address', 'is_internal'];

/** Destinations text (one per line or comma separated) → clean list. */
export function parseDestinations(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

/**
 * An address that forwards to one or more mailboxes of the same domain
 * (e.g. ventas@ → ana@, luis@). Mirrored to Migadu on save and delete.
 */
export default class MailAlias extends BaseDocument {
  #storedDestinations = '';

  constructor(props) {
    super(props);
  }

  async beforeSave() {
    if (this.__IS_NEW__) {
      this.domain = normalizeDomain(this.domain);
      this.local_part = normalizeLocalPart(this.local_part);
      this.name = this.address = `${this.local_part}@${this.domain}`;
      this.is_internal = truthy(this.is_internal) ? 1 : 0;
    } else {
      const stored = await loopar.db.getRow(ALIAS, this.__DOCUMENT_NAME__ || this.name, [...IMMUTABLE, 'destinations']);
      if (stored) {
        for (const f of IMMUTABLE) this[f] = stored[f];
        this.#storedDestinations = String(stored.destinations || '');
      }
    }

    const list = parseDestinations(this.destinations);
    this.destinations = list.join('\n');
    if (isFromRemote(this)) return;

    if (!list.length) fail('Add at least one destination.');
    const bad = list.filter((x) => !isEmail(x));
    if (bad.length) fail(`Not valid email addresses: ${bad.join(', ')}`);
    const foreign = list.filter((x) => !x.endsWith(`@${this.domain}`));
    if (foreign.length) fail(`Migadu aliases can only deliver to addresses of ${this.domain}: ${foreign.join(', ')}`);
    if (list.includes(this.name)) fail('An alias cannot deliver to itself.');

    const api = await migadu();
    if (this.__IS_NEW__) {
      if (!(await loopar.db.getAll(DOMAIN, ['name'], { name: this.domain })).length) fail(`Mail Domain ${this.domain} does not exist.`);
      if ((await loopar.db.getAll(ALIAS, ['name'], { name: this.name })).length) fail(`${this.name} already exists.`);
      if ((await loopar.db.getAll(MAILBOX, ['name'], { name: this.name })).length) fail(`${this.name} is already a mailbox.`);
      await this.validate();
      await remote(() => api.createAlias(this.domain, {
        local_part: this.local_part,
        destinations: list,
        ...(this.is_internal ? { is_internal: true } : {}),
      }));
    } else if (this.destinations !== this.#storedDestinations) {
      await remote(() => api.updateAlias(this.domain, this.local_part, { destinations: list }));
    }
  }

  /** Local record first, Migadu after (same order and recovery as Mailbox). */
  async delete() {
    const { domain, local_part: localPart, name } = this;
    await super.delete(...arguments);
    if (isFromRemote(this)) return;

    const api = await migadu();
    try {
      await api.deleteAlias(domain, localPart);
    } catch (e) {
      fail(`${name} was removed from Loopar but Migadu did not delete it: ${e.message}. Delete it in Migadu, or run "Sync mailboxes" on the domain to bring it back.`);
    }
  }
}
