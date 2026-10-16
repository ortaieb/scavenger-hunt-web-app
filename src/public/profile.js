// DOM wiring for /profile (issue #68). What the profile means lives in
// profile-logic.js; this reads and writes the DOM and calls this app's /me
// relays with the signed-in player's token (authorised-fetch.js). Nothing
// about the profile is stored in the browser.

import { accountHref } from './account-logic.js';
import { accountStatus, authorisedFetch } from './authorised-fetch.js';
import {
  consentBody,
  consentStatus,
  DISPLAY_NAME_MAX,
  profileBody,
  profileError,
  readHunts,
  readProfile,
  UPCOMING_HUNTS_WORDING,
} from './profile-logic.js';

const REQUEST_TIMEOUT_MS = 15000;
const el = (id) => document.getElementById(id);

const messageEl = el('profile-message');
const messageText = el('profile-message-text');
const bodyEl = el('profile-body');
const form = el('profile-form');
const nameInput = el('display-name');
const areaInput = el('home-area');
const localeSelect = el('locale');
const saveBtn = el('save');
const saveMessage = el('save-message');
const consentInput = el('upcoming-hunts');
const consentStatusEl = el('consent-status');

async function call(url, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await authorisedFetch(url, {
      ...init,
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the status is still the answer.
    }
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

function showMessage(text, { signIn = false } = {}) {
  messageText.textContent = text;
  el('profile-sign-in').hidden = !signIn;
  messageEl.hidden = false;
  bodyEl.hidden = true;
}

function show(profile) {
  nameInput.value = profile.displayName;
  areaInput.value = profile.homeArea;
  localeSelect.value = profile.locale;
  consentInput.checked = profile.upcomingHunts;
  consentStatusEl.textContent = consentStatus(profile.upcomingHunts, profile.since);
}

function showHunts(body) {
  const rows = readHunts(body);
  el('hunts-empty').hidden = rows.length > 0;
  el('hunts').replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement('li');
      const name = document.createElement('div');
      name.className = 'hunt-name';
      name.textContent = row.name;
      const meta = document.createElement('div');
      meta.className = 'hunt-meta';
      meta.textContent = [row.team, row.date, row.line].filter(Boolean).join(' · ');
      item.append(name, meta);
      return item;
    }),
  );
}

function setSaveMessage(text) {
  saveMessage.textContent = text;
  saveMessage.hidden = text === '';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const checked = profileBody({ displayName: nameInput.value, homeArea: areaInput.value, locale: localeSelect.value });
  if ('error' in checked) {
    setSaveMessage(checked.error);
    return;
  }
  saveBtn.disabled = true;
  const { status, body } = await call('/me', { method: 'PATCH', body: JSON.stringify(checked.body) });
  saveBtn.disabled = false;
  if (status === 200) {
    const saved = readProfile(body);
    nameInput.value = saved.displayName;
    areaInput.value = saved.homeArea;
    setSaveMessage('Saved.');
  } else {
    setSaveMessage(profileError(status, body));
  }
});

// One tap, shown at once: the box and the line under it change straight
// away, and go back if the server doesn't take it.
consentInput.addEventListener('change', async () => {
  const granted = consentInput.checked;
  consentStatusEl.textContent = consentStatus(granted, new Date().toISOString());
  const { status } = await call('/me/consents/upcoming-hunts', { method: 'PUT', body: JSON.stringify(consentBody(granted)) });
  if (status < 200 || status >= 300) {
    consentInput.checked = !granted;
    consentStatusEl.textContent = `${profileError(status, null)} Your choice wasn't saved.`;
  }
});

async function start() {
  const status = await accountStatus();
  if (status === 'not-set-up' || status === 'unavailable') {
    showMessage(status === 'not-set-up' ? "Sign-in isn't set up yet." : "Sign-in couldn't load. Check your connection and reload the page.");
    return;
  }
  if (status === 'signed-out') {
    el('profile-sign-in').href = accountHref('sign-in', '/profile');
    showMessage('Sign in to see your profile.', { signIn: true });
    return;
  }
  const [me, hunts] = await Promise.all([call('/me'), call('/me/hunts')]);
  if (me.status !== 200) {
    showMessage(profileError(me.status, me.body));
    return;
  }
  el('upcoming-hunts-wording').textContent = UPCOMING_HUNTS_WORDING;
  nameInput.maxLength = DISPLAY_NAME_MAX;
  show(readProfile(me.body));
  showHunts(hunts.status === 200 ? hunts.body : null);
  messageEl.hidden = true;
  bodyEl.hidden = false;
}

start().catch(() => showMessage('Something went wrong. Please reload the page.'));
