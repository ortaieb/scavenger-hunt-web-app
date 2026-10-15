// Pure, DOM-free logic for sign-up, sign-in and the account menu (issue
// #65), unit-tested with Vitest like game-logic.js. Accounts are run by
// Clerk; this only decides where to go after signing in and where to load
// Clerk from.

/** Where to go after signing in when there's nothing (safe) to go back to. */
export const DEFAULT_RETURN_PATH = '/play';

// Parsing only needs *an* origin to resolve a path against; any value works.
const BASE = 'https://app.invalid';

function isForbiddenChar(char) {
  const code = char.codePointAt(0);
  return char === '\\' || code <= 0x1f || code === 0x7f;
}

/**
 * Returns the path (with its query and fragment) to go to after signing in:
 * `value` if it's a same-origin path, otherwise /play. A hunt link's join
 * code lives in its query, so that's kept.
 *
 * Only a path starting with a single `/` is accepted, never a full URL, a
 * `//host` or `/\host` form (browsers treat both as another origin), or
 * anything with a backslash or control character in it.
 */
export function returnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    return DEFAULT_RETURN_PATH;
  }
  if (value.startsWith('//') || [...value].some(isForbiddenChar)) {
    return DEFAULT_RETURN_PATH;
  }
  let url;
  try {
    url = new URL(value, BASE);
  } catch {
    return DEFAULT_RETURN_PATH;
  }
  if (url.origin !== BASE) {
    return DEFAULT_RETURN_PATH;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The `redirect` query parameter of a page's own query string, as a safe path. */
export function readReturnPath(search) {
  return returnPath(new URLSearchParams(search).get('redirect'));
}

/** A link to /sign-in or /sign-up that comes back to `path` afterwards. */
export function accountHref(page, path) {
  return `/${page}?redirect=${encodeURIComponent(returnPath(path))}`;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The clerk-js script's URL, from the instance's Frontend API (a host name,
 * with or without `https://`), or undefined if it doesn't look like a host
 * name. It becomes a script's source, so it's checked, not trusted.
 */
export function clerkScriptUrl(frontendApi) {
  if (typeof frontendApi !== 'string') {
    return undefined;
  }
  const host = frontendApi.trim().replace(/^https:\/\//i, '').replace(/\/+$/, '');
  return HOST_RE.test(host) ? `https://${host}/npm/@clerk/clerk-js@5/dist/clerk.browser.js` : undefined;
}

/** True when GET /config says Clerk is set up: both values are there. */
export function clerkConfigured(config) {
  return (
    typeof config?.clerkPublishableKey === 'string' &&
    config.clerkPublishableKey !== '' &&
    clerkScriptUrl(config.clerkFrontendApi) !== undefined
  );
}

export const NOT_SET_UP_TEXT = "Sign-in isn't set up yet.";
