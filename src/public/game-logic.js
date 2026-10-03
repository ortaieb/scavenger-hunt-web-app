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
 *   phase?: string,
 *   'planned-start'?: string,
 *   'planned-end'?: string,
 *   'started-at'?: string | null,
 *   'stopped-at'?: string | null,
 *   'server-time'?: string,
 * }} SessionClock
 * @typedef {{ points: number, 'in-review'?: number, final?: boolean, place?: number | null }} Score
 * @typedef {{
 *   status: string,
 *   team?: string,
 *   progress?: { completed: number, total: number },
 *   current?: CurrentCheckpoint | null,
 *   session?: SessionClock,
 *   score?: Score,
 * }} GameState
 * @typedef {'unknown' | 'denied' | 'granted'} PermissionStatus
 * @typedef {'code' | 'photo' | 'sending' | 'verdict'} CheckpointStep
 * @typedef {{ step: CheckpointStep, verdict?: 'pass' | 'pending' | 'failed' }} CheckpointProgress
 *   Where the team is within the current checkpoint, once past the clue:
 *   a code issued, a photo taken, sending it, or a verdict back (issue #42).
 * @typedef {{
 *   identity: Identity | null,
 *   permissions: PermissionStatus,
 *   state: GameState | null,
 *   checkpoint?: CheckpointProgress | null,
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
      return playingInstruction(appState);
    case 'finished':
      return 'All checkpoints done. Wait for the moderator.';
    case 'ended':
      return 'The session is over. Thanks for playing!';
  }
  return '';
}

/** @param {AppState} appState */
function playingInstruction(appState) {
  const checkpoint = appState.checkpoint;
  switch (checkpoint?.step) {
    case 'code':
      return 'Strike the pose and take the photo.';
    case 'photo':
      return 'Check your photo, then send it.';
    case 'sending':
      return 'The referee is checking your photo.';
    case 'verdict':
      if (checkpoint.verdict === 'pass') {
        return 'Checkpoint done. Tap "Next clue".';
      }
      if (checkpoint.verdict === 'pending') {
        return 'A moderator will check your photo. Tap "Next clue".';
      }
      return 'Not quite. Read why, then tap "Try again".';
  }
  return appState.state?.current?.open === false
    ? "This checkpoint isn't open yet. Check back soon."
    : 'Solve the clue and go there. Tap "I\'m here" when you arrive.';
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

// --- status bar (issue #41) ------------------------------------------------
// Sticky at the top of every screen from the lobby on. Like the rest of
// this file it only shows what the server sent: the points rules, the
// clock and the finish are all the server's.

const TEAM_NAME_MAX = 14;
const AMBER_UNDER_MS = 15 * 60_000;
const RED_UNDER_MS = 5 * 60_000;

/** The screens that show the status bar. */
const STATUS_BAR_SCREENS = new Set(['lobby', 'playing', 'finished', 'ended']);

/**
 * @param {Screen} screen
 * @returns {boolean}
 */
export function showsStatusBar(screen) {
  return STATUS_BAR_SCREENS.has(screen);
}

/**
 * The team name, cut to 14 characters (the last one an ellipsis) so row one
 * fits at 320 px.
 *
 * @param {unknown} team
 * @returns {string}
 */
export function teamLabel(team) {
  const name = typeof team === 'string' ? team.trim() : '';
  return name.length > TEAM_NAME_MAX ? `${name.slice(0, TEAM_NAME_MAX - 1)}…` : name;
}

/**
 * Checkpoints completed so far, e.g. "0 of 3", or "3 of 3 ✓" once
 * finished. The server counts passed and in-review photos; this only shows
 * its numbers.
 *
 * @param {GameState | null} state
 * @returns {string} '' when the state has no progress
 */
export function progressLabel(state) {
  const progress = state?.progress;
  if (!progress || !Number.isInteger(progress.completed) || !Number.isInteger(progress.total)) {
    return '';
  }
  const label = `${progress.completed} of ${progress.total}`;
  return state.status === 'finished' || (progress.total > 0 && progress.completed >= progress.total)
    ? `${label} ✓`
    : label;
}

/**
 * @typedef {{ text: string, inReview: boolean, final: boolean }} PointsLabel
 */

/**
 * The team's points if the session finished now. A dot (•) while a photo
 * is in review, which may lower them once accepted. Lowest wins.
 *
 * @param {Score | undefined | null} score
 * @returns {PointsLabel | null} null when the server sent no score (an
 *   older game-server), so the element can be hidden.
 */
export function pointsLabel(score) {
  if (!score || typeof score.points !== 'number' || !Number.isFinite(score.points)) {
    return null;
  }
  const inReview = (score['in-review'] ?? 0) > 0;
  const unit = score.points === 1 ? 'pt' : 'pts';
  return { text: `${score.points} ${unit}${inReview ? ' •' : ''}`, inReview, final: score.final === true };
}

/**
 * 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd".
 *
 * @param {number} n
 * @returns {string}
 */
export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/**
 * What the points sheet says when the points are tapped: how scoring
 * works, what "in review" means, and the final points and place after the
 * finish.
 *
 * @param {Score | undefined | null} score
 * @returns {{ title: string, lines: string[] }}
 */
export function pointsSheetFor(score) {
  const lines = [];
  const points = typeof score?.points === 'number' ? score.points : null;
  const inReview = score?.['in-review'] ?? 0;

  if (score?.final === true && points !== null) {
    lines.push(
      typeof score.place === 'number'
        ? `Final points: ${points}. Your team came ${ordinal(score.place)}.`
        : `Final points: ${points}.`,
    );
  } else if (points !== null) {
    lines.push(`Your points if the session finished now: ${points}.`);
  }

  lines.push(
    'Lowest wins.',
    'At each checkpoint your team scores its place there: 1 if your photo was accepted first, 2 if second, 3 if third, and so on.',
    'A checkpoint still to do counts N+1, where N is the number of teams playing.',
  );

  if (inReview > 0 && score?.final !== true) {
    lines.push(
      `• In review: ${inReview === 1 ? '1 photo is' : `${inReview} photos are`} waiting for a moderator. ` +
        'Until then it counts N+1; once accepted it scores your place there, which lowers your points.',
    );
  }

  return { title: score?.final === true ? 'Final points' : 'Points', lines };
}

/**
 * @typedef {'normal' | 'amber' | 'red' | 'over' | 'lobby' | 'none'} TimeLevel
 * @typedef {{ text: string, words: string, level: TimeLevel }} TimeLeft
 */

/**
 * The time element: a countdown to the planned end, corrected for the
 * phone's clock (`serverNow` = Date.now() + clockOffset). m:ss under an
 * hour, h:mm:ss above; amber under 15 minutes and red under 5, with "min
 * left" in words too so colour is never the only signal. Past the planned
 * end it says "Finishing soon": reaching zero ends nothing, only the
 * moderator's stop does. The lobby shows the planned start instead.
 *
 * Today's game-server has no `session` clock in `/state` yet, so the
 * planned times fall back to the join response's `start-time`/`end-time`.
 *
 * @param {AppState} appState
 * @param {number} serverNow ms since the epoch, in server time
 * @returns {TimeLeft}
 */
export function timeLeftFor(appState, serverNow) {
  const state = appState.state;
  const clock = state?.session;
  const planned = appState.identity?.session;

  if (state?.status === 'not_started' || clock?.phase === 'scheduled') {
    const start = formatPlannedTime(clock?.['planned-start'] ?? planned?.['start-time']);
    return start ? { text: `Planned start ${start}`, words: '', level: 'lobby' } : none();
  }
  if (state?.status !== 'playing' || clock?.phase === 'stopped') {
    return none();
  }

  const end = Date.parse(String(clock?.['planned-end'] ?? planned?.['end-time'] ?? ''));
  if (!Number.isFinite(end) || !Number.isFinite(serverNow)) {
    return none();
  }

  const remaining = end - serverNow;
  if (remaining <= 0) {
    return { text: 'Finishing soon', words: '', level: 'over' };
  }

  const text = formatCountdown(remaining);
  if (remaining < AMBER_UNDER_MS) {
    // Round up, so it never says "0 min left" while time remains.
    const minutes = Math.ceil(remaining / 60_000);
    return { text, words: `${minutes} min left`, level: remaining < RED_UNDER_MS ? 'red' : 'amber' };
  }
  return { text, words: '', level: 'normal' };
}

function none() {
  return { text: '', words: '', level: 'none' };
}

/**
 * The clue row: the current checkpoint's clue, or the phase when there's
 * no clue. Hidden on the Clue screen itself, where the clue fills the body.
 *
 * @param {AppState} appState
 * @returns {{ text: string, isClue: boolean, hidden: boolean }}
 */
export function clueLineFor(appState) {
  const screen = screenFor(appState);
  const clue = appState.state?.current?.clue;

  if (screen === 'playing' && typeof clue === 'string' && clue) {
    // The Clue screen is "playing" before a code is issued (issue #42).
    return { text: clue, isClue: true, hidden: !appState.checkpoint };
  }
  const phase = {
    lobby: 'Waiting for the moderator',
    finished: 'All done',
    ended: 'Session over',
  }[screen];
  return { text: phase ?? '', isClue: false, hidden: !phase };
}

/**
 * Where the countdown's clock comes from: the server time in the latest
 * state, so it re-syncs on every poll. 0 (trust the phone) when there is
 * none.
 *
 * @param {GameState | null} state
 * @param {number} receivedAt
 * @returns {number}
 */
export function clockOffsetFromState(state, receivedAt) {
  return clockOffset(state?.session?.['server-time'], receivedAt);
}
