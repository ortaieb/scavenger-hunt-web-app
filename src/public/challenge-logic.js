// Pure, DOM-free logic for the /challenge page — kept separate from
// challenge.js (which does the DOM/camera/fetch wiring) so it can be unit
// tested directly with Vitest, no jsdom needed.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @typedef {{ session: string, participant: string, checkpoint: number }} Identity
 */

/**
 * Reads and validates session/participant/checkpoint from the page's query
 * string (e.g. /challenge?session=...&participant=...&checkpoint=2). There's
 * no join flow yet, so this is how a submission is identified for now.
 *
 * @param {URLSearchParams} searchParams
 * @returns {Identity | null} null if any of the three are missing or malformed.
 */
export function readIdentityFromQuery(searchParams) {
  const session = searchParams.get('session');
  const participant = searchParams.get('participant');
  const checkpointRaw = searchParams.get('checkpoint');
  const checkpoint = checkpointRaw === null ? NaN : Number(checkpointRaw);

  if (
    !session ||
    !UUID_RE.test(session) ||
    !participant ||
    !UUID_RE.test(participant) ||
    !Number.isInteger(checkpoint) ||
    checkpoint < 1
  ) {
    return null;
  }

  return { session, participant, checkpoint };
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
