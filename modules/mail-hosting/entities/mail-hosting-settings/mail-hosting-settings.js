'use strict';

import { BaseDocument } from 'loopar';
import { fail, isEmail } from '../../mail-service.js';

/** Credentials for Migadu and Cloudflare, the default mail policy and portal options. */
export default class MailHostingSettings extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.migadu_user = String(this.migadu_user || '').trim();
    if (this.migadu_user && !isEmail(this.migadu_user)) fail('The Migadu user is the email you log in to Migadu with.');
  }
}
