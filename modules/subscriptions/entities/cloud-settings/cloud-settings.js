'use strict';

import { BaseDocument, loopar } from 'loopar';

/** Defaults of Loopar Cloud: what happens to a workspace after it is canceled. */
export default class CloudSettings extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    const days = Number(this.deletion_grace_days);
    if (!Number.isInteger(days) || days < 1) loopar.throw('Days before deleting must be a whole number, at least 1.');
  }
}
