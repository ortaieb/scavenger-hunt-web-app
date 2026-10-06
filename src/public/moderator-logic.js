// Pure, DOM-free logic for the moderator screen at /moderator (issue #44),
// unit-tested with Vitest like game-logic.js. It only describes what the
// game-server's overview says: the phase, the standings and the blocked
// attempts, and what its review queue says (issue #55): the photos waiting
// for a ruling and the latest rulings. It shows checkpoint numbers and
// names, never clues or locations.

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
 * @typedef {{
 *   session: SessionClock,
 *   'to-review'?: number,
 *   teams: TeamStanding[],
 *   blocked: BlockedAttempt[],
 * }} Overview
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
 * What Finish session now asks, with a warning when photos are still
 * waiting for a ruling: the results aren't final until they're decided.
 *
 * @param {number} waiting photos still in review
 * @returns {string}
 */
export function confirmFinishText(waiting) {
  if (!(waiting > 0)) {
    return CONFIRM_FINISH;
  }
  const photos = waiting === 1 ? '1 photo is' : `${waiting} photos are`;
  return `${CONFIRM_FINISH} ${photos} still in review. Results won't be final until you've decided them.`;
}

/**
 * Whether every team that joined has completed its route, while the
 * session runs (day 1's rules: the moderator is told when all the
 * challenges are complete).
 *
 * @param {Overview | null} overview
 * @returns {boolean}
 */
export function allTeamsFinished(overview) {
  if (phaseOf(overview?.session) !== 'running' || !Array.isArray(overview?.teams)) {
    return false;
  }
  const joined = overview.teams.filter((team) => team.joined === true);
  return (
    joined.length > 0 &&
    joined.every(
      (team) =>
        Number.isInteger(team.completed) &&
        Number.isInteger(team.total) &&
        team.total > 0 &&
        team.completed >= team.total,
    )
  );
}

/**
 * The banner at the top once every team has finished, '' until then.
 *
 * @param {Overview | null} overview
 * @param {number} waiting photos still in review
 * @returns {string}
 */
export function finishBanner(overview, waiting) {
  if (!allTeamsFinished(overview)) {
    return '';
  }
  return waiting > 0
    ? 'All teams have finished. Review the photos below, then finish the session.'
    : 'All teams have finished.';
}

/**
 * What the standings say about the result: final once the session has
 * finished and no photo is left in review; until then, after the finish,
 * how many reviews it's waiting for, in place of the places.
 *
 * @param {SessionClock | undefined | null} clock
 * @param {number} waiting photos still in review
 * @returns {{ final: boolean, text: string }}
 */
export function standingsNote(clock, waiting) {
  if (phaseOf(clock) !== 'stopped') {
    return { final: false, text: '' };
  }
  if (waiting > 0) {
    const reviews = waiting === 1 ? '1 review' : `${waiting} reviews`;
    return { final: false, text: `Waiting for ${reviews}. The places show once you've decided them.` };
  }
  return { final: true, text: 'Final standings: ready to announce the winners.' };
}

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

// --- the review queue (issue #55) --------------------------------------------
// The photos the referee couldn't decide, for the moderator to approve or
// reject, and the latest rulings, so a decision can be changed. The pose,
// the scene and the checks' `detail` are moderator-only: shown on this
// screen, never stored or logged.

/**
 * @typedef {{ sequence: number, name: string | null }} CheckpointRef
 * @typedef {{
 *   check: string,
 *   outcome: string,
 *   confidence?: number | null,
 *   reason?: string,
 *   detail?: string | null,
 * }} StoredCheck
 * @typedef {{
 *   submission: number,
 *   team: string,
 *   checkpoint: CheckpointRef,
 *   attempt: number,
 *   'received-at': string,
 *   pose: string | null,
 *   scene: string | null,
 *   'reference-photos': number,
 *   checks: StoredCheck[],
 *   referee: { status: string, 'error-code': string | null } | null,
 * }} ReviewItem
 * @typedef {{
 *   submission: number,
 *   team: string,
 *   checkpoint: CheckpointRef,
 *   ruling: string,
 *   note: string | null,
 *   'ruled-at': string,
 *   verdict: string,
 * }} RecentRuling
 * @typedef {{ 'to-review': ReviewItem[], recent: RecentRuling[] }} Review
 */

/** The game-server keeps a note up to this long. */
export const NOTE_MAX_LENGTH = 500;

/** At most this many reference photos per checkpoint are shown. */
const REFERENCE_PHOTOS_MAX = 10;

/**
 * @param {unknown} list
 * @returns {any[]} the entries that name a submission
 */
function submissions(list) {
  return Array.isArray(list)
    ? list.filter((entry) => entry && typeof entry === 'object' && Number.isInteger(entry.submission))
    : [];
}

/**
 * The photos waiting for a ruling, oldest first, so the longest wait comes
 * first (the server already sends them that way; this keeps the screen
 * right with any other order).
 *
 * @param {Review | null | undefined} review
 * @returns {ReviewItem[]}
 */
export function toReviewOldestFirst(review) {
  return submissions(review?.['to-review']).sort(
    (a, b) => Date.parse(a['received-at']) - Date.parse(b['received-at']) || a.submission - b.submission,
  );
}

/**
 * The latest rulings, newest first.
 *
 * @param {Review | null | undefined} review
 * @returns {RecentRuling[]}
 */
export function recentNewestFirst(review) {
  return submissions(review?.recent).sort(
    (a, b) => Date.parse(b['ruled-at']) - Date.parse(a['ruled-at']) || b.submission - a.submission,
  );
}

/**
 * How many photos are waiting for a ruling: the queue on screen when there
 * is one, else the overview's count.
 *
 * @param {Overview | null} overview
 * @param {Review | null} review
 * @returns {number}
 */
export function photosWaiting(overview, review) {
  if (Array.isArray(review?.['to-review'])) {
    return toReviewOldestFirst(review).length;
  }
  const count = overview?.['to-review'];
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * @param {number} count
 * @returns {string}
 */
export function reviewHeading(count) {
  return `To review (${count})`;
}

/**
 * "#2 Lion fountain", or "#2" for a checkpoint no longer in the sessions file.
 *
 * @param {CheckpointRef | null | undefined} checkpoint
 * @returns {string}
 */
export function checkpointLabel(checkpoint) {
  if (!checkpoint || !Number.isInteger(checkpoint.sequence)) {
    return '';
  }
  return checkpoint.name ? `#${checkpoint.sequence} ${checkpoint.name}` : `#${checkpoint.sequence}`;
}

/**
 * The head of a photo to review: the team, the checkpoint, and
 * "Attempt 1 · sent 11 min ago".
 *
 * @param {ReviewItem} item
 * @param {number} serverNow
 * @returns {{ team: string, checkpoint: string, meta: string }}
 */
export function reviewItemHead(item, serverNow) {
  const meta = [];
  if (Number.isInteger(item.attempt)) {
    meta.push(`Attempt ${item.attempt}`);
  }
  const ago = agoWords(item['received-at'], serverNow);
  if (ago) {
    meta.push(`sent ${ago}`);
  }
  return { team: item.team, checkpoint: checkpointLabel(item.checkpoint), meta: meta.join(' · ') };
}

/**
 * What the photo should show: the pose the team was asked for and the
 * checkpoint's scene.
 *
 * @param {ReviewItem} item
 * @returns {{ asked: string, place: string }}
 */
export function askedFor(item) {
  return {
    asked: typeof item.pose === 'string' && item.pose ? item.pose : 'No pose was asked for.',
    place: typeof item.scene === 'string' && item.scene ? item.scene : 'No scene is set for this checkpoint.',
  };
}

/**
 * The reference photos to fetch, by position from 0.
 *
 * @param {ReviewItem} item
 * @returns {number[]}
 */
export function referencePositions(item) {
  const count = item['reference-photos'];
  if (!Number.isInteger(count) || count <= 0) {
    return [];
  }
  return Array.from({ length: Math.min(count, REFERENCE_PHOTOS_MAX) }, (_, position) => position);
}

/** The referee's checks: their reasons are the model's. */
const VISUAL_CHECKS = new Set(['scene_matches', 'pose_correct']);

const CHECK_WORDS = {
  session_running: 'Session running',
  checked_in: 'Checked in',
  window_open: 'Checkpoint open',
  capture_fresh: 'Photo taken recently',
  capture_time_plausible: 'Capture time',
  in_range: 'Location',
  photo_unique: 'Photo not used before',
  scene_matches: 'Place',
  pose_correct: 'Pose',
};

const OUTCOME_WORDS = { passed: 'passed', failed: 'failed', uncertain: 'unsure', skipped: 'not checked' };

const REFEREE_ERROR_WORDS = {
  deadline: 'it ran out of time',
  timeout: 'it timed out',
  api_error: 'the AI service failed',
  refusal: 'the AI model refused',
  max_tokens: 'its answer was cut off',
  invalid_output: "its answer couldn't be read",
  invalid_image: "the photo couldn't be read",
};

/**
 * @typedef {{ outcome: string, text: string, detail: string }} CheckLine
 * @typedef {{ checks: CheckLine[], otherPassed: number, referee: string }} ReviewChecks
 */

/**
 * What the referee said: each of its checks with its outcome, confidence
 * and moderator-only `detail` (its reasons), and any other check that
 * didn't pass. The rest passed, and are only counted. If the referee
 * errored there are no reasons to read, so it says that instead.
 *
 * @param {ReviewItem} item
 * @returns {ReviewChecks}
 */
export function reviewChecks(item) {
  const refereeErrored = item.referee?.status === 'error';
  const checks = [];
  let otherPassed = 0;
  for (const check of Array.isArray(item.checks) ? item.checks : []) {
    const visual = VISUAL_CHECKS.has(check.check);
    if (visual && refereeErrored) {
      continue;
    }
    if (!visual && check.outcome === 'passed') {
      otherPassed += 1;
      continue;
    }
    const name = CHECK_WORDS[check.check] ?? check.check;
    const outcome = OUTCOME_WORDS[check.outcome] ?? check.outcome;
    const confidence =
      typeof check.confidence === 'number' && check.confidence > 0 && check.outcome !== 'skipped'
        ? ` (confidence ${Math.round(check.confidence * 100)}%)`
        : '';
    checks.push({
      outcome: check.outcome,
      text: `${name}: ${outcome}${confidence}`,
      detail: typeof check.detail === 'string' ? check.detail : '',
    });
  }

  let referee = '';
  if (refereeErrored) {
    const code = item.referee?.['error-code'];
    const why = (code && REFEREE_ERROR_WORDS[code]) || 'it failed';
    referee = `No reasons from the referee: ${why}${code ? ` (${code})` : ''}. Judge from the photo.`;
  }
  return { checks, otherPassed, referee };
}

/**
 * "7 other checks passed.", or '' for none.
 *
 * @param {number} count
 * @returns {string}
 */
export function otherChecksLine(count) {
  if (!(count > 0)) {
    return '';
  }
  return count === 1 ? '1 other check passed.' : `${count} other checks passed.`;
}

/**
 * The body Approve, Reject or Change posts to /moderator/ruling. The note
 * is trimmed, kept to what the game-server accepts, and left out when
 * empty.
 *
 * @param {string} session
 * @param {number} submission
 * @param {'approve' | 'reject'} ruling
 * @param {string} note
 * @returns {{ session: string, submission: number, ruling: string, note?: string }}
 */
export function rulingBody(session, submission, ruling, note) {
  const trimmed = typeof note === 'string' ? note.trim().slice(0, NOTE_MAX_LENGTH) : '';
  return trimmed ? { session, submission, ruling, note: trimmed } : { session, submission, ruling };
}

const RULING_WORDS = { approve: '✓ Approved', reject: '✗ Rejected' };

const VERDICT_WORDS = { pass: 'passed it', failed: 'failed it' };

/**
 * One line under Recently decided: "✓ Approved", then "Red Foxes · #1 Stone
 * fountain · 2 min ago", and the note if there was one. For a photo the
 * referee had passed or failed (ruled on outside this screen), what it said.
 *
 * @param {RecentRuling} recent
 * @param {number} serverNow
 * @returns {{ ruling: string, text: string, note: string }}
 */
export function recentLine(recent, serverNow) {
  const parts = [recent.team, checkpointLabel(recent.checkpoint)];
  const ago = agoWords(recent['ruled-at'], serverNow);
  if (ago) {
    parts.push(ago);
  }
  const verdict = VERDICT_WORDS[recent.verdict];
  if (verdict) {
    parts.push(`the referee ${verdict}`);
  }
  return {
    ruling: RULING_WORDS[recent.ruling] ?? recent.ruling,
    text: parts.filter(Boolean).join(' · '),
    note: typeof recent.note === 'string' && recent.note ? `Note: ${recent.note}` : '',
  };
}
