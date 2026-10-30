'use strict';

import { BaseDocument, loopar } from 'loopar';
import {
  DOMAIN, fail, truthy, normalizeDomain, ensureRemoteDomain, domainStatus, isFromRemote,
} from '../../mail-service.js';

/** Maintained by the actions (readonly in the form). */
const SYSTEM_FIELDS = ['status', 'activated_at', 'cloudflare_zone', 'last_checked', 'dns_report', 'check_report'];

/**
 * A client domain hosted in Migadu. Creating it here creates it in Migadu
 * (or adopts it when it already exists there). Migadu's API cannot delete
 * domains: deleting the record only removes it from Loopar.
 */
export default class MailDomain extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    if (this.__IS_NEW__) {
      this.name = normalizeDomain(this.name);
      if (isFromRemote(this)) return;

      const exists = await loopar.db.getAll(DOMAIN, ['name'], { name: this.name });
      if (exists.length) fail(`${this.name} is already registered.`);
      // Validate before Migadu is touched, so a local failure can't leave an orphan remote domain.
      await this.validate();

      const remote = await ensureRemoteDomain(this.name, {
        createDefaultAddresses: this.create_default_addresses == null || this.create_default_addresses === '' || truthy(this.create_default_addresses),
      });
      this.status = domainStatus(remote);
      this.activated_at = remote?.activated_at || '';
      return;
    }

    if (isFromRemote(this)) return;
    const row = await loopar.db.getRow(DOMAIN, this.__DOCUMENT_NAME__ || this.name, SYSTEM_FIELDS);
    if (row) for (const f of SYSTEM_FIELDS) this[f] = row[f];
  }

  /** Writes fields the actions maintain, without running the form hooks. */
  async setSystem(values) {
    await loopar.db.updateRow(DOMAIN, this.__DOCUMENT_NAME__ || this.name, values);
    Object.assign(this, values);
  }
}
