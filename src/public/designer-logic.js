// Pure, DOM-free logic for the hunt designer at /designer (issue #59),
// unit-tested with Vitest like moderator-logic.js. It checks the New design
// form against the game-server's limits, and describes what the designer
// API says: the drafts, a running draft's progress, why a draft failed, and
// a ready draft's checkpoints. Reviewing and publishing a ready draft (issue
// #60) live here too: the edit limits and the changed fields, which field a
// problem is about, the review counts and the loop over the accepted
// checkpoints, the "can publish" rule, and the publish form. So does what the
// route map (issue #61) draws: the area's box, a marker per checkpoint styled
// by its review, the loop through them, and the view that fits it all.
//
// A draft's clues, scenes and coordinates are the answers to its hunt, and
// a publication's codes are credentials: this file only shapes them for the
// screen. Nothing here stores or logs them.

import { formatCountdown } from './game-logic.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @typedef {{ area: string, theme: string, checkpoints: number, 'max-walk-km': number }} DesignRequest
 * @typedef {{ at: string, step: string, summary: string }} ProgressEntry
 * @typedef {{ lat: number, long: number }} Location
 * @typedef {{
 *   position: number,
 *   place: { osm?: string, name: string, kind?: string, location?: Location },
 *   clue: string,
 *   challenge: { scene: string, pose: string },
 *   proximity?: number,
 *   rationale?: string,
 *   review?: string,
 *   edited?: boolean,
 * }} DraftCheckpoint
 * @typedef {{ code: string, position: number | null, message: string }} DraftProblem
 * @typedef {{
 *   runner?: string,
 *   model?: string | null,
 *   turns?: number,
 *   'cost-usd'?: number,
 *   'duration-ms'?: number | null,
 *   error?: { code: string } | null,
 * }} DraftRun
 * @typedef {{ south: number, west: number, north: number, east: number }} Box
 * @typedef {{
 *   id: string,
 *   status: string,
 *   request: DesignRequest,
 *   area?: { name: string, bbox?: Box, clipped?: boolean } | null,
 *   progress?: ProgressEntry[],
 *   checkpoints?: DraftCheckpoint[],
 *   route?: { 'legs-m': number[], 'loop-m': number } | null,
 *   problems?: DraftProblem[],
 *   run?: DraftRun,
 *   attribution?: string,
 *   published?: { session: string, at: string } | null,
 *   'created-at': string,
 *   'finished-at'?: string | null,
 * }} Draft
 * @typedef {{
 *   id: string,
 *   status: string,
 *   area: string,
 *   theme: string,
 *   'created-at': string,
 *   'finished-at'?: string | null,
 *   checkpoints?: number,
 *   'cost-usd'?: number,
 * }} DraftListItem
 */

/**
 * @param {unknown} value
 * @returns {value is string} whether it's a draft id (a UUID)
 */
export function isDraftId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * The open draft's id from the link, /designer?draft=<uuid>: the only
 * thing from a draft that goes in the URL.
 *
 * @param {URLSearchParams} searchParams
 * @returns {string | null}
 */
export function readDraftId(searchParams) {
  const draft = searchParams.get('draft');
  return isDraftId(draft) ? draft : null;
}

// --- New design ----------------------------------------------------------------

/** The game-server's limits for a design request. */
export const LIMITS = Object.freeze({
  text: { min: 3, max: 200 },
  checkpoints: { min: 3, max: 8, default: 3 },
  maxWalkKm: { min: 0.5, max: 10, default: 3 },
});

/**
 * The New design form, as typed.
 *
 * @typedef {{ area: string, theme: string, checkpoints: string, maxWalkKm: string }} DesignForm
 * @typedef {Partial<Record<keyof DesignForm, string>>} FormErrors
 */

/**
 * @param {string} value
 * @param {string} what
 * @returns {string} the error, or ''
 */
function textError(value, what) {
  const { min, max } = LIMITS.text;
  if (value.length < min) {
    return `Enter the ${what}: at least ${min} characters.`;
  }
  if (value.length > max) {
    return `Keep the ${what} to ${max} characters or fewer.`;
  }
  return '';
}

/**
 * @param {string} value
 * @returns {number} NaN unless it's a plain decimal number
 */
function parseNumber(value) {
  const trimmed = value.trim();
  return /^\d+(\.\d+)?$|^\.\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

/**
 * Checks the New design form against the game-server's limits, so a bad
 * value is caught in the page. Area and theme are trimmed, as the
 * game-server trims them.
 *
 * @param {DesignForm} form
 * @returns {{ request: DesignRequest | null, errors: FormErrors }} `request`
 *   is what to post, or null when `errors` has anything in it
 */
export function validateDesign(form) {
  const area = String(form.area ?? '').trim();
  const theme = String(form.theme ?? '').trim();
  const checkpoints = parseNumber(String(form.checkpoints ?? ''));
  const maxWalkKm = parseNumber(String(form.maxWalkKm ?? ''));

  /** @type {FormErrors} */
  const errors = {};
  const areaError = textError(area, 'area');
  if (areaError) {
    errors.area = areaError;
  }
  const themeError = textError(theme, 'theme');
  if (themeError) {
    errors.theme = themeError;
  }
  const c = LIMITS.checkpoints;
  if (!Number.isInteger(checkpoints) || checkpoints < c.min || checkpoints > c.max) {
    errors.checkpoints = `Choose a whole number of checkpoints from ${c.min} to ${c.max}.`;
  }
  const w = LIMITS.maxWalkKm;
  if (!Number.isFinite(maxWalkKm) || maxWalkKm < w.min || maxWalkKm > w.max) {
    errors.maxWalkKm = `Choose a walk from ${w.min} to ${w.max} km.`;
  }

  if (Object.keys(errors).length > 0) {
    return { request: null, errors };
  }
  return { request: { area, theme, checkpoints, 'max-walk-km': maxWalkKm }, errors };
}

/**
 * The form for Try again: a failed draft's request, with the defaults for
 * anything missing.
 *
 * @param {Partial<DesignRequest> | null | undefined} request
 * @returns {DesignForm}
 */
export function formFromRequest(request) {
  const checkpoints = request?.checkpoints;
  const maxWalkKm = request?.['max-walk-km'];
  return {
    area: typeof request?.area === 'string' ? request.area : '',
    theme: typeof request?.theme === 'string' ? request.theme : '',
    checkpoints: String(typeof checkpoints === 'number' ? checkpoints : LIMITS.checkpoints.default),
    maxWalkKm: String(typeof maxWalkKm === 'number' ? maxWalkKm : LIMITS.maxWalkKm.default),
  };
}

/**
 * "3 checkpoints, up to 3 km".
 *
 * @param {Partial<DesignRequest> | null | undefined} request
 * @returns {string}
 */
export function requestLine(request) {
  const parts = [];
  if (typeof request?.checkpoints === 'number') {
    parts.push(`${request.checkpoints} checkpoints`);
  }
  if (typeof request?.['max-walk-km'] === 'number') {
    parts.push(`up to ${request['max-walk-km']} km`);
  }
  return parts.join(', ');
}

// --- statuses, the drafts list -----------------------------------------------

const STATUS_WORDS = {
  running: 'Designing…',
  ready: 'Ready',
  failed: 'Failed',
  published: 'Published',
};

/**
 * @param {unknown} status
 * @returns {string}
 */
export function statusLabel(status) {
  return (typeof status === 'string' && STATUS_WORDS[status]) || String(status ?? 'Unknown');
}

/**
 * While a draft is `running`, the page keeps polling it; `ready` and
 * `failed` (and `published`) are final.
 *
 * @param {Draft | null | undefined} draft
 * @returns {boolean}
 */
export function isRunning(draft) {
  return draft?.status === 'running';
}

/** How often to poll a running draft while the page is visible. */
export const DRAFT_POLL_MS = 2000;

/** How often to refresh the drafts list while it shows a running draft. */
export const LIST_POLL_MS = 5000;

/**
 * The drafts, newest first (the server already sends them that way; this
 * keeps the screen right with any other order).
 *
 * @param {unknown} body the GET /designer/drafts response
 * @returns {DraftListItem[]}
 */
export function newestFirst(body) {
  const drafts = body && typeof body === 'object' && 'drafts' in body ? body.drafts : null;
  if (!Array.isArray(drafts)) {
    return [];
  }
  return drafts
    .filter((draft) => draft && typeof draft === 'object' && isDraftId(draft.id))
    .sort((a, b) => (Date.parse(b['created-at']) || 0) - (Date.parse(a['created-at']) || 0));
}

/**
 * The draft that's running, to link to when another design can't start.
 *
 * @param {DraftListItem[]} drafts
 * @returns {string | null}
 */
export function runningDraftId(drafts) {
  return drafts.find((draft) => draft.status === 'running')?.id ?? null;
}

/**
 * "$0.42". The cost is only known once the run has finished.
 *
 * @param {unknown} costUsd
 * @returns {string}
 */
export function costWords(costUsd) {
  return typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0 ? `$${costUsd.toFixed(2)}` : '';
}

/**
 * When a draft was started, in the organiser's own time: "9 Oct, 10:03".
 *
 * @param {unknown} isoTime
 * @returns {string}
 */
export function whenWords(isoTime) {
  const time = typeof isoTime === 'string' ? Date.parse(isoTime) : NaN;
  if (!Number.isFinite(time)) {
    return '';
  }
  const date = new Date(time);
  const day = date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${clock}`;
}

/**
 * One row of the drafts list: its status, area, theme, when it was
 * started, and its cost once it's finished.
 *
 * @param {DraftListItem} draft
 * @returns {{ status: string, area: string, theme: string, when: string, cost: string }}
 */
export function draftListLine(draft) {
  return {
    status: statusLabel(draft.status),
    area: typeof draft.area === 'string' ? draft.area : '',
    theme: typeof draft.theme === 'string' ? draft.theme : '',
    when: whenWords(draft['created-at']),
    cost: draft.status === 'running' ? '' : costWords(draft['cost-usd']),
  };
}

// --- a running draft -----------------------------------------------------------

/**
 * Friendly names for the run's steps: the agent's tools, and the stub
 * runner's own steps.
 */
export const STEP_LABELS = Object.freeze({
  find_area: 'Finding the area',
  resolve_area: 'Finding the area',
  find_places: 'Looking for places',
  place_details: 'Reading about a place',
  measure_route: 'Measuring the route',
  write_clues: 'Writing clues and challenges',
  submit_draft: 'Checking the draft',
  check_draft: 'Checking the draft',
});

/**
 * A step's friendly name, or its raw name for a step this page doesn't know.
 *
 * @param {unknown} step
 * @returns {string}
 */
export function stepLabel(step) {
  if (typeof step !== 'string' || !step) {
    return 'A step';
  }
  return Object.hasOwn(STEP_LABELS, step) ? STEP_LABELS[step] : step;
}

/**
 * The run's steps so far, oldest first, e.g. "Looking for places: 58
 * candidate places", each with how far into the run it came ("0:12").
 *
 * @param {Draft | null | undefined} draft
 * @returns {{ at: string, text: string }[]}
 */
export function progressLines(draft) {
  const steps = Array.isArray(draft?.progress) ? draft.progress : [];
  const start = Date.parse(draft?.['created-at'] ?? '');
  return steps
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const label = stepLabel(entry.step);
      const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
      const at = Date.parse(entry.at);
      return {
        at: Number.isFinite(start) && Number.isFinite(at) ? formatCountdown(at - start) : '',
        text: summary ? `${label}: ${summary}` : label,
      };
    });
}

/**
 * How long a running draft has been going, by server time: "Running for
 * 1:23".
 *
 * @param {Draft | null | undefined} draft
 * @param {number} serverNow ms since the epoch, in server time
 * @returns {string}
 */
export function elapsedLine(draft, serverNow) {
  const start = Date.parse(draft?.['created-at'] ?? '');
  return Number.isFinite(start) && Number.isFinite(serverNow)
    ? `Running for ${formatCountdown(serverNow - start)}`
    : 'Running';
}

/**
 * How long a finished draft's run took, its turns and what it cost: "Took
 * 3:41 · 23 turns · cost $0.42". The stub runner takes no turns, so none are
 * shown for it. '' while it's running.
 *
 * @param {Draft | null | undefined} draft
 * @returns {string}
 */
export function runLine(draft) {
  if (!draft || isRunning(draft)) {
    return '';
  }
  const parts = [];
  const durationMs = draft.run?.['duration-ms'];
  const start = Date.parse(draft['created-at'] ?? '');
  const end = Date.parse(draft['finished-at'] ?? '');
  if (typeof durationMs === 'number' && durationMs >= 0) {
    parts.push(`Took ${formatCountdown(durationMs)}`);
  } else if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    parts.push(`Took ${formatCountdown(end - start)}`);
  }
  const turns = draft.run?.turns;
  if (typeof turns === 'number' && Number.isInteger(turns) && turns > 0) {
    parts.push(turns === 1 ? '1 turn' : `${turns} turns`);
  }
  const cost = costWords(draft.run?.['cost-usd']);
  if (cost) {
    parts.push(`cost ${cost}`);
  }
  return parts.join(' · ');
}

// --- a failed draft ------------------------------------------------------------

/** What each `run.error.code` means, for the organiser. */
export const FAILURE_TEXT = Object.freeze({
  max_turns: 'The designer ran out of steps.',
  max_budget: 'It reached its spending limit.',
  deadline: 'It took too long.',
  no_valid_draft: "It couldn't produce a hunt that meets the rules.",
  agent_unavailable: "The designer couldn't start.",
  interrupted: 'The server restarted during the run.',
});

/**
 * Why a draft failed, in plain words.
 *
 * @param {Draft | null | undefined} draft
 * @returns {string}
 */
export function failureText(draft) {
  const code = draft?.run?.error?.code;
  if (typeof code === 'string' && Object.hasOwn(FAILURE_TEXT, code)) {
    return FAILURE_TEXT[code];
  }
  return typeof code === 'string' && code ? `The design failed (${code}).` : 'The design failed.';
}

/**
 * The problems from the run's last attempt: "Checkpoint 2: …", or the
 * message alone for one about the whole draft.
 *
 * @param {Draft | null | undefined} draft
 * @returns {string[]}
 */
export function problemLines(draft) {
  return linesOf(draft?.problems);
}

/**
 * @param {unknown} problem
 * @returns {string} the problem's message, or its code when it has none
 */
function messageOf(problem) {
  if (!problem || typeof problem !== 'object') {
    return '';
  }
  const { message, code } = /** @type {Partial<DraftProblem>} */ (problem);
  return typeof message === 'string' && message ? message : typeof code === 'string' ? code : '';
}

/**
 * @param {unknown} problems
 * @returns {string[]} "Checkpoint 2: …" for each problem, or its message alone
 */
function linesOf(problems) {
  return (Array.isArray(problems) ? problems : [])
    .map((problem) => {
      const message = messageOf(problem);
      return message && Number.isInteger(problem.position) ? `Checkpoint ${problem.position}: ${message}` : message;
    })
    .filter(Boolean);
}

// --- a ready draft -------------------------------------------------------------

/**
 * @param {Draft | null | undefined} draft
 * @returns {DraftCheckpoint[]} the draft's checkpoints in route order
 */
function inRouteOrder(draft) {
  const checkpoints = Array.isArray(draft?.checkpoints) ? draft.checkpoints : [];
  return checkpoints
    .filter((checkpoint) => checkpoint && typeof checkpoint === 'object' && Number.isInteger(checkpoint.position))
    .sort((a, b) => a.position - b.position);
}

/**
 * A published draft's hunt, read-only: its accepted checkpoints, numbered
 * 1…n in route order as the session numbers them, with the place's name,
 * the clue and the pose.
 *
 * @param {Draft | null | undefined} draft
 * @returns {{ position: number, name: string, clue: string, pose: string }[]}
 */
export function publishedRows(draft) {
  return inRouteOrder(draft)
    .filter((checkpoint) => checkpoint.review === 'accepted')
    .map((checkpoint, index) => ({ ...rowOf(checkpoint), position: index + 1 }));
}

/** @param {DraftCheckpoint} checkpoint */
function rowOf(checkpoint) {
  return {
    position: checkpoint.position,
    name: textOf(checkpoint.place?.name),
    clue: textOf(checkpoint.clue),
    pose: textOf(checkpoint.challenge?.pose),
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * What a finished draft found, for its header: the area's name ("(clipped)"
 * when it was cut down to a walkable size) and the loop's length, e.g.
 * "Chiswick, London, England · loop 1.41 km".
 *
 * @param {Draft | null | undefined} draft
 * @returns {string}
 */
export function draftFacts(draft) {
  const parts = [];
  const name = draft?.area?.name;
  if (typeof name === 'string' && name) {
    parts.push(draft?.area?.clipped ? `${name} (clipped)` : name);
  }
  const loop = draft?.route?.['loop-m'];
  if (typeof loop === 'number' && Number.isFinite(loop) && loop > 0) {
    parts.push(`loop ${distanceWords(loop)}`);
  }
  return parts.join(' · ');
}

// --- reviewing a checkpoint ------------------------------------------------------

/**
 * The game-server's limits for a checkpoint's text, in characters, and for
 * its check-in radius, in metres: what an edit is held to.
 */
export const CHECKPOINT_LIMITS = Object.freeze({
  clue: { min: 1, max: 300 },
  pose: { min: 1, max: 200 },
  scene: { min: 1, max: 1000 },
  proximity: { min: 20, max: 100 },
});

/** A checkpoint's text fields, in the order a card shows them. */
export const TEXT_FIELDS = Object.freeze(/** @type {const} */ (['clue', 'pose', 'scene']));

/**
 * @typedef {'clue' | 'pose' | 'scene'} TextField
 * @typedef {TextField | 'proximity'} EditField
 * @typedef {Record<EditField, string>} CheckpointForm a card's fields, as typed
 * @typedef {Partial<{ clue: string, pose: string, scene: string, proximity: number }>} CheckpointEdit
 */

/**
 * A text's length as the game-server counts it, in characters (code
 * points) rather than UTF-16 units, so an emoji counts once.
 *
 * @param {unknown} text
 * @returns {number}
 */
export function charCount(text) {
  return [...String(text ?? '')].length;
}

/**
 * The counter under a text field: "123 / 300", and whether it's over.
 *
 * @param {TextField} field
 * @param {string} value
 * @returns {{ text: string, over: boolean }}
 */
export function counter(field, value) {
  const { max } = CHECKPOINT_LIMITS[field];
  const count = charCount(value);
  return { text: `${count} / ${max}`, over: count > max };
}

/**
 * @param {unknown} value
 * @returns {number} NaN unless it's a plain whole number
 */
function parseWhole(value) {
  const trimmed = String(value ?? '').trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

/**
 * What's wrong with a field, checked in the page against the game-server's
 * limits: '' when it's fine. The game-server checks the rest (a clue or
 * pose that names the place) when it's saved.
 *
 * @param {EditField} field
 * @param {string} value as typed
 * @returns {string}
 */
export function fieldError(field, value) {
  if (field === 'proximity') {
    const { min, max } = CHECKPOINT_LIMITS.proximity;
    const radius = parseWhole(value);
    return radius >= min && radius <= max ? '' : `Choose a whole number of metres from ${min} to ${max}.`;
  }
  const { max } = CHECKPOINT_LIMITS[field];
  const text = String(value ?? '');
  if (text.trim() === '') {
    return `The ${field} can't be empty.`;
  }
  return charCount(text) > max ? `Keep the ${field} to ${max} characters or fewer.` : '';
}

/**
 * A checkpoint as saved, in the shape of a card's fields.
 *
 * @param {DraftCheckpoint | null | undefined} checkpoint
 * @returns {CheckpointForm}
 */
export function formFromCheckpoint(checkpoint) {
  return {
    clue: textOf(checkpoint?.clue),
    pose: textOf(checkpoint?.challenge?.pose),
    scene: textOf(checkpoint?.challenge?.scene),
    proximity: typeof checkpoint?.proximity === 'number' ? String(checkpoint.proximity) : '',
  };
}

/**
 * What Save sends: only the fields that differ from the checkpoint as saved.
 * The radius goes as a number (NaN when it isn't a whole number, which
 * validateEdit catches).
 *
 * @param {DraftCheckpoint | null | undefined} checkpoint
 * @param {CheckpointForm} form
 * @returns {CheckpointEdit}
 */
export function changedFields(checkpoint, form) {
  const saved = formFromCheckpoint(checkpoint);
  /** @type {CheckpointEdit} */
  const changes = {};
  for (const field of TEXT_FIELDS) {
    if (form[field] !== saved[field]) {
      changes[field] = form[field];
    }
  }
  const radius = parseWhole(form.proximity);
  if (radius !== checkpoint?.proximity && !(saved.proximity === '' && String(form.proximity).trim() === '')) {
    changes.proximity = radius;
  }
  return changes;
}

/**
 * Save, checked in the page: the changed fields, and what's wrong with any
 * of them.
 *
 * @param {DraftCheckpoint | null | undefined} checkpoint
 * @param {CheckpointForm} form
 * @returns {{ changes: CheckpointEdit, errors: Partial<Record<EditField, string>> }}
 */
export function validateEdit(checkpoint, form) {
  const changes = changedFields(checkpoint, form);
  /** @type {Partial<Record<EditField, string>>} */
  const errors = {};
  for (const field of /** @type {EditField[]} */ (Object.keys(changes))) {
    const message = fieldError(field, form[field]);
    if (message) {
      errors[field] = message;
    }
  }
  return { changes, errors };
}

/**
 * Which field a problem from the game-server is about, so it's shown under
 * that field: `bad_proximity` under the radius; `names_place` (the clue or
 * the pose), `empty` and `too_long` under the field their message names.
 * null for a problem about the whole checkpoint or draft.
 *
 * @param {unknown} problem
 * @returns {EditField | null}
 */
export function problemField(problem) {
  const code = problem && typeof problem === 'object' && 'code' in problem ? problem.code : undefined;
  if (code === 'bad_proximity') {
    return 'proximity';
  }
  if (code !== 'names_place' && code !== 'empty' && code !== 'too_long') {
    return null;
  }
  // "Checkpoint 2's clue gives the place away (…)", "Checkpoint 2's scene
  // is 1200 characters; …": the field comes before anything quoted.
  const message = messageOf(problem);
  const match = /'s (clue|pose|scene)\b/.exec(message) ?? /\b(clue|pose|scene)\b/.exec(message);
  return match ? /** @type {TextField} */ (match[1]) : null;
}

/**
 * A 422's problems for one card, by the field each is shown under, and
 * `card` for the rest.
 *
 * @param {unknown} problems
 * @returns {Record<EditField | 'card', string[]>}
 */
export function problemsByField(problems) {
  /** @type {Record<EditField | 'card', string[]>} */
  const byField = { clue: [], pose: [], scene: [], proximity: [], card: [] };
  for (const problem of Array.isArray(problems) ? problems : []) {
    const message = messageOf(problem);
    if (message) {
      byField[problemField(problem) ?? 'card'].push(message);
    }
  }
  return byField;
}

/** The organiser's review of a checkpoint, in words. */
export const REVIEW_WORDS = Object.freeze({
  pending: 'To review',
  accepted: 'Accepted',
  rejected: 'Rejected',
});

/**
 * @param {DraftCheckpoint | null | undefined} checkpoint
 * @returns {'pending' | 'accepted' | 'rejected'}
 */
export function reviewOf(checkpoint) {
  const review = checkpoint?.review;
  return review === 'accepted' || review === 'rejected' ? review : 'pending';
}

/**
 * @param {string} osm a place's OpenStreetMap id, e.g. "node/123"
 * @returns {string | null} its page on openstreetmap.org
 */
export function osmUrl(osm) {
  const match = /^(node|way|relation)\/(\d+)$/.exec(typeof osm === 'string' ? osm : '');
  return match ? `https://www.openstreetmap.org/${match[1]}/${match[2]}` : null;
}

/**
 * A place's kind in words: "historic=memorial" is "historic · memorial".
 *
 * @param {unknown} kind
 * @returns {string}
 */
export function kindWords(kind) {
  return typeof kind === 'string' ? kind.replace('=', ' · ').replaceAll('_', ' ') : '';
}

/**
 * A ready draft's checkpoints as review cards, in route order: the place,
 * why the agent chose it, its link on OpenStreetMap, its review, whether
 * its text was edited, and its fields as saved.
 *
 * @param {Draft | null | undefined} draft
 * @returns {{
 *   position: number,
 *   name: string,
 *   kind: string,
 *   rationale: string,
 *   osmUrl: string | null,
 *   review: 'pending' | 'accepted' | 'rejected',
 *   edited: boolean,
 *   form: CheckpointForm,
 * }[]}
 */
export function reviewCards(draft) {
  return inRouteOrder(draft).map((checkpoint) => ({
    position: checkpoint.position,
    name: textOf(checkpoint.place?.name),
    kind: kindWords(checkpoint.place?.kind),
    rationale: textOf(checkpoint.rationale),
    osmUrl: osmUrl(textOf(checkpoint.place?.osm)),
    review: reviewOf(checkpoint),
    edited: checkpoint.edited === true,
    form: formFromCheckpoint(checkpoint),
  }));
}

// --- the summary bar -------------------------------------------------------------

/**
 * @param {unknown} checkpoints
 * @returns {{ accepted: number, rejected: number, pending: number }}
 */
export function reviewCounts(checkpoints) {
  const counts = { accepted: 0, rejected: 0, pending: 0 };
  for (const checkpoint of Array.isArray(checkpoints) ? checkpoints : []) {
    if (checkpoint && typeof checkpoint === 'object') {
      counts[reviewOf(checkpoint)] += 1;
    }
  }
  return counts;
}

// The game-server's Earth radius (IUGG mean), so the page's loop matches its.
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * @param {unknown} location
 * @returns {location is Location}
 */
function isLocation(location) {
  return (
    Boolean(location) &&
    typeof location === 'object' &&
    Number.isFinite(/** @type {Location} */ (location).lat) &&
    Number.isFinite(/** @type {Location} */ (location).long)
  );
}

/**
 * The great-circle distance from a to b, in metres, by the haversine formula
 * as the game-server works it out.
 *
 * @param {Location} a
 * @param {Location} b
 * @returns {number}
 */
export function distanceM(a, b) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latA = radians(a.lat);
  const latB = radians(b.lat);
  const dLat = latB - latA;
  const dLong = radians(b.long - a.long);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLong / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A closed loop's length, in metres: each place to the next, and the last
 * back to the first, as every team walks a rotation of it.
 *
 * @param {Location[]} locations in route order
 * @returns {number}
 */
export function loopM(locations) {
  if (locations.length < 2) {
    return 0;
  }
  return locations.reduce((total, location, index) => total + distanceM(location, locations[(index + 1) % locations.length]), 0);
}

/**
 * The loop over the accepted checkpoints only, in route order, as the hunt
 * would be published: null with fewer than 2 to make one.
 *
 * @param {Draft | null | undefined} draft
 * @returns {number | null}
 */
export function acceptedLoopM(draft) {
  const locations = inRouteOrder(draft)
    .filter((checkpoint) => checkpoint.review === 'accepted')
    .map((checkpoint) => checkpoint.place?.location)
    .filter(isLocation);
  return locations.length < 2 ? null : loopM(locations);
}

/**
 * "850 m", or "1.41 km" from 1 km up.
 *
 * @param {number} metres
 * @returns {string}
 */
export function distanceWords(metres) {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
}

/**
 * The summary bar: the review counts, and the loop over the accepted
 * checkpoints against the longest walk asked for. A ready draft's whole
 * loop is within that walk, and leaving checkpoints out only shortens it.
 *
 * @param {Draft | null | undefined} draft
 * @returns {{ accepted: number, rejected: number, pending: number, loop: string }}
 */
export function reviewSummary(draft) {
  const loop = acceptedLoopM(draft);
  const maxWalkKm = draft?.request?.['max-walk-km'];
  const limit = typeof maxWalkKm === 'number' ? ` (up to ${maxWalkKm} km)` : '';
  return {
    ...reviewCounts(draft?.checkpoints),
    loop: loop === null ? 'Accept checkpoints to see the loop' : `Loop of the accepted: ${distanceWords(loop)}${limit}`,
  };
}

// --- the route map -------------------------------------------------------------------

/**
 * How a checkpoint's marker looks for each review: the words in its title,
 * its class, and whether the loop goes through it. A rejected one is faded
 * and left out of the loop. The words carry the meaning; the colour only
 * repeats it.
 */
export const MARKER_STYLES = Object.freeze({
  pending: Object.freeze({ words: REVIEW_WORDS.pending, className: 'route-marker route-marker--pending', inLoop: true }),
  accepted: Object.freeze({ words: REVIEW_WORDS.accepted, className: 'route-marker route-marker--accepted', inLoop: true }),
  rejected: Object.freeze({ words: REVIEW_WORDS.rejected, className: 'route-marker route-marker--rejected', inLoop: false }),
});

/**
 * @param {unknown} review a checkpoint's review; anything else is pending
 * @returns {{ words: string, className: string, inLoop: boolean }}
 */
export function markerStyle(review) {
  return MARKER_STYLES[review === 'accepted' || review === 'rejected' ? review : 'pending'];
}

/**
 * The area the draft was designed in, when it has a usable box.
 *
 * @param {Draft | null | undefined} draft
 * @returns {Box | null}
 */
export function areaBox(draft) {
  const box = draft?.area?.bbox;
  if (!box || typeof box !== 'object') {
    return null;
  }
  const { south, west, north, east } = box;
  return [south, west, north, east].every(Number.isFinite) && south <= north && west <= east
    ? { south, west, north, east }
    : null;
}

/**
 * The view that fits the area's box and every place, as Leaflet takes it:
 * [[south, west], [north, east]]. null with nothing to fit.
 *
 * @param {Box | null} box
 * @param {Location[]} points
 * @returns {[[number, number], [number, number]] | null}
 */
export function mapBounds(box, points) {
  const lats = box ? [box.south, box.north] : [];
  const longs = box ? [box.west, box.east] : [];
  for (const point of points) {
    if (isLocation(point)) {
      lats.push(point.lat);
      longs.push(point.long);
    }
  }
  if (lats.length === 0) {
    return null;
  }
  return [
    [Math.min(...lats), Math.min(...longs)],
    [Math.max(...lats), Math.max(...longs)],
  ];
}

/**
 * The line on the map: [lat, long] in route order and back to the first,
 * through every place but the rejected ones, as the server measures the loop
 * (straight lines, not streets). [] with fewer than 2 to join.
 *
 * @param {{ lat: number, long: number, review: string }[]} markers in route order
 * @returns {[number, number][]}
 */
export function loopLatLngs(markers) {
  /** @type {[number, number][]} */
  const points = markers.filter((marker) => markerStyle(marker.review).inLoop).map((marker) => [marker.lat, marker.long]);
  return points.length < 2 ? [] : [...points, points[0]];
}

/**
 * @typedef {{
 *   position: number,
 *   name: string,
 *   review: 'pending' | 'accepted' | 'rejected',
 *   title: string,
 *   className: string,
 *   lat: number,
 *   long: number,
 * }} RouteMarker `position` is the number on the marker, and on the card or
 *   row it stands for
 */

/**
 * What the route map draws for a finished draft: the area's box, a marker for
 * each checkpoint with a place, the loop, and the view that fits them. A
 * ready draft's markers are numbered as its cards are and styled by their
 * review; a published draft's are its accepted checkpoints, numbered 1…n as
 * the session numbers them. null for a draft that isn't finished.
 *
 * @param {Draft | null | undefined} draft
 * @returns {{
 *   box: Box | null,
 *   markers: RouteMarker[],
 *   loop: [number, number][],
 *   bounds: [[number, number], [number, number]] | null,
 * } | null}
 */
export function routeMap(draft) {
  const status = draft?.status;
  if (status !== 'ready' && status !== 'published') {
    return null;
  }
  const published = status === 'published';
  const checkpoints = inRouteOrder(draft);
  /** @type {RouteMarker[]} */
  const markers = (published ? checkpoints.filter((checkpoint) => checkpoint.review === 'accepted') : checkpoints).flatMap(
    (checkpoint, index) => {
      const location = checkpoint.place?.location;
      if (!isLocation(location)) {
        return [];
      }
      const position = published ? index + 1 : checkpoint.position;
      const name = textOf(checkpoint.place?.name);
      const review = reviewOf(checkpoint);
      const style = markerStyle(review);
      return [
        {
          position,
          name,
          review,
          title: published ? `${position}. ${name}` : `${position}. ${name}: ${style.words}`,
          className: style.className,
          lat: location.lat,
          long: location.long,
        },
      ];
    },
  );
  const box = areaBox(draft);
  return { box, markers, loop: loopLatLngs(markers), bounds: mapBounds(box, markers) };
}

// --- publishing ---------------------------------------------------------------------

/** The game-server publishes a hunt of at least this many accepted checkpoints. */
export const MIN_ACCEPTED = 3;

/**
 * @param {number} count
 * @param {string} one
 * @returns {string} "1 checkpoint", "2 checkpoints"
 */
function plural(count, one) {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/**
 * Whether Publish hunt is enabled, and if not, what's missing: nothing
 * still to review, and at least 3 checkpoints accepted. `unsaved` are the
 * cards with changes not yet saved, which would be lost.
 *
 * @param {Draft | null | undefined} draft
 * @param {number[]} [unsaved] the positions of cards with unsaved changes
 * @returns {{ ok: boolean, message: string }}
 */
export function publishReadiness(draft, unsaved = []) {
  if (draft?.status === 'published') {
    return { ok: false, message: 'This draft is already published.' };
  }
  if (draft?.status !== 'ready') {
    return { ok: false, message: 'Only a ready draft can be published.' };
  }
  const { accepted, pending } = reviewCounts(draft.checkpoints);
  const missing = [];
  if (pending > 0) {
    missing.push(`Accept or reject every checkpoint: ${plural(pending, 'checkpoint')} still to review.`);
  }
  if (accepted < MIN_ACCEPTED) {
    missing.push(
      pending > 0
        ? `At least ${MIN_ACCEPTED} must be accepted (${accepted} so far).`
        : `At least ${MIN_ACCEPTED} must be accepted, and ${accepted} ${accepted === 1 ? 'is' : 'are'}: undo a rejection to accept it.`,
    );
  }
  if (unsaved.length > 0) {
    const which = [...unsaved].sort((a, b) => a - b).join(', ');
    missing.push(`Save your changes to checkpoint ${which} first.`);
  }
  return { ok: missing.length === 0, message: missing.join(' ') };
}

/** The game-server's limits for the publish form. */
export const PUBLISH_LIMITS = Object.freeze({
  name: { min: 1, max: 100 },
  teams: { min: 1, max: 10 },
  teamName: { min: 1, max: 40 },
});

/**
 * @param {number} value
 * @param {number} [width]
 * @returns {string}
 */
function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/**
 * A `datetime-local` value ("2026-10-11T10:00") as ISO 8601 with a UTC
 * offset ("2026-10-11T10:00:00+01:00"), as the game-server needs. The
 * offset is the browser's own on that date, so summer time is right.
 *
 * @param {string} value
 * @param {number} [offsetMinutes] minutes ahead of UTC, instead of the browser's
 * @returns {string | null} null unless it's a real date and time
 */
export function localToIso(value, offsetMinutes) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(String(value ?? '').trim());
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const offset = offsetMinutes ?? -new Date(year, month - 1, day, hour, minute, second).getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * The team names, checked as the game-server checks them: 1 to 10 names, each
 * 1 to 40 characters once trimmed, and no two the same ignoring case.
 *
 * @param {string[]} names one per row, as typed
 * @returns {{ teams: string[] | null, rows: string[], error: string }} `teams`
 *   trimmed, or null when anything is wrong; `rows` each row's error ('' when
 *   it's fine); `error` about the list as a whole
 */
export function validateTeams(names) {
  const list = (Array.isArray(names) ? names : []).map((name) => String(name ?? '').trim());
  const { teams: count, teamName } = PUBLISH_LIMITS;
  /** @type {Map<string, number>} */
  const seen = new Map();
  const rows = list.map((name, index) => {
    if (charCount(name) < teamName.min) {
      return 'Enter a team name, or remove this row.';
    }
    if (charCount(name) > teamName.max) {
      return `Keep the name to ${teamName.max} characters or fewer.`;
    }
    const key = name.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      return `Team ${first + 1} has the same name. Each team needs its own, whatever the capitals.`;
    }
    seen.set(key, index);
    return '';
  });
  let error = '';
  if (list.length < count.min) {
    error = 'Add at least one team.';
  } else if (list.length > count.max) {
    error = `Keep it to ${count.max} teams or fewer.`;
  }
  return { teams: error || rows.some(Boolean) ? null : list, rows, error };
}

/**
 * The publish form, as typed.
 *
 * @typedef {{ name: string, start: string, end: string, teams: string[] }} PublishForm
 * @typedef {{ name: string, 'start-time': string, 'end-time': string, teams: string[] }} PublishRequest
 * @typedef {Partial<Record<'name' | 'start' | 'end' | 'teams', string>>} PublishErrors
 */

/**
 * Checks the publish form against the game-server's rules, so a bad value is
 * caught in the page.
 *
 * @param {PublishForm} form
 * @param {number} [offsetMinutes] minutes ahead of UTC, instead of the browser's
 * @returns {{ request: PublishRequest | null, errors: PublishErrors, teamRows: string[] }}
 *   `request` is what to post, or null when anything is wrong
 */
export function validatePublish(form, offsetMinutes) {
  const name = String(form.name ?? '').trim();
  const start = localToIso(form.start, offsetMinutes);
  const end = localToIso(form.end, offsetMinutes);
  const teams = validateTeams(form.teams);

  /** @type {PublishErrors} */
  const errors = {};
  if (charCount(name) < PUBLISH_LIMITS.name.min) {
    errors.name = "Enter the hunt's name.";
  } else if (charCount(name) > PUBLISH_LIMITS.name.max) {
    errors.name = `Keep the name to ${PUBLISH_LIMITS.name.max} characters or fewer.`;
  }
  if (start === null) {
    errors.start = 'Choose when it starts.';
  }
  if (end === null) {
    errors.end = 'Choose when it ends.';
  } else if (start !== null && Date.parse(end) <= Date.parse(start)) {
    errors.end = 'It must end after it starts.';
  }
  if (teams.error) {
    errors.teams = teams.error;
  }

  if (Object.keys(errors).length > 0 || teams.teams === null || start === null || end === null) {
    return { request: null, errors, teamRows: teams.rows };
  }
  return { request: { name, 'start-time': start, 'end-time': end, teams: teams.teams }, errors, teamRows: teams.rows };
}

/**
 * A publication, checked and shaped for the screen: the session, the
 * moderator's link and code, and each team's join code. null when the body
 * isn't one.
 *
 * @param {unknown} body the publish response, or GET …/publication
 * @returns {{
 *   session: string,
 *   name: string,
 *   moderatorPath: string,
 *   moderatorCode: string,
 *   teams: { name: string, code: string }[],
 * } | null}
 */
export function publicationView(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const { session, name, teams } = /** @type {Record<string, unknown>} */ (body);
  if (typeof session !== 'string' || !UUID_RE.test(session)) {
    return null;
  }
  return {
    session,
    name: textOf(name),
    moderatorPath: `/moderator?${new URLSearchParams({ session })}`,
    moderatorCode: textOf(/** @type {Record<string, unknown>} */ (body)['moderator-code']),
    teams: (Array.isArray(teams) ? teams : [])
      .filter((team) => team && typeof team === 'object' && typeof team.name === 'string' && typeof team['join-code'] === 'string')
      .map((team) => ({ name: team.name, code: team['join-code'] })),
  };
}

// --- errors --------------------------------------------------------------------

/**
 * @typedef {{
 *   message: string,
 *   askForKey: boolean,
 *   offline: boolean,
 *   busy: boolean,
 * }} DesignerError
 */

/**
 * What a failed call to the designer relays means for the screen. Branches
 * on the game-server's `code` when there is one, then on the status. The
 * messages are fixed text: never the key, and never anything from a draft.
 *
 * @param {number} status 0 for a call that never came back
 * @param {unknown} body
 * @returns {DesignerError}
 */
export function designerError(status, body) {
  const code = body && typeof body === 'object' && 'code' in body ? body.code : undefined;
  const error = { askForKey: false, offline: false, busy: false };
  if (status === 401) {
    return { ...error, message: "That organiser key isn't right.", askForKey: true };
  }
  if (code === 'designer_busy') {
    return { ...error, message: 'A design is already running.', busy: true };
  }
  if (code === 'designer_disabled') {
    return { ...error, message: "The hunt designer isn't switched on on the game-server." };
  }
  if (status === 404) {
    return { ...error, message: 'No draft with this id. Check the link.' };
  }
  if (status === 400) {
    return { ...error, message: 'The link has no valid draft id.' };
  }
  if (status === 422) {
    return { ...error, message: "The game-server didn't accept this design. Check the fields and try again." };
  }
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return { ...error, message: 'No connection to the game server.', offline: true };
  }
  return { ...error, message: `Something went wrong (error ${status}).` };
}

/**
 * A 422's validation errors (FastAPI's `detail` list), each as "teams 2:
 * String should have at most 40 characters". The game-server never echoes
 * a submitted value in them.
 *
 * @param {unknown} body
 * @returns {string[]}
 */
function validationLines(body) {
  const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : undefined;
  if (!Array.isArray(detail)) {
    return [];
  }
  return detail
    .filter((item) => item && typeof item === 'object' && typeof item.msg === 'string')
    .map((item) => {
      const message = item.msg.replace(/^Value error, /, '');
      const where = (Array.isArray(item.loc) ? item.loc : [])
        .filter((part) => part !== 'body')
        .map((part) => (typeof part === 'number' ? String(part + 1) : String(part)))
        .join(' ');
      return where ? `${where}: ${message}` : message;
    });
}

/**
 * @typedef {DesignerError & {
 *   problems: Record<EditField | 'card', string[]> | null,
 *   reload: boolean,
 * }} EditError
 */

/**
 * What a failed edit, accept, reject or undo means for its card: a 422's
 * problems by the field each is shown under, or a message for the card.
 * `reload` when the draft has changed under the page (it was published, or
 * the checkpoint is gone), so it should be read again.
 *
 * @param {number} status 0 for a call that never came back
 * @param {unknown} body
 * @returns {EditError}
 */
export function editError(status, body) {
  const error = { ...designerError(status, body), problems: null, reload: false };
  const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : undefined;
  if (status === 422) {
    const problems = body && typeof body === 'object' && 'problems' in body ? body.problems : undefined;
    if (Array.isArray(problems)) {
      return { ...error, message: '', problems: problemsByField(problems) };
    }
    const lines = validationLines(body);
    return { ...error, message: ["The game-server didn't accept this change.", ...lines].join(' ') };
  }
  if (status === 409) {
    return { ...error, message: "This draft can't be edited any more: it may have been published.", reload: true };
  }
  if (status === 404) {
    return {
      ...error,
      message: detail === 'unknown checkpoint' ? "This checkpoint isn't in the draft any more." : error.message,
      reload: true,
    };
  }
  return error;
}

/**
 * @typedef {DesignerError & { lines: string[], reload: boolean }} PublishError
 */

/**
 * What a failed publish means: the game-server's own reason for a 409 (a
 * checkpoint still pending, too few accepted, already published), and its
 * problems or validation errors for a 422, one per line.
 *
 * @param {number} status 0 for a call that never came back
 * @param {unknown} body
 * @returns {PublishError}
 */
export function publishError(status, body) {
  const error = { ...designerError(status, body), lines: [], reload: false };
  const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : undefined;
  if (status === 409) {
    const reason = typeof detail === 'string' && detail ? ` ${detail}.` : '';
    return { ...error, message: `The game-server can't publish this draft yet.${reason}`, reload: true };
  }
  if (status === 422) {
    const problems = body && typeof body === 'object' && 'problems' in body ? body.problems : undefined;
    if (Array.isArray(problems)) {
      return { ...error, message: 'The accepted checkpoints break a rule:', lines: linesOf(problems) };
    }
    return { ...error, message: "The game-server didn't accept the form:", lines: validationLines(body) };
  }
  return error;
}

/**
 * What a failed GET …/publication means.
 *
 * @param {number} status 0 for a call that never came back
 * @param {unknown} body
 * @returns {DesignerError}
 */
export function publicationError(status, body) {
  const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : undefined;
  const error = designerError(status, body);
  if (status === 404 && detail === 'not published') {
    return { ...error, message: "The game-server has no publication for this draft." };
  }
  return error.offline ? { ...error, message: "No connection to the game server: the codes can't be shown." } : error;
}
