'use strict';

import { BaseDocument } from 'loopar';
import { fail, isEmail } from '../../mail-service.js';

/** Credentials for Migadu and Cloudflare, plus the DMARC policy for new domains. */
export default class MailHostingSettings extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.migadu_user = String(this.migadu_user || '').trim();
    this.dmarc_report_email = String(this.dmarc_report_email || '').trim();
    if (this.migadu_user && !isEmail(this.migadu_user)) fail('The Migadu user is the email you log in to Migadu with.');
    if (this.dmarc_report_email && !isEmail(this.dmarc_report_email)) fail('The DMARC report address is not a valid email.');
  }
}
