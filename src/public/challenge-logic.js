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
 * @typedef {{ message: string, forceRetake: boolean }} VerdictDisplay
 */

/**
 * Turns the relay's HTTP response into what to show the player. This only
 * *describes* what the game-server already decided — it must never compute
 * or infer a verdict (distance, time windows, etc.) itself.
 *
 * @param {number} status
 * @param {string} bodyText raw response body (JSON for a verdict, plain text otherwise)
 * @returns {VerdictDisplay}
 */
export function describeVerdict(status, bodyText) {
  if (status === 202) {
    const attempt = readAttempt(parseJsonSafely(bodyText));
    return {
      message: withAttempt('Checks passed, waiting for the referee.', attempt),
      forceRetake: false,
    };
  }

  if (status === 200) {
    const body = parseJsonSafely(bodyText);
    const attempt = readAttempt(body);
    const rejections = Array.isArray(body?.rejections) ? body.rejections : [];
    const messages = rejections
      .map((rejection) => (rejection && typeof rejection.message === 'string' ? rejection.message : undefined))
      .filter((message) => Boolean(message));
    const reason = messages.length > 0 ? messages.join(' ') : 'Submission was rejected.';
    return {
      message: withAttempt(reason, attempt),
      forceRetake: true,
    };
  }

  if (status === 404) {
    return { message: 'Unknown game or checkpoint, check your link', forceRetake: false };
  }

  return {
    message: `Error ${status}: ${bodyText || 'unexpected response'}`,
    forceRetake: false,
  };
}

function readAttempt(body) {
  return body && typeof body.attempt === 'number' ? body.attempt : undefined;
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
