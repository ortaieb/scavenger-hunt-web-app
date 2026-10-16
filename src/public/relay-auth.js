// Pure, DOM-free logic for sending the player's session token with each play
// call (issue #66), unit-tested with Vitest. Clerk's tokens live 60 seconds
// and phones put background tabs to sleep, so a token is asked for before
// every call (clerk-js hands back the cached one while it's fresh) rather
// than kept.

/** The headers that carry a token, or none for a signed-out player. */
export function bearerHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * True when `response` is a 401 whose body says `code`. Reads a clone, so
 * the caller can still read the response itself.
 *
 * @param {Response} response
 * @param {string} code
 */
export async function isUnauthorisedWith(response, code) {
  if (response.status !== 401) {
    return false;
  }
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return Boolean(body) && typeof body === 'object' && body.code === code;
}

/**
 * Makes one play call with the player's token.
 *
 * - `provisioning_required`: a new account's first call. Asks the game-server
 *   to set the person up (`provision`), then sends the call once more with a
 *   fresh token (the cached one doesn't have the new claims yet). Never more
 *   than once, whatever the second answer is. If provisioning fails the first
 *   answer is the result.
 * - `sign_in_required` when no token was sent: the player is signed out, so
 *   `onSignInRequired` takes them to sign in. With a token sent it's not
 *   that, and the page must not go round in circles, so it's just the result.
 *
 * @param {{
 *   send: (headers: Record<string, string>) => Promise<Response>,
 *   getToken: (options?: { skipCache?: boolean }) => Promise<string | null>,
 *   provision: (token: string) => Promise<boolean>,
 *   onSignInRequired: () => void,
 * }} calls
 * @returns {Promise<Response>}
 */
export async function sendWithToken({ send, getToken, provision, onSignInRequired }) {
  let token = await getToken();
  let response = await send(bearerHeaders(token));

  if (token && (await isUnauthorisedWith(response, 'provisioning_required')) && (await provision(token))) {
    token = await getToken({ skipCache: true });
    response = await send(bearerHeaders(token));
  }

  if (!token && (await isUnauthorisedWith(response, 'sign_in_required'))) {
    onSignInRequired();
  }
  return response;
}
