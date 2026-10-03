// Calls from the /play page to this app's own relays (never the game-server
// directly — see the relays in src/app.ts), each with a timeout so a lost
// signal never leaves the page waiting forever.

const REQUEST_TIMEOUT_MS = 15000;

/**
 * @typedef {{ status: number, body: unknown, receivedAt: number }} ApiResult
 *   `status` is 0 when the call never came back (no signal, a timeout);
 *   `body` is the parsed JSON, or null if there was none or it wasn't JSON;
 *   `receivedAt` is the phone's Date.now() when the response arrived, for
 *   clockOffset().
 */

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<ApiResult>}
 */
async function callRelay(url, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const receivedAt = Date.now();
    const text = await response.text();
    return { status: response.status, body: parseJsonSafely(text), receivedAt };
  } catch {
    return { status: 0, body: null, receivedAt: Date.now() };
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `consent` is only ever sent as the player's own tick — callers must not
 * call this until the box is ticked, and this never defaults it.
 *
 * @param {string} code
 * @param {true} consent
 * @returns {Promise<ApiResult>}
 */
export function join(code, consent) {
  return callRelay('/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, consent }),
  });
}

/**
 * @param {string} session
 * @param {string} participant
 * @returns {Promise<ApiResult>}
 */
export function fetchState(session, participant) {
  const query = new URLSearchParams({ session, participant });
  return callRelay(`/state?${query}`, { cache: 'no-store' });
}
