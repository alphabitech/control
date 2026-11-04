'use strict';

/*
 * Stripe id of a Customer. The core Customer is generic: integrations keep
 * their ids in Customer.external_ids (crm/customers.js), Stripe under "stripe".
 */

import { externalId, setExternalId, customerByExternalId } from '../../../loopar/modules/crm/customers.js';

export const STRIPE_SOURCE = 'stripe';

/** Stripe customer id of `customerName`, or null. */
export const stripeIdOf = async (customerName) => (customerName ? await externalId(customerName, STRIPE_SOURCE) : null);

/** Stores the Stripe customer id of `customerName`. */
export const setStripeId = (customerName, id) => setExternalId(customerName, STRIPE_SOURCE, id);

/** Customer whose Stripe id is `id`, or null. */
export const customerOfStripeId = (id) => customerByExternalId(STRIPE_SOURCE, id);
