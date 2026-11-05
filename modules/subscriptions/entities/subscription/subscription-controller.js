'use strict';

import { BaseController, loopar } from 'loopar';
import { grantPortalAccess } from '../../account-service.js';

export default class SubscriptionController extends BaseController {
  static postOnlyActions = ['portalAccess'];

  constructor(props) {
    super(props);
  }

  /**
   * Customer portal access for the subscription's customer: creates their Web
   * user when missing and issues a one-use sign-in link (7 days). `send=1`
   * emails it; otherwise the link comes back so the operator can hand it
   * over or open it in a private window. A new link invalidates older ones.
   */
  async actionPortalAccess() {
    const name = this.query?.name;
    if (!name) loopar.throw({ code: 400, message: 'Missing subscription.' });
    const sub = await loopar.db.getRow('Subscription', name, ['name', 'customer']);
    if (!sub) loopar.throw({ code: 404, message: `Subscription ${name} not found.` });
    if (!sub.customer) loopar.throw('This subscription has no customer.');

    const send = [1, '1', true, 'true'].includes(this.query?.send);
    // No `message` key: the client gets the whole payload (http.jsx collapses messages).
    return await grantPortalAccess(sub.customer, { req: this.req, sendEmail: send, returnLink: !send });
  }
}
