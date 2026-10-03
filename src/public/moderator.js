// DOM wiring for the moderator screen at /moderator (issue #44). Everything
// it decides lives in moderator-logic.js; this file reads and writes the
// DOM, keeps the moderator code for this tab, calls this app's moderator
// relays, and polls the overview.
//
// The moderator code is typed once and kept in sessionStorage only (so it
// goes when the tab closes), and sent only as `Authorization: Bearer
// <code>`: never in a URL, never in storage that outlives the tab, never
// logged.

import {
  actionsFor,
  blockedLine,
  CONFIRM_FINISH,
  CONFIRM_START,
  lastCompletedLine,
  moderatorError,
  newestBlocked,
  OVERVIEW_POLL_MS,
  overviewClockOffset,
  phaseBadge,
  phaseOf,
  readSessionId,
  teamRow,
} from './moderator-logic.js';

const REQUEST_TIMEOUT_MS = 15000;
const COUNTDOWN_TICK_MS = 1000;

const el = (id) => document.getElementById(id);

const session = readSessionId(new URLSearchParams(window.location.search));
const codeStorageKey = `scavenger-hunt.moderatorCode.${session}`;

const signInSection = el('sign-in');
const signInForm = el('sign-in-form');
const codeInput = el('moderator-code');
const signInBtn = el('sign-in-button');
const signOutBtn = el('sign-out');
const dashboardEl = el('dashboard');
const startBtn = el('start-button');
const finishBtn = el('finish-button');
const confirmDialog = el('confirm');

/** @type {import('./moderator-logic.js').Overview | null} */
let overview = null;
let clockOffsetMs = 0;
let pollTimer = null;
let tickTimer = null;
let latestRequestId = 0;
let busy = false;

// --- the code, for this tab only --------------------------------------------
// sessionStorage can throw (private browsing, blocked storage): then the
// code lives in memory for this page only.

let codeInMemory = null;

function loadCode() {
  try {
    return sessionStorage.getItem(codeStorageKey) ?? codeInMemory;
  } catch {
    return codeInMemory;
  }
}

function storeCode(code) {
  codeInMemory = code;
  try {
    if (code === null) {
      sessionStorage.removeItem(codeStorageKey);
    } else {
      sessionStorage.setItem(codeStorageKey, code);
    }
  } catch {
    // Kept in memory only; see above.
  }
}

// --- calls to this app's moderator relays ------------------------------------

/**
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<{ status: number, body: unknown, receivedAt: number }>}
 */
async function callRelay(url, init) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${loadCode() ?? ''}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    const receivedAt = Date.now();
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: leave body null.
    }
    return { status: response.status, body, receivedAt };
  } catch {
    return { status: 0, body: null, receivedAt: Date.now() };
  } finally {
    clearTimeout(timeoutId);
  }
}

function fetchOverview() {
  return callRelay(`/moderator/overview?${new URLSearchParams({ session })}`, { method: 'GET' });
}

function changePhase(action) {
  return callRelay(`/moderator/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session }),
  });
}

// --- rendering ---------------------------------------------------------------

function showMessage(id, message) {
  el(id).textContent = message;
  el(id).hidden = !message;
}

function setConnection(message) {
  el('connection-text').textContent = message;
  el('connection').hidden = !message;
}

function showSignIn(message) {
  stopPolling();
  overview = null;
  dashboardEl.hidden = true;
  signOutBtn.hidden = true;
  signInSection.hidden = false;
  showMessage('sign-in-error', message);
  codeInput.value = '';
  codeInput.focus();
}

function serverNow() {
  return Date.now() + clockOffsetMs;
}

function render() {
  if (!overview) {
    return;
  }
  signInSection.hidden = true;
  dashboardEl.hidden = false;
  signOutBtn.hidden = false;

  renderPhase();

  const final = phaseOf(overview.session) === 'stopped';
  el('standings-final').hidden = !final;
  el('standings').replaceChildren(...(overview.teams ?? []).map((team) => standingItem(team, final)));

  const blocked = newestBlocked(overview.blocked);
  el('blocked').replaceChildren(
    ...blocked.map((attempt) => {
      const { time, text } = blockedLine(attempt);
      const li = document.createElement('li');
      const timeEl = document.createElement('span');
      timeEl.className = 'blocked-time';
      timeEl.textContent = time;
      li.append(timeEl, ` ${text}`);
      return li;
    }),
  );
  el('blocked-empty').hidden = blocked.length > 0;
}

function renderPhase() {
  const badge = phaseBadge(overview?.session, serverNow());
  const badgeEl = el('phase-badge');
  badgeEl.textContent = badge.label;
  badgeEl.className = `phase-badge phase-badge--${badge.tone}`;
  el('phase-countdown').textContent = badge.countdown;
  el('phase-times').textContent = badge.times;

  const actions = actionsFor(overview?.session);
  startBtn.hidden = !actions.start;
  finishBtn.hidden = !actions.finish;
  startBtn.disabled = busy;
  finishBtn.disabled = busy;
}

function standingItem(team, final) {
  const row = teamRow(team, final);
  const li = document.createElement('li');
  li.className = team.joined ? 'team' : 'team team--not-joined';

  // textContent throughout: team and checkpoint names come from the
  // sessions file, not code this app controls.
  const head = document.createElement('div');
  head.className = 'team-head';
  if (row.place) {
    const place = document.createElement('span');
    place.className = 'team-place';
    place.textContent = row.place;
    head.append(place);
  }
  const name = document.createElement('span');
  name.className = 'team-name';
  name.textContent = row.name;
  head.append(name);
  for (const text of [row.joined, row.progress, row.points, row.inReview]) {
    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      head.append(span);
    }
  }

  const last = document.createElement('span');
  last.className = 'team-last';
  last.textContent = lastCompletedLine(team, serverNow());
  li.append(head, last);

  if (row.current) {
    const current = document.createElement('span');
    current.className = 'team-meta';
    current.textContent = row.current;
    li.append(current);
  }
  return li;
}

// --- polling -----------------------------------------------------------------

async function refresh() {
  const requestId = ++latestRequestId;
  const { status, body, receivedAt } = await fetchOverview();
  if (requestId !== latestRequestId) {
    return;
  }

  if (status === 200 && body && typeof body === 'object') {
    overview = /** @type {import('./moderator-logic.js').Overview} */ (body);
    clockOffsetMs = overviewClockOffset(overview, receivedAt);
    setConnection('');
    render();
    schedulePoll();
    return;
  }

  const error = moderatorError(status, body);
  if (error.askForCode) {
    storeCode(null);
    showSignIn(error.message);
    return;
  }
  if (overview) {
    // Keep showing the last overview; say what's wrong and keep trying.
    setConnection(error.message);
    schedulePoll();
    return;
  }
  // Nothing to show yet (e.g. right after signing in).
  signInSection.hidden = false;
  showMessage('sign-in-error', error.message);
  if (error.offline) {
    schedulePoll();
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.visibilityState === 'visible' && loadCode()) {
    pollTimer = setTimeout(() => void refresh(), OVERVIEW_POLL_MS);
  }
  if (tickTimer === null && document.visibilityState === 'visible') {
    // The countdown and "N min ago" move between polls.
    tickTimer = setInterval(renderPhase, COUNTDOWN_TICK_MS);
  }
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
  clearInterval(tickTimer);
  tickTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (loadCode()) {
      void refresh();
    }
  } else {
    // Polls only while the page is visible.
    stopPolling();
  }
});

// --- sign in -----------------------------------------------------------------

signInForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  if (!code) {
    showMessage('sign-in-error', 'Enter the moderator code.');
    return;
  }
  storeCode(code);
  codeInput.value = '';
  showMessage('sign-in-error', '');
  signInBtn.disabled = true;
  signInBtn.textContent = 'Signing in…';
  await refresh();
  signInBtn.disabled = false;
  signInBtn.textContent = 'Sign in';
});

signOutBtn.addEventListener('click', () => {
  storeCode(null);
  showSignIn('');
});

// --- start and finish ----------------------------------------------------------

/**
 * Asks before changing the phase, in a <dialog> (never a browser confirm).
 *
 * @returns {Promise<boolean>}
 */
function confirmAction(title, text, okLabel, warning) {
  el('confirm-title').textContent = title;
  el('confirm-text').textContent = text;
  const ok = el('confirm-ok');
  ok.textContent = okLabel;
  ok.className = warning ? 'button-warning' : '';
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
  });
}

async function runAction(action) {
  busy = true;
  showMessage('action-error', '');
  renderPhase();
  const { status, body } = await changePhase(action);
  busy = false;
  // 201 when the phase changed, 200 on a repeat: either way it's done.
  if (status !== 200 && status !== 201) {
    const error = moderatorError(status, body);
    if (error.askForCode) {
      storeCode(null);
      showSignIn(error.message);
      return;
    }
    showMessage('action-error', error.message);
  }
  await refresh();
}

startBtn.addEventListener('click', async () => {
  if (!busy && (await confirmAction('Start the session?', CONFIRM_START, 'Start session', false))) {
    await runAction('start');
  }
});

finishBtn.addEventListener('click', async () => {
  if (!busy && (await confirmAction('Finish the session now?', CONFIRM_FINISH, 'Finish session now', true))) {
    await runAction('stop');
  }
});

// --- start -------------------------------------------------------------------

if (!session) {
  el('no-session').hidden = false;
} else if (loadCode()) {
  void refresh();
} else {
  showSignIn('');
}
