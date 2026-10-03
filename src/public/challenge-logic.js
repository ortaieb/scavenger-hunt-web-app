// Pure, DOM-free logic for the /challenge page — kept separate from
// challenge.js (which does the DOM/camera/fetch wiring) so it can be unit
// tested directly with Vitest, no jsdom needed.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Reads and validates the checkpoint from the page's query string (e.g.
 * /challenge?checkpoint=2). Unlike session/participant (see issue #18),
 * there's no sensible default for this — it names a specific point in the
 * hunt, so it always has to come from the link.
 *
 * @param {URLSearchParams} searchParams
 * @returns {number | null} null if missing or not an integer >= 1.
 */
export function readCheckpointFromQuery(searchParams) {
  const raw = searchParams.get('checkpoint');
  const checkpoint = raw === null ? NaN : Number(raw);

  return Number.isInteger(checkpoint) && checkpoint >= 1 ? checkpoint : null;
}

/**
 * @typedef {{ icon: string, label: string, reason: string }} ChecklistItem
 * @typedef {{
 *   message: string,
 *   variant: 'pass' | 'failed' | 'pending' | 'error',
 *   hideSubmit: boolean,
 *   hideRetake: boolean,
 *   checklist: ChecklistItem[],
 * }} VerdictDisplay
 */

// Friendly labels for known check names; anything else falls back to the
// raw name, so a check the game-server adds later still shows up sensibly.
const CHECK_LABELS = {
  window_open: 'Checkpoint open',
  capture_fresh: 'Photo is recent',
  capture_time_plausible: 'Photo time',
  in_range: 'Location',
  photo_unique: 'New photo',
  scene_matches: 'Right place',
  pose_correct: 'Right pose',
  session_running: 'Session running',
};

const CHECK_ICONS = { passed: '✓', failed: '✗', uncertain: '?' };

/**
 * Turns the relay's HTTP response into what to show the player. This only
 * *describes* what the game-server already decided — it must never compute
 * or infer a verdict (distance, time windows, checks, etc.) itself.
 *
 * The real shape nests everything under `verdict.checkpoint` (not at the
 * top level — see issue #21, which fixed a bug where this read the wrong
 * shape and silently hid every rejection reason):
 * `{ verdict: { checkpoint: { attempt, verdict, checks, rejections } } }`.
 * Branches on `checkpoint.verdict` ('pass'/'failed'/'pending'), not on the
 * HTTP status — the status is only a fallback for a body that isn't a
 * verdict at all (404, other 4xx/5xx, network errors).
 *
 * @param {number} status
 * @param {string} bodyText raw response body (JSON for a verdict, plain text otherwise)
 * @returns {VerdictDisplay}
 */
export function describeVerdict(status, bodyText) {
  const checkpoint = parseJsonSafely(bodyText)?.verdict?.checkpoint;

  if (checkpoint && typeof checkpoint === 'object' && typeof checkpoint.verdict === 'string') {
    const attempt = typeof checkpoint.attempt === 'number' ? checkpoint.attempt : undefined;
    const checklist = buildChecklist(checkpoint.checks);

    if (checkpoint.verdict === 'pass') {
      return result(withAttempt('Checkpoint passed!', attempt), 'pass', true, true, checklist);
    }

    if (checkpoint.verdict === 'failed') {
      const rejections = Array.isArray(checkpoint.rejections) ? checkpoint.rejections : [];
      const messages = rejections
        .map((rejection) => (rejection && typeof rejection.message === 'string' ? rejection.message : undefined))
        .filter((message) => Boolean(message));
      const reason = messages.length > 0 ? messages.join(' ') : 'Submission was rejected.';
      return result(withAttempt(reason, attempt), 'failed', true, false, checklist);
    }

    if (checkpoint.verdict === 'pending') {
      // The referee runs before this response now, so "pending" means a
      // moderator will look at it — not "waiting for the referee".
      return result(
        withAttempt('Your photo is with the moderator for review.', attempt),
        'pending',
        false,
        false,
        checklist,
      );
    }
  }

  // Not a verdict body: a 404/504/other status, or an unrecognized shape
  // (e.g. an older server with no `verdict.checkpoint` at all).
  if (status === 504) {
    return result('The referee took too long. Please try again.', 'error', false, false, []);
  }
  if (status === 404) {
    return result('Unknown game or checkpoint, check your link', 'error', false, false, []);
  }
  return result(`Error ${status}: ${bodyText || 'unexpected response'}`, 'error', false, false, []);
}

function result(message, variant, hideSubmit, hideRetake, checklist) {
  return { message, variant, hideSubmit, hideRetake, checklist };
}

/**
 * @param {unknown} checks
 * @returns {ChecklistItem[]}
 */
function buildChecklist(checks) {
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks
    .filter((check) => check && check.outcome !== 'skipped')
    .map((check) => {
      // The game-server names each check in `check` (see issue #38); `name`
      // is only a fallback for older bodies.
      const name = check.check ?? check.name;
      return {
        icon: CHECK_ICONS[check.outcome] ?? '?',
        label: CHECK_LABELS[name] ?? String(name ?? 'Check'),
        reason: typeof check.reason === 'string' ? check.reason : '',
      };
    });
}

function withAttempt(message, attempt) {
  return attempt === undefined ? message : `${message} (Attempt ${attempt})`;
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const ACCURACY_WARNING_METERS = 50;

/**
 * Local, advisory-only hint — no server round trip. Never blocks anything.
 *
 * @param {number} accuracyMeters
 * @returns {string} '' if no hint applies
 */
export function describeAccuracyHint(accuracyMeters) {
  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= ACCURACY_WARNING_METERS) {
    return '';
  }
  return `Your location fix is imprecise (±${Math.round(accuracyMeters)} m); try moving into the open.`;
}

/**
 * Turns the proximity relay's response into a warning to show, or none.
 * This is a courtesy hint, not a check: it never reports checkpoint
 * coordinates, distance or a radius (the relay never sends them either),
 * and it never gates Submit — every non-2xx case (429, 404, or anything
 * else, including a request that never came back at all) is treated as
 * "say nothing", per the issue.
 *
 * @param {number} status
 * @param {unknown} body already-parsed JSON, or null if parsing failed
 * @returns {string} '' if no warning applies
 */
export function describeProximityWarning(status, body) {
  if (status < 200 || status >= 300) {
    return '';
  }
  if (body && typeof body === 'object' && 'in_range' in body && body.in_range === false) {
    return 'You may be outside the checkpoint area. You can still submit.';
  }
  return '';
}

/**
 * Turns the checkpoint-challenge relay's response into pose text to show,
 * or null to hide the panel. The pose is guidance only, never a check: a
 * `{ pose: null }` body, a 404, a malformed body, any other non-2xx status,
 * or a request that never came back at all (represented here as status 0 —
 * see the caller) all mean "hide, and never block Capture or Submit" (see
 * issue #20).
 *
 * @param {number} status
 * @param {unknown} body already-parsed JSON, or null if parsing failed
 * @returns {string | null}
 */
export function describeChallenge(status, body) {
  if (status < 200 || status >= 300) {
    return null;
  }
  if (body && typeof body === 'object' && typeof body.pose === 'string' && body.pose.length > 0) {
    return body.pose;
  }
  return null;
}

/** @typedef {'environment' | 'user'} FacingMode */

/** The rear camera — what the page opened unconditionally before issue #31. */
export const DEFAULT_FACING_MODE = 'environment';

/**
 * Validates a stored/remembered camera choice, falling back to the rear
 * camera for anything unknown (nothing stored yet, an old or tampered value).
 *
 * @param {unknown} value
 * @returns {FacingMode}
 */
export function readFacingMode(value) {
  return value === 'user' || value === 'environment' ? value : DEFAULT_FACING_MODE;
}

/**
 * getUserMedia video constraints for the chosen camera. `ideal` rather than
 * `exact`, so a device that can't honour the choice (a laptop with one
 * webcam) still gets a picture instead of an OverconstrainedError.
 *
 * @param {FacingMode} facingMode
 * @returns {MediaTrackConstraints}
 */
export function buildVideoConstraints(facingMode) {
  return { facingMode: { ideal: facingMode } };
}

/**
 * Whether the front/back toggle is worth showing: only when the device
 * reports more than one camera. Browsers only list cameras fully once
 * camera permission is granted, so this is meant to be asked after the
 * first stream starts.
 *
 * @param {Array<{ kind: string }>} devices from enumerateDevices()
 * @returns {boolean}
 */
export function hasMultipleCameras(devices) {
  return Array.isArray(devices) && devices.filter((device) => device?.kind === 'videoinput').length > 1;
}
