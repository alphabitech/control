'use strict';

import { DeskPageController } from 'loopar';
import { syncSubscriptions } from '../../../subscriptions/subscription-sync.js';

/** Loopar Cloud home: subscriptions, workspaces and what needs attention. */
export default class CloudController extends DeskPageController {
  constructor(props) {
    super(props);
  }

  /** Figures read the Subscription table: bring it up to date with Stripe first. */
  async actionView(...args) {
    await syncSubscriptions();
    return await super.actionView(...args);
  }
}
