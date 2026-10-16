// `fetch` for the play relays (issue #66): sends the signed-in player's
// session token, and sorts out a new account's first call and a signed-out
// player (see relay-auth.js). Without Clerk set up, or signed out, it's plain
// fetch, so the game plays as it always has.

import { accountHref, joinNeedsSignIn } from './account-logic.js';
import { loadAccountConfig, loadClerk } from './clerk.js';
import { bearerHeaders, sendWithToken } from './relay-auth.js';

// A token can't be got offline. Rather than leave a call waiting, or send it
// without one (and be taken for a signed-out player), the call fails like any
// other with no signal.
const TOKEN_TIMEOUT_MS = 10000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error('Timed out getting a sign-in token')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timeoutId));
  });
}

async function getToken({ skipCache = false } = {}) {
  let clerk;
  try {
    clerk = await loadClerk();
  } catch {
    // Clerk couldn't load (blocked, offline): play as signed out. If sign-in
    // is required, the server says so and the player is sent to sign in.
    return null;
  }
  if (!clerk?.session) {
    return null;
  }
  return withTimeout(clerk.session.getToken(skipCache ? { skipCache: true } : undefined), TOKEN_TIMEOUT_MS);
}

async function provision(token) {
  try {
    const response = await fetch('/me/provision', { method: 'POST', headers: bearerHeaders(token) });
    return response.ok;
  } catch {
    return false;
  }
}

function goToSignIn() {
  window.location.assign(accountHref('sign-in', `${window.location.pathname}${window.location.search}`));
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function authorisedFetch(url, init = {}) {
  return sendWithToken({
    send: (headers) => {
      const merged = new Headers(init.headers);
      for (const [name, value] of Object.entries(headers)) {
        merged.set(name, value);
      }
      return fetch(url, { ...init, headers: merged });
    },
    getToken,
    provision,
    onSignInRequired: goToSignIn,
  });
}

/**
 * True when sign-in is required and the player isn't signed in, so /play asks
 * them to sign in before joining. False when it can't tell (offline, Clerk
 * blocked): the server's answer to the join then decides.
 */
export async function mustSignInToJoin() {
  try {
    const config = await loadAccountConfig();
    const clerk = await loadClerk();
    return joinNeedsSignIn(config, Boolean(clerk?.user));
  } catch {
    return false;
  }
}
