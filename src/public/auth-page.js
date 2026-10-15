// /sign-in and /sign-up (issue #65): Clerk's own screens, mounted on a page
// in the app's style. After signing in, the player goes back to the
// `redirect` query parameter if it's a same-origin path, otherwise to /play,
// so a hunt link with a join code survives the round trip.

import { accountHref, NOT_SET_UP_TEXT, readReturnPath } from './account-logic.js';
import { loadClerk } from './clerk.js';

const page = document.body.dataset.page;
const mountPoint = document.getElementById('clerk');
const messageEl = document.getElementById('auth-message');
const switchLink = document.getElementById('auth-switch');
const target = readReturnPath(window.location.search);

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.hidden = false;
}

async function start() {
  const clerk = await loadClerk();
  if (clerk === undefined) {
    showMessage(NOT_SET_UP_TEXT);
    return;
  }
  if (clerk.user) {
    window.location.replace(target);
    return;
  }
  const other = page === 'sign-in' ? 'sign-up' : 'sign-in';
  const options = {
    // One URL for the whole flow, so `redirect` is still there at every step.
    routing: 'virtual',
    forceRedirectUrl: target,
    signInUrl: accountHref('sign-in', target),
    signUpUrl: accountHref('sign-up', target),
  };
  switchLink.href = accountHref(other, target);
  switchLink.hidden = false;
  if (page === 'sign-in') {
    clerk.mountSignIn(mountPoint, options);
  } else {
    clerk.mountSignUp(mountPoint, options);
  }
}

start().catch(() => {
  showMessage("Sign-in couldn't load. Check your connection and try again.");
});
