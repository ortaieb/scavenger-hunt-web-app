// Pure, DOM-free logic for the moderator screen at /moderator (issue #44),
// unit-tested with Vitest like game-logic.js. It only describes what the
// game-server's overview says: the phase, the standings and the blocked
// attempts. It shows checkpoint numbers and names, never clues, locations
// or photos (the overview never sends them).

import { clockOffset, formatCountdown, formatPlannedTime, ordinal } from './game-logic.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @typedef {{
 *   phase?: string,
 *   'planned-start'?: string,
 *   'planned-end'?: string,
 *   'started-at'?: string | null,
 *   'stopped-at'?: string | null,
 *   'server-time'?: string,
 * }} SessionClock
 * @typedef {{ sequence: number, name: string, verdict?: string, at?: string }} LastCompleted
 * @typedef {{
 *   team: string,
 *   joined: boolean,
 *   completed: number | null,
 *   total: number | null,
 *   points: number | null,
 *   'in-review': number | null,
 *   place: number | null,
 *   'last-completed': LastCompleted | null,
 *   current: { sequence: number, name: string } | null,
 * }} TeamStanding
 * @typedef {{ at: string, team: string, action: string, code: string }} BlockedAttempt
 * @typedef {{ session: SessionClock, teams: TeamStanding[], blocked: BlockedAttempt[] }} Overview
 */

/**
 * The session id from the link, /moderator?session=<uuid>.
 *
 * @param {URLSearchParams} searchParams
 * @returns {string | null}
 */
export function readSessionId(searchParams) {
  const session = searchParams.get('session');
  return session !== null && UUID_RE.test(session) ? session : null;
}

/** @typedef {'scheduled' | 'running' | 'stopped' | 'unknown'} Phase */

/**
 * @param {SessionClock | undefined | null} clock
 * @returns {Phase}
 */
export function phaseOf(clock) {
  const phase = clock?.phase;
  return phase === 'scheduled' || phase === 'running' || phase === 'stopped' ? phase : 'unknown';
}

/**
 * @typedef {{
 *   label: string,
 *   tone: 'idle' | 'running' | 'late' | 'finished' | 'unknown',
 *   countdown: string,
 *   times: string,
 * }} PhaseBadge
 */

/**
 * The phase badge: Not started, Running or Finished, the countdown to the
 * planned end while running ("past planned end" once it has passed, as a
 * reminder to finish), and the planned and actual times.
 *
 * @param {SessionClock | undefined | null} clock
 * @param {number} serverNow ms since the epoch, in server time
 * @returns {PhaseBadge}
 */
export function phaseBadge(clock, serverNow) {
  const phase = phaseOf(clock);
  const times = timesLine(clock);

  if (phase === 'scheduled') {
    return { label: 'Not started', tone: 'idle', countdown: '', times };
  }
  if (phase === 'stopped') {
    return { label: 'Finished', tone: 'finished', countdown: '', times };
  }
  if (phase === 'running') {
    const end = Date.parse(clock?.['planned-end'] ?? '');
    if (Number.isFinite(end) && Number.isFinite(serverNow)) {
      const remaining = end - serverNow;
      if (remaining <= 0) {
        return { label: 'Running, past planned end', tone: 'late', countdown: '', times };
      }
      return { label: 'Running', tone: 'running', countdown: `${formatCountdown(remaining)} to planned end`, times };
    }
    return { label: 'Running', tone: 'running', countdown: '', times };
  }
  return { label: 'Unknown', tone: 'unknown', countdown: '', times };
}

/**
 * "Planned 10:00–13:00, started 10:03, finished 12:47".
 *
 * @param {SessionClock | undefined | null} clock
 * @returns {string}
 */
function timesLine(clock) {
  const parts = [];
  const start = formatPlannedTime(clock?.['planned-start']);
  const end = formatPlannedTime(clock?.['planned-end']);
  if (start && end) {
    parts.push(`Planned ${start}–${end}`);
  }
  const startedAt = formatPlannedTime(clock?.['started-at']);
  if (startedAt) {
    parts.push(`started ${startedAt}`);
  }
  const stoppedAt = formatPlannedTime(clock?.['stopped-at']);
  if (stoppedAt) {
    parts.push(`finished ${stoppedAt}`);
  }
  return parts.join(', ');
}

/**
 * Which session button to offer: Start only before the start (at any
 * time, not only at the planned start), Finish only while running, and
 * neither once finished.
 *
 * @param {SessionClock | undefined | null} clock
 * @returns {{ start: boolean, finish: boolean }}
 */
export function actionsFor(clock) {
  const phase = phaseOf(clock);
  return { start: phase === 'scheduled', finish: phase === 'running' };
}

export const CONFIRM_START = 'Teams can check in and send photos from now.';
export const CONFIRM_FINISH = "Teams can't check in or send photos after this. This can't be undone.";

/**
 * How long ago something happened, by server time: "just now",
 * "1 min ago", "14 min ago", "1 h 5 min ago".
 *
 * @param {unknown} isoTime
 * @param {number} serverNow
 * @returns {string} '' if the time is missing or unparseable
 */
export function agoWords(isoTime, serverNow) {
  const at = typeof isoTime === 'string' ? Date.parse(isoTime) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(serverNow)) {
    return '';
  }
  const minutes = Math.floor(Math.max(0, serverNow - at) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h ago` : `${hours} h ${rest} min ago`;
}

/**
 * The line under each team that shows who is stuck: the last checkpoint
 * completed and how long ago it was approved (or sent, if still in review).
 *
 * @param {TeamStanding} team
 * @param {number} serverNow
 * @returns {string}
 */
export function lastCompletedLine(team, serverNow) {
  if (!team.joined) {
    return 'Not joined yet';
  }
  const last = team['last-completed'];
  if (!last) {
    return 'Nothing completed yet';
  }
  const ago = agoWords(last.at, serverNow);
  const what = `Last #${last.sequence} ${last.name}`;
  if (last.verdict === 'pending') {
    return ago ? `${what}, sent ${ago}, in review` : `${what}, in review`;
  }
  return ago ? `${what}, approved ${ago}` : what;
}

/**
 * @typedef {{
 *   name: string,
 *   joined: string,
 *   progress: string,
 *   points: string,
 *   inReview: string,
 *   place: string,
 *   current: string,
 * }} TeamRow
 */

/**
 * One standings row. Words, not colour: "joined" / "not joined", "1 in
 * review", and the place once the result is final.
 *
 * @param {TeamStanding} team
 * @param {boolean} final whether the session has finished
 * @returns {TeamRow}
 */
export function teamRow(team, final) {
  const joined = team.joined === true;
  const inReview = team['in-review'] ?? 0;
  return {
    name: team.team,
    joined: joined ? 'joined' : 'not joined',
    progress: joined && Number.isInteger(team.completed) && Number.isInteger(team.total) ? `${team.completed} of ${team.total}` : '',
    points: joined && typeof team.points === 'number' ? `${team.points} ${team.points === 1 ? 'pt' : 'pts'}` : '',
    inReview: joined && inReview > 0 ? `${inReview} in review` : '',
    place: final && typeof team.place === 'number' ? ordinal(team.place) : '',
    current: joined && team.current ? `On #${team.current.sequence} ${team.current.name}` : '',
  };
}

const ACTION_WORDS = { join: 'tried to join', arrive: 'tried to check in', photo: 'sent a photo' };
const REASON_WORDS = { session_not_started: 'not started', session_stopped: 'finished' };

/**
 * One line under "Blocked outside the session", e.g.
 * "13:05 Blue Herons sent a photo (finished)".
 *
 * @param {BlockedAttempt} attempt
 * @returns {{ time: string, text: string }}
 */
export function blockedLine(attempt) {
  const action = ACTION_WORDS[attempt.action] ?? attempt.action;
  const reason = REASON_WORDS[attempt.code] ?? attempt.code;
  return { time: formatPlannedTime(attempt.at), text: `${attempt.team} ${action} (${reason})` };
}

/**
 * Newest first, at most 50 (the server already sends them that way; this
 * keeps the screen right with any other order).
 *
 * @param {unknown} blocked
 * @returns {BlockedAttempt[]}
 */
export function newestBlocked(blocked) {
  if (!Array.isArray(blocked)) {
    return [];
  }
  return [...blocked].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 50);
}

/**
 * @typedef {{ message: string, askForCode: boolean, offline: boolean }} ModeratorError
 */

/**
 * What a failed call to the moderator relays means for the screen. A 401 is
 * a wrong (or missing) code: ask again.
 *
 * @param {number} status 0 for a call that never came back
 * @param {unknown} body
 * @returns {ModeratorError}
 */
export function moderatorError(status, body) {
  const code = body && typeof body === 'object' && 'code' in body ? body.code : undefined;
  if (status === 401) {
    return { message: "That code isn't right for this session.", askForCode: true, offline: false };
  }
  if (status === 404) {
    return { message: 'No session with this id. Check the link.', askForCode: false, offline: false };
  }
  if (code === 'session_stopped') {
    return { message: 'The session has already finished.', askForCode: false, offline: false };
  }
  if (code === 'session_not_started') {
    return { message: "The session hasn't been started yet.", askForCode: false, offline: false };
  }
  if (status === 400) {
    return { message: 'The link has no valid session id.', askForCode: false, offline: false };
  }
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return { message: "No connection to the game server. Retrying…", askForCode: false, offline: true };
  }
  return { message: `Something went wrong (error ${status}).`, askForCode: false, offline: false };
}

/**
 * The server clock offset from an overview, so the countdown and "N min
 * ago" follow the server, not the moderator's device.
 *
 * @param {Overview | null} overview
 * @param {number} receivedAt
 * @returns {number}
 */
export function overviewClockOffset(overview, receivedAt) {
  return clockOffset(overview?.session?.['server-time'], receivedAt);
}

/** How often to refresh the overview while the page is visible. */
export const OVERVIEW_POLL_MS = 5000;
