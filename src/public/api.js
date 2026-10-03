// Calls from the /play page to this app's own relays (never the game-server
// directly — see the relays in src/app.ts), each with a timeout so a lost
// signal never leaves the page waiting forever.

const REQUEST_TIMEOUT_MS = 15000;
// The referee checks a photo before /challenge answers, and this app's
// relay allows the game-server 45 s (GAME_SERVER_TIMEOUT_MS) for it.
const PHOTO_TIMEOUT_MS = 60000;

/**
 * @typedef {{ status: number, body: unknown, text: string, receivedAt: number }} ApiResult
 *   `status` is 0 when the call never came back (no signal, a timeout);
 *   `body` is the parsed JSON, or null if there was none or it wasn't JSON;
 *   `text` is the raw body;
 *   `receivedAt` is the phone's Date.now() when the response arrived, for
 *   clockOffset().
 */

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 * @returns {Promise<ApiResult>}
 */
async function callRelay(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const receivedAt = Date.now();
    const text = await response.text();
    return { status: response.status, body: parseJsonSafely(text), text, receivedAt };
  } catch {
    return { status: 0, body: null, text: '', receivedAt: Date.now() };
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

/**
 * "I'm here": check in at the current checkpoint, for its code and pose.
 *
 * @param {string} session
 * @param {string} participant
 * @param {number} checkpoint the current checkpoint's sequence
 * @returns {Promise<ApiResult>}
 */
export function arrive(session, participant, checkpoint) {
  return callRelay('/arrive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, participant, checkpoint }),
  });
}

/**
 * Sends a photo for the referee, with the same form fields /challenge
 * posts: only raw claims, never anything that looks like a result.
 *
 * @param {{
 *   session: string,
 *   participant: string,
 *   checkpoint: number,
 *   image: Blob,
 *   position: GeolocationPosition,
 * }} photo
 * @returns {Promise<ApiResult>}
 */
export function sendPhoto({ session, participant, checkpoint, image, position }) {
  const form = new FormData();
  form.append('session', session);
  form.append('participant', participant);
  form.append('checkpoint', String(checkpoint));
  form.append('image', image, 'challenge.jpg');
  form.append('latitude', String(position.coords.latitude));
  form.append('longitude', String(position.coords.longitude));
  form.append('capturedAt', new Date(position.timestamp).toISOString());
  return callRelay('/challenge', { method: 'POST', body: form }, PHOTO_TIMEOUT_MS);
}
