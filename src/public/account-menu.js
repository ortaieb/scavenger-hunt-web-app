// The account menu in the app bar of /play, /moderator and /designer (issue
// #65): Clerk's user button when signed in, a link to sign in when not, and
// a short note when sign-in isn't set up. Nothing else on the page depends
// on it, so a failure here leaves the page as it is.

import { accountHref, DEFAULT_RETURN_PATH, NOT_SET_UP_TEXT } from './account-logic.js';
import { loadClerk } from './clerk.js';

const slot = document.getElementById('account');

function showSignInLink() {
  const link = document.createElement('a');
  link.className = 'account-link';
  link.textContent = 'Sign in';
  link.href = accountHref('sign-in', `${window.location.pathname}${window.location.search}`);
  slot.replaceChildren(link);
}

async function mountAccountMenu() {
  const clerk = await loadClerk();
  if (clerk === undefined) {
    const note = document.createElement('span');
    note.className = 'account-note';
    note.textContent = NOT_SET_UP_TEXT;
    slot.replaceChildren(note);
    return;
  }
  if (clerk.user) {
    const button = document.createElement('div');
    const profile = document.createElement('a');
    profile.className = 'account-link';
    profile.textContent = 'Profile';
    profile.href = '/profile';
    slot.replaceChildren(profile, button);
    clerk.mountUserButton(button, { afterSignOutUrl: DEFAULT_RETURN_PATH });
  } else {
    showSignInLink();
  }
}

if (slot) {
  mountAccountMenu().catch(() => {
    // Sign-in couldn't load (offline, blocked): the page itself still works.
    slot.replaceChildren();
  });
}
