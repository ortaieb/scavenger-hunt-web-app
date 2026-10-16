// Pure, DOM-free logic for the profile screen at /profile and the
// upcoming-hunts box on the join screen (issue #68), unit-tested with Vitest.
// What the game-server's GET/PATCH /me, /me/consents/upcoming-hunts and
// /me/hunts answer is read here, and what the form sends is built here.

/** The exact wording of the box. A change to it needs a new version. */
export const UPCOMING_HUNTS_WORDING = 'Email me about upcoming hunts';
export const UPCOMING_HUNTS_WORDING_VERSION = '2026-10-v1';

export const DISPLAY_NAME_MAX = 40;
export const HOME_AREA_NOTE = 'A postcode district such as W4 is enough. Please don’t enter a full postcode.';

// A UK postcode district: W4, SW1A, EC1, M60, B33.
const DISTRICT_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;

/**
 * What the form's fields mean for PATCH /me: trimmed, empty to clear, and the
 * home area upper-cased. Returns the first problem as a message instead of a
 * body if a field is wrong (the server checks again).
 *
 * @param {{ displayName: string, homeArea: string, locale: string }} fields
 * @returns {{ body: { displayName: string, homeArea: string, locale: string } } | { error: string }}
 */
export function profileBody({ displayName, homeArea, locale }) {
  const name = displayName.trim();
  const area = homeArea.replace(/\s+/g, '').toUpperCase();
  if ([...name].length > DISPLAY_NAME_MAX) {
    return { error: `Your name can be up to ${DISPLAY_NAME_MAX} characters.` };
  }
  if (area !== '' && !DISTRICT_RE.test(area)) {
    return { error: 'Home area is a postcode district such as W4 or SW1A, not a full postcode.' };
  }
  return { body: { displayName: name, homeArea: area, locale } };
}

/** The server's per-field messages for a 422 (`errors` or `code` per field), as one line. */
export function profileError(status, body) {
  if (status === 401) {
    return 'Sign in to see your profile.';
  }
  if (status === 0) {
    return 'No signal. Check your connection and try again.';
  }
  if (status === 422) {
    const fields = Object.keys(body?.errors ?? {});
    return fields.length > 0
      ? `Please check: ${fields.join(', ')}.`
      : 'Some of that wasn’t accepted. Please check it and try again.';
  }
  return 'Something went wrong. Please try again.';
}

/**
 * The profile as the form shows it.
 *
 * @param {unknown} body
 * @returns {{ displayName: string, homeArea: string, locale: string, upcomingHunts: boolean, since: string }}
 */
export function readProfile(body) {
  const me = /** @type {Record<string, any>} */ (body && typeof body === 'object' ? body : {});
  const consent = me.upcomingHunts && typeof me.upcomingHunts === 'object' ? me.upcomingHunts : {};
  return {
    displayName: typeof me.displayName === 'string' ? me.displayName : '',
    homeArea: typeof me.homeArea === 'string' ? me.homeArea : '',
    locale: typeof me.locale === 'string' ? me.locale : 'en-GB',
    upcomingHunts: consent.granted === true,
    since: typeof consent.since === 'string' ? consent.since : '',
  };
}

/** The body of PUT /me/consents/upcoming-hunts for a tick or an untick. */
export function consentBody(granted) {
  return granted ? { granted: true, wordingVersion: UPCOMING_HUNTS_WORDING_VERSION } : { granted: false };
}

/** The line under the box that says where consent stands, shown at once. */
export function consentStatus(granted, since) {
  if (!granted) {
    return 'You won’t get emails about upcoming hunts.';
  }
  const date = since ? new Date(since) : null;
  const when = date && !Number.isNaN(date.getTime()) ? ` since ${date.toLocaleDateString('en-GB')}` : '';
  return `You’ve agreed to emails about upcoming hunts${when}. Untick the box to stop them.`;
}

/**
 * One row of "Your hunts", or undefined if the entry isn't usable.
 *
 * @param {unknown} hunt
 * @returns {{ name: string, team: string, date: string, line: string } | undefined}
 */
export function huntRow(hunt) {
  const h = /** @type {Record<string, any>} */ (hunt && typeof hunt === 'object' ? hunt : {});
  if (typeof h.huntName !== 'string') {
    return undefined;
  }
  const date = typeof h.date === 'string' && !Number.isNaN(new Date(h.date).getTime()) ? new Date(h.date) : null;
  const checkpoints = Number.isInteger(h.checkpointsCompleted) ? h.checkpointsCompleted : 0;
  const points = Number.isInteger(h.points) ? h.points : 0;
  return {
    name: h.huntName,
    team: typeof h.team === 'string' ? h.team : '',
    date: date ? date.toLocaleDateString('en-GB') : '',
    line: `${checkpoints} ${checkpoints === 1 ? 'checkpoint' : 'checkpoints'} · ${points} ${points === 1 ? 'point' : 'points'}`,
  };
}

/** The hunts from GET /me/hunts (a list, or `{ hunts: [...] }`), newest first as sent. */
export function readHunts(body) {
  const list = Array.isArray(body) ? body : body?.hunts;
  return Array.isArray(list) ? list.map(huntRow).filter((row) => row !== undefined) : [];
}

/** Teammates' display names from GET .../members, empty names left out. */
export function readMemberNames(body) {
  const list = Array.isArray(body) ? body : body?.members;
  return Array.isArray(list)
    ? list.map((member) => (typeof member?.displayName === 'string' ? member.displayName.trim() : '')).filter(Boolean)
    : [];
}
