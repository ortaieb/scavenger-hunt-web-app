// DOM wiring for /profile (issue #68). What the profile means lives in
// profile-logic.js; this reads and writes the DOM and calls this app's /me
// relays with the signed-in player's token (authorised-fetch.js). Nothing
// about the profile is stored in the browser.
/* global Blob */

import { accountHref } from './account-logic.js';
import { accountStatus, authorisedFetch } from './authorised-fetch.js';
import {
  consentBody,
  consentStatus,
  deleteConfirmationBody,
  DELETE_IN_PROGRESS,
  deleteError,
  DISPLAY_NAME_MAX,
  exportFileName,
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
const exportBtn = el('export-btn');
const deleteBtn = el('delete-btn');
const deleteDialog = el('delete-dialog');
const deleteCancel = el('delete-cancel');
const deleteConfirm = el('delete-confirm');
const deleteHeading = el('delete-heading');
const deleteMessage = el('delete-message');
const deleteItems = el('delete-items');

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

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  const { status, body } = await call('/me/export');
  exportBtn.disabled = false;
  if (status !== 200) {
    setSaveMessage(profileError(status, body));
    return;
  }
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName();
  link.click();
  URL.revokeObjectURL(url);
});

deleteBtn.addEventListener('click', () => {
  const content = deleteConfirmationBody();
  deleteHeading.textContent = content.heading;
  deleteMessage.textContent = content.message;
  deleteItems.replaceChildren(
    createDeleteItemsContent(content.deletedItems, content.keepItems),
  );
  deleteCancel.textContent = content.cancelButton;
  deleteConfirm.textContent = content.confirmButton;
  deleteDialog.showModal();
});

deleteCancel.addEventListener('click', (e) => {
  e.preventDefault();
  deleteDialog.close();
});

deleteConfirm.addEventListener('click', async (e) => {
  e.preventDefault();
  deleteConfirm.disabled = true;
  deleteCancel.disabled = true;
  deleteConfirm.textContent = DELETE_IN_PROGRESS;
  const { status } = await call('/me', { method: 'DELETE' });
  deleteConfirm.disabled = false;
  deleteCancel.disabled = false;
  if (status < 200 || status >= 300) {
    deleteConfirm.textContent = deleteConfirmationBody().confirmButton;
    setSaveMessage(deleteError(status));
    return;
  }
  deleteDialog.close();
  window.location.replace(accountHref('sign-in', '/play'));
});

function createDeleteItemsContent(deleted, kept) {
  const container = document.createElement('div');
  const deletedSection = document.createElement('div');
  deletedSection.className = 'delete-list';
  const deletedHeading = document.createElement('h4');
  deletedHeading.textContent = 'Deleted:';
  const deletedList = document.createElement('ul');
  deleted.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    deletedList.appendChild(li);
  });
  deletedSection.appendChild(deletedHeading);
  deletedSection.appendChild(deletedList);
  
  const keptSection = document.createElement('div');
  keptSection.className = 'delete-list';
  const keptHeading = document.createElement('h4');
  keptHeading.textContent = 'Kept:';
  const keptList = document.createElement('ul');
  kept.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    keptList.appendChild(li);
  });
  keptSection.appendChild(keptHeading);
  keptSection.appendChild(keptList);
  
  container.appendChild(deletedSection);
  container.appendChild(keptSection);
  return container;
}

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
