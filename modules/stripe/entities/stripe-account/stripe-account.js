'use strict';

import { BaseDocument, loopar } from 'loopar';
import { keyMode } from '../../stripe-keys.js';

/**
 * Stripe credentials of this control plane. The mode is never chosen by
 * hand: it is the mode of the Secret Key, so the record can't say "test"
 * while it charges live cards (or the other way around).
 */
export default class StripeAccount extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async save() {
    // A password field left untouched arrives empty or masked: only a value
    // that is a Stripe key says something about the mode.
    const secretMode = keyMode(this.secret_key);
    const mode = secretMode || (this.mode === 'live' ? 'live' : this.mode === 'test' ? 'test' : null);
    if (secretMode) this.mode = secretMode;

    const publishable = keyMode(this.publishable_key);
    if (mode && publishable && publishable !== mode) {
      loopar.throw(`The Publishable Key is a ${publishable} key but the Secret Key is ${mode}: both must be of the same Stripe mode.`);
    }

    const testKey = keyMode(this.test_secret_key);
    if (testKey === 'live') {
      loopar.throw('Test secret key must be a test key (sk_test_…): it is only used to prepare Plans in test mode.');
    }
    if (testKey && mode === 'test') {
      loopar.throw('This account already runs in test mode with its Secret Key: leave Test secret key empty.');
    }

    return await super.save(...arguments);
  }
}
