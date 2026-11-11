'use strict';

import { BaseController, loopar } from 'loopar';
import { stripeMode } from '../../account-service.js';

export default class PlanController extends BaseController {
  static postOnlyActions = ['publish'];

  constructor(props) {
    super(props);
  }

  /** Copies a test plan to Stripe's live mode (once: refused when live has that id). */
  async actionPublish() {
    const name = this.query?.name;
    if (!name) loopar.throw({ code: 400, message: 'Missing plan.' });
    const doc = await loopar.getDocument(this.document, name);
    const live = await doc.publish();
    // No `message` key: the client gets the whole payload (http.jsx collapses messages).
    // `listed`: a test site doesn't list live plans, so there is nothing to open.
    return { published: live, listed: await stripeMode() === 'live' };
  }
}
