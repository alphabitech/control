'use strict';

import { BaseDocument } from 'loopar';
import { syncSubscriptions } from '../../subscription-sync.js';

export default class Subscription extends BaseDocument {
  constructor(props) {
    super(props);
  }

  /** Lists show Stripe's current state (synced at most once a minute). */
  async getList(...args) {
    await syncSubscriptions();
    return await super.getList(...args);
  }
}
