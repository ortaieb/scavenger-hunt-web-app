// Pure, DOM-free logic for the /play page — kept separate from play.js
// (which does the DOM/permissions/polling wiring) so it can be unit tested
// directly with Vitest, no jsdom needed. Like challenge-logic.js, this only
// *describes* what the game-server decided: no verdict, distance or window
// logic ever runs on the phone.

/**
 * @typedef {{ id: string, name?: string, location?: string, 'start-time'?: string, 'end-time'?: string }} SessionInfo
 * @typedef {{ session: SessionInfo, participant: string, team: string }} Identity
 * @typedef {{ sequence: number, position: number, clue: string, open: boolean }} CurrentCheckpoint
 * @typedef {{
 *   status: string,
 *   team?: string,
 *   progress?: { completed: number, total: number },
 *   current?: CurrentCheckpoint | null,
 *   session?: { phase?: string },
 * }} GameState
 * @typedef {'unknown' | 'denied' | 'granted'} PermissionStatus
 * @typedef {{
 *   identity: Identity | null,
 *   permissions: PermissionStatus,
 *   state: GameState | null,
 *   offline?: boolean,
 * }} AppState
 * @typedef {'join' | 'permissions' | 'loading' | 'lobby' | 'playing' | 'finished' | 'ended'} Screen
 */

/**
 * Which screen to show, worked out only from what's stored and the latest
 * `GET /state` — never from anything the page remembers about where it was,
 * so a reload, a locked screen or lost signal always lands on the right one.
 *
 * @param {AppState} appState
 * @returns {Screen}
 */
export function screenFor(appState) {
  if (!appState.identity) {
    return 'join';
  }
  if (appState.permissions !== 'granted') {
    return 'permissions';
  }
  const state = appState.state;
  if (!state) {
    return 'loading';
  }
  // A newer game-server reports the moderator's stop in the session clock
  // (see issue #43); today's only says `ended` in the status.
  if (state.session?.phase === 'stopped' || state.status === 'ended') {
    return 'ended';
  }
  switch (state.status) {
    case 'not_started':
      return 'lobby';
    case 'playing':
      return 'playing';
    case 'finished':
      return 'finished';
    default:
      return 'loading';
  }
}

/**
 * The one instruction line shown under each screen's title (the full table
 * is in issue #41; the rows for screens not built yet are filled in there).
 *
 * @param {AppState} appState
 * @returns {string}
 */
export function instructionFor(appState) {
  if (appState.offline) {
    return "No connection. We'll retry when you're back online.";
  }
  switch (screenFor(appState)) {
    case 'join':
      return 'Enter your team code to join.';
    case 'permissions':
      return appState.permissions === 'denied'
        ? 'Turn on camera and location for this site, then tap "Try again".'
        : 'Allow the camera and location so you can check in at checkpoints.';
    case 'loading':
      return 'Loading your game…';
    case 'lobby':
      return 'Waiting for the moderator to start.';
    case 'playing':
      return appState.state?.current?.open === false
        ? "This checkpoint isn't open yet. Check back soon."
        : 'Solve the clue and go there. Tap "I\'m here" when you arrive.';
    case 'finished':
      return 'All checkpoints done. Wait for the moderator.';
    case 'ended':
      return 'The session is over. Thanks for playing!';
  }
  return '';
}

/**
 * A countdown as m:ss under an hour and h:mm:ss above. Anything at or below
 * zero (or not a number) shows as 0:00: reaching zero ends nothing by
 * itself — only the moderator's stop does.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatCountdown(ms) {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/**
 * How far the phone's clock is behind the server's, in ms: the server's
 * time minus the phone's time when the response arrived. Add it to
 * Date.now() to get server time. 0 when the server time is missing or
 * unparseable, so a bad value never skews a countdown.
 *
 * @param {unknown} serverTime ISO 8601 timestamp from the server
 * @param {number} receivedAt the phone's Date.now() when the response arrived
 * @returns {number}
 */
export function clockOffset(serverTime, receivedAt) {
  const server = typeof serverTime === 'string' ? Date.parse(serverTime) : NaN;
  return Number.isFinite(server) && Number.isFinite(receivedAt) ? server - receivedAt : 0;
}

/**
 * @typedef {{
 *   screen: Screen | null,
 *   message: string,
 *   forgetIdentity: boolean,
 * }} ErrorOutcome
 */

/**
 * Where a failed call to this app's relays should take the player, and
 * what to tell them. `screen: null` means stay where you are and show the
 * message. Branches on the game-server's `code` when there is one, never on
 * its `detail` text (see issue #43), then on the status.
 *
 * Status 0 stands for a call that never came back (no signal, a timeout).
 *
 * @param {number} status
 * @param {unknown} body already-parsed JSON, or null
 * @returns {ErrorOutcome}
 */
export function screenForError(status, body) {
  const code = body && typeof body === 'object' && 'code' in body ? body.code : undefined;

  if (code === 'session_stopped') {
    return outcome('ended', 'This session is over.');
  }
  if (code === 'session_not_started') {
    return outcome('lobby', '');
  }

  if (status === 404) {
    // An unknown team code on join, or a stored identity the server no
    // longer knows on /state: either way, back to Join with a clean slate.
    return outcome('join', "We don't recognise that team code. Check it and try again.", true);
  }
  if (status === 409) {
    // Today's /join answers a plain 409 when the session is over.
    return outcome('ended', 'This session is over.');
  }
  if (status === 422) {
    return outcome(null, 'Check your team code and tick the box to agree, then try again.');
  }
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return outcome(null, "No connection. We'll retry when you're back online.");
  }
  return outcome(null, `Something went wrong (error ${status}). Please try again.`);
}

function outcome(screen, message, forgetIdentity = false) {
  return { screen, message, forgetIdentity };
}

/**
 * Team codes are typed on a phone keyboard: upper-case them and drop
 * surrounding spaces, but otherwise leave them for the server to judge.
 *
 * @param {string} value
 * @returns {string}
 */
export function normaliseTeamCode(value) {
  return String(value ?? '').trim().toUpperCase();
}

/**
 * Validates an identity read back from storage (it may be from an older
 * version of the page, or tampered with). Returns null unless it has
 * everything the game needs.
 *
 * @param {unknown} value
 * @returns {Identity | null}
 */
export function readIdentity(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { session, participant, team } = /** @type {Record<string, unknown>} */ (value);
  if (
    !session ||
    typeof session !== 'object' ||
    typeof (/** @type {Record<string, unknown>} */ (session).id) !== 'string' ||
    typeof participant !== 'string' ||
    typeof team !== 'string'
  ) {
    return null;
  }
  return /** @type {Identity} */ ({ session, participant, team });
}

/**
 * The identity to store from a successful `POST /join` response, or null
 * if the response doesn't have the expected shape.
 *
 * @param {unknown} body
 * @returns {Identity | null}
 */
export function identityFromJoin(body) {
  return readIdentity(body);
}

/**
 * A planned time as the phone's local clock time, e.g. "10:00". The
 * planned window is only a guide: the moderator starts and finishes the
 * game.
 *
 * @param {unknown} isoTime
 * @returns {string} '' if missing or unparseable
 */
export function formatPlannedTime(isoTime) {
  const time = typeof isoTime === 'string' ? Date.parse(isoTime) : NaN;
  if (!Number.isFinite(time)) {
    return '';
  }
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
