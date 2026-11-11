'use strict';

/**
 * In Stripe the key decides the mode: sk_live_… / sk_test_… (secret),
 * rk_… (restricted), pk_… (publishable). 'live' | 'test', or null when the
 * value is not a Stripe key (empty, masked, encrypted at rest…).
 */
export function keyMode(key) {
  const m = /^(?:sk|rk|pk)_(live|test)_/.exec(String(key || '').trim());
  return m ? m[1] : null;
}
