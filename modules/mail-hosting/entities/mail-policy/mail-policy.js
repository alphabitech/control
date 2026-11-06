'use strict';

import { BaseDocument } from 'loopar';
import { fail, isEmail } from '../../mail-service.js';
import { parseSpfTerms } from '../../dns-plan.js';

/**
 * SPF and DMARC rules for client domains, chosen with options instead of raw
 * DNS. Configure DNS turns the domain's policy into records.
 */
export default class MailPolicy extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    const { terms, invalid } = parseSpfTerms(this.spf_custom);
    if (invalid.length) fail(`Not valid SPF entries: ${invalid.join(', ')}`);
    this.spf_custom = terms.join('\n');

    this.dmarc_rua = String(this.dmarc_rua || '').trim().replace(/^mailto:/i, '');
    if (this.dmarc_reports === 'custom' && !isEmail(this.dmarc_rua)) fail('Enter the address that receives the DMARC reports.');
  }
}
