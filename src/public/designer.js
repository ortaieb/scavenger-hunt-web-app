// DOM wiring for the hunt designer at /designer (issue #59). Everything it
// decides lives in designer-logic.js; this file reads and writes the DOM,
// keeps the organiser key for this tab, calls this app's designer relays,
// and polls a running draft.
//
// The organiser key is typed once and kept in sessionStorage only (so it
// goes when the tab closes), and sent only as `Authorization: Bearer
// <key>`: never in a URL, never in storage that outlives the tab, never
// logged.
//
// A draft's clues, scenes and coordinates are the answers to its hunt. They
// are kept in memory and on screen only: never stored, never logged, and
// never in the URL, which holds a draft's id and nothing else.

import {
  checkpointRows,
  designerError,
  DRAFT_POLL_MS,
  draftListLine,
  elapsedLine,
  failureText,
  formFromRequest,
  isDraftId,
  isRunning,
  LIST_POLL_MS,
  newestFirst,
  problemLines,
  progressLines,
  readDraftId,
  requestLine,
  runLine,
  runningDraftId,
  statusLabel,
  validateDesign,
} from './designer-logic.js';
import { clockOffset } from './game-logic.js';

const REQUEST_TIMEOUT_MS = 15000;
const TICK_MS = 1000;
const KEY_STORAGE_KEY = 'scavenger-hunt.organiserKey';

const el = (id) => document.getElementById(id);

const signInSection = el('sign-in');
const signInForm = el('sign-in-form');
const keyInput = el('organiser-key');
const signInBtn = el('sign-in-button');
const signOutBtn = el('sign-out');
const workspaceEl = el('workspace');
const draftPanel = el('draft-panel');
const stepsEl = el('steps');
const designForm = el('design-form');
const designBtn = el('design-button');
const draftsEl = el('drafts');

/** The form's fields, by the name designer-logic.js gives them. */
const fields = {
  area: el('area'),
  theme: el('theme'),
  checkpoints: el('checkpoints-count'),
  maxWalkKm: el('max-walk-km'),
};
const fieldErrors = {
  area: el('area-error'),
  theme: el('theme-error'),
  checkpoints: el('checkpoints-error'),
  maxWalkKm: el('max-walk-km-error'),
};

/** @type {import('./designer-logic.js').DraftListItem[] | null} */
let drafts = null;
/** The open draft's id, from the URL. */
let openId = readDraftId(new URLSearchParams(window.location.search));
/** @type {import('./designer-logic.js').Draft | null} */
let draft = null;
let draftError = '';
let listError = '';
const offline = { list: false, draft: false };
let clockOffsetMs = 0;
let draftTimer = null;
let listTimer = null;
let tickTimer = null;
let draftRequestId = 0;
let listRequestId = 0;
let sending = false;
/** Whether the form says a design is already running. */
let busyShown = false;

// --- the key, for this tab only ----------------------------------------------
// sessionStorage can throw (private browsing, blocked storage): then the
// key lives in memory for this page only.

let keyInMemory = null;

function loadKey() {
  try {
    return sessionStorage.getItem(KEY_STORAGE_KEY) ?? keyInMemory;
  } catch {
    return keyInMemory;
  }
}

function storeKey(key) {
  keyInMemory = key;
  try {
    if (key === null) {
      sessionStorage.removeItem(KEY_STORAGE_KEY);
    } else {
      sessionStorage.setItem(KEY_STORAGE_KEY, key);
    }
  } catch {
    // Kept in memory only; see above.
  }
}

// --- calls to this app's designer relays -------------------------------------

/**
 * Calls one of this app's designer relays with the key. `date` is the
 * response's Date header, so a running draft's time follows the server.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<{ status: number, body: unknown, receivedAt: number, date: string | null }>}
 */
async function callRelay(url, init) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${loadKey() ?? ''}` },
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
    return { status: response.status, body, receivedAt, date: response.headers.get('date') };
  } catch {
    return { status: 0, body: null, receivedAt: Date.now(), date: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

function fetchDrafts() {
  return callRelay('/designer/drafts', { method: 'GET' });
}

function fetchDraft(id) {
  return callRelay(`/designer/drafts/${encodeURIComponent(id)}`, { method: 'GET' });
}

function postDesign(request) {
  return callRelay('/designer/drafts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

// --- rendering ---------------------------------------------------------------
// textContent throughout: areas, themes, place names, clues, poses and
// problems come from the organiser, the map data and the designer, not code
// this app controls.

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function showMessage(id, message) {
  el(id).textContent = message;
  el(id).hidden = !message;
}

function renderConnection() {
  const message = offline.list || offline.draft ? 'No connection to the game server. Retrying…' : '';
  el('connection-text').textContent = message;
  el('connection').hidden = !message;
}

function serverNow() {
  return Date.now() + clockOffsetMs;
}

function draftUrl(id) {
  return `/designer?${new URLSearchParams({ draft: id })}`;
}

function showWorkspace() {
  signInSection.hidden = true;
  workspaceEl.hidden = false;
  signOutBtn.hidden = false;
}

function showSignIn(message) {
  stopTimers();
  // Take every draft off the screen, as well as out of memory.
  drafts = null;
  draft = null;
  draftError = '';
  listError = '';
  offline.list = false;
  offline.draft = false;
  renderConnection();
  renderDraft();
  renderList();
  workspaceEl.hidden = true;
  signOutBtn.hidden = true;
  signInSection.hidden = false;
  showMessage('sign-in-error', message);
  keyInput.value = '';
  keyInput.focus();
}

/** A 401 from any relay: forget the key and ask again. */
function askForKey(message) {
  storeKey(null);
  showSignIn(message);
}

function renderList() {
  const list = drafts ?? [];
  draftsEl.replaceChildren(
    ...list.map((item) => {
      const line = draftListLine(item);
      const link = /** @type {HTMLAnchorElement} */ (make('a', 'draft-link'));
      link.href = draftUrl(item.id);
      link.dataset.draft = item.id;
      if (item.id === openId) {
        link.setAttribute('aria-current', 'page');
      }
      const head = make('span', 'draft-link-head');
      head.append(
        make('span', `draft-status draft-status--${item.status}`, line.status),
        make('span', 'draft-link-area', line.area),
      );
      link.append(head, make('span', 'draft-link-theme', line.theme));
      const meta = [line.when, line.cost].filter(Boolean).join(' · ');
      if (meta) {
        link.append(make('span', 'draft-link-meta', meta));
      }
      const li = make('li');
      li.append(link);
      return li;
    }),
  );
  el('drafts-empty').hidden = drafts === null || list.length > 0;
  showMessage('drafts-error', listError);
}

function renderElapsed() {
  el('draft-elapsed').textContent = draft ? (isRunning(draft) ? elapsedLine(draft, serverNow()) : runLine(draft)) : '';
}

/**
 * The run's steps as a growing list: new steps are added at the end, so
 * the list doesn't jump while it's being read.
 *
 * @param {{ at: string, text: string }[]} lines
 */
function renderSteps(lines) {
  const id = draft?.id ?? '';
  if (stepsEl.dataset.draft !== id || stepsEl.children.length > lines.length) {
    stepsEl.replaceChildren();
    stepsEl.dataset.draft = id;
  }
  for (const line of lines.slice(stepsEl.children.length)) {
    const li = make('li');
    if (line.at) {
      li.append(make('span', 'step-time', line.at));
    }
    li.append(make('span', 'step-text', line.text));
    stepsEl.append(li);
  }
}

function renderDraft() {
  draftPanel.hidden = !openId;
  const status = draft?.status;

  el('draft-title').textContent = draft?.request?.area || 'Draft';
  el('draft-theme').textContent = draft?.request?.theme ?? '';
  el('draft-request').textContent = requestLine(draft?.request);
  const statusEl = el('draft-status');
  statusEl.textContent = draft ? statusLabel(status) : draftError ? '' : 'Loading the draft…';
  statusEl.className = draft ? `draft-status draft-status--${status}` : 'draft-status';
  statusEl.hidden = !statusEl.textContent;
  renderElapsed();
  showMessage('draft-error', draftError);

  // A failed draft: why, and the problems from its last attempt.
  el('draft-failed').hidden = status !== 'failed';
  const problems = status === 'failed' ? problemLines(draft) : [];
  el('failure-text').textContent = status === 'failed' ? failureText(draft) : '';
  el('problems').replaceChildren(...problems.map((problem) => make('li', '', problem)));
  el('problems-block').hidden = problems.length === 0;

  // A ready (or published) draft: its checkpoints, read-only.
  const finished = status === 'ready' || status === 'published';
  el('draft-ready').hidden = !finished;
  el('checkpoints').replaceChildren(
    ...(finished ? checkpointRows(draft) : []).map((row) => {
      const li = make('li', 'checkpoint');
      li.append(make('h3', 'checkpoint-name', `${row.position}. ${row.name}`));
      const details = make('dl', 'checkpoint-details');
      details.append(make('dt', '', 'Clue'), make('dd', '', row.clue), make('dt', '', 'Pose'), make('dd', '', row.pose));
      li.append(details);
      return li;
    }),
  );
  el('attribution').textContent = finished && typeof draft?.attribution === 'string' ? `Map data ${draft.attribution}` : '';

  const lines = progressLines(draft);
  el('steps-block').hidden = !draft || (lines.length === 0 && !isRunning(draft));
  el('steps-empty').hidden = !(isRunning(draft) && lines.length === 0);
  renderSteps(lines);

  for (const link of draftsEl.querySelectorAll('a.draft-link')) {
    if (link.dataset.draft === openId) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
}

// --- the drafts list -----------------------------------------------------------

async function refreshList() {
  const requestId = ++listRequestId;
  clearTimeout(listTimer);
  listTimer = null;
  const { status, body } = await fetchDrafts();
  if (requestId !== listRequestId || !loadKey()) {
    return;
  }

  if (status === 200) {
    drafts = newestFirst(body);
    listError = '';
    offline.list = false;
    if (busyShown && runningDraftId(drafts) === null) {
      // The design that was running has finished: another can start.
      showDesignError('', null);
    }
  } else {
    const error = designerError(status, body);
    if (error.askForKey) {
      askForKey(error.message);
      return;
    }
    // Keep showing the last list; say what's wrong.
    offline.list = error.offline;
    listError = error.offline ? '' : error.message;
  }
  showWorkspace();
  renderConnection();
  renderList();
  scheduleListPoll();
}

/**
 * The list is refreshed while it shows a running draft (the open one's
 * own polling refreshes it when it finishes), or while it can't be had.
 */
function scheduleListPoll() {
  clearTimeout(listTimer);
  listTimer = null;
  if (document.visibilityState !== 'visible' || !loadKey()) {
    return;
  }
  const running = drafts ? runningDraftId(drafts) : null;
  if (offline.list || (running !== null && running !== openId)) {
    listTimer = setTimeout(() => void refreshList(), LIST_POLL_MS);
  }
}

// Opens a draft in place. A new tab or window (a modified click) is left to
// the browser: the link works on its own too.
draftsEl.addEventListener('click', (event) => {
  const link = event.target?.closest?.('a.draft-link');
  const id = link?.dataset.draft;
  if (!isDraftId(id) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  openDraft(id, true);
});

// --- the open draft --------------------------------------------------------------

/**
 * @param {string} id
 * @param {boolean} push whether to add it to the browser's history
 */
function openDraft(id, push) {
  if (push && id !== openId) {
    window.history.pushState(null, '', draftUrl(id));
  }
  openId = id;
  draft = null;
  draftError = '';
  offline.draft = false;
  renderConnection();
  renderDraft();
  draftPanel.scrollIntoView?.({ block: 'start' });
  void pollDraft();
}

/** @param {boolean} push whether to add it to the browser's history */
function closeDraft(push) {
  if (push) {
    window.history.pushState(null, '', '/designer');
  }
  draftRequestId += 1;
  clearTimeout(draftTimer);
  draftTimer = null;
  openId = null;
  draft = null;
  draftError = '';
  offline.draft = false;
  renderConnection();
  renderDraft();
  updateTick();
  scheduleListPoll();
}

async function pollDraft() {
  const id = openId;
  if (!id) {
    return;
  }
  const requestId = ++draftRequestId;
  clearTimeout(draftTimer);
  draftTimer = null;
  const { status, body, receivedAt, date } = await fetchDraft(id);
  if (requestId !== draftRequestId || id !== openId || !loadKey()) {
    return;
  }

  if (status === 200 && body && typeof body === 'object') {
    const wasRunning = isRunning(draft);
    draft = /** @type {import('./designer-logic.js').Draft} */ (body);
    clockOffsetMs = clockOffset(date, receivedAt);
    draftError = '';
    offline.draft = false;
    renderConnection();
    renderDraft();
    scheduleDraftPoll();
    if (wasRunning && !isRunning(draft)) {
      // It's finished: show its status and cost in the list too.
      void refreshList();
    }
    return;
  }

  const error = designerError(status, body);
  if (error.askForKey) {
    askForKey(error.message);
    return;
  }
  if (error.offline) {
    // Keep showing the last of the draft; say what's wrong and keep trying.
    offline.draft = true;
    renderConnection();
    scheduleDraftPoll();
    return;
  }
  draftError = error.message;
  renderDraft();
  updateTick();
}

/** Polls the open draft while it's running (or not had yet) and the page is visible. */
function scheduleDraftPoll() {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (openId && document.visibilityState === 'visible' && loadKey() && !draftError && (!draft || isRunning(draft))) {
    draftTimer = setTimeout(() => void pollDraft(), DRAFT_POLL_MS);
  }
  updateTick();
}

/** The elapsed time moves between polls. */
function updateTick() {
  const ticking = document.visibilityState === 'visible' && isRunning(draft) && Boolean(openId);
  if (ticking && tickTimer === null) {
    tickTimer = setInterval(renderElapsed, TICK_MS);
  } else if (!ticking && tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function stopTimers() {
  draftRequestId += 1;
  listRequestId += 1;
  clearTimeout(draftTimer);
  draftTimer = null;
  clearTimeout(listTimer);
  listTimer = null;
  clearInterval(tickTimer);
  tickTimer = null;
}

el('draft-close').addEventListener('click', (event) => {
  event.preventDefault();
  closeDraft(true);
});

window.addEventListener('popstate', () => {
  const id = readDraftId(new URLSearchParams(window.location.search));
  if (id === openId || !loadKey()) {
    openId = id;
    return;
  }
  if (id) {
    openDraft(id, false);
  } else {
    closeDraft(false);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    // Polls only while the page is visible.
    stopTimers();
    return;
  }
  if (loadKey()) {
    void refreshList();
    if (openId && !draftError && (!draft || isRunning(draft))) {
      void pollDraft();
    }
  }
});

// --- New design ----------------------------------------------------------------

/** @returns {import('./designer-logic.js').DesignForm} */
function readForm() {
  return {
    area: fields.area.value,
    theme: fields.theme.value,
    checkpoints: fields.checkpoints.value,
    maxWalkKm: fields.maxWalkKm.value,
  };
}

/** @param {import('./designer-logic.js').DesignForm} form */
function fillForm(form) {
  for (const name of /** @type {const} */ (['area', 'theme', 'checkpoints', 'maxWalkKm'])) {
    fields[name].value = form[name];
  }
}

/** @param {import('./designer-logic.js').FormErrors} errors */
function showFieldErrors(errors) {
  for (const name of /** @type {const} */ (['area', 'theme', 'checkpoints', 'maxWalkKm'])) {
    const message = errors[name] ?? '';
    fieldErrors[name].textContent = message;
    fieldErrors[name].hidden = !message;
    if (message) {
      fields[name].setAttribute('aria-invalid', 'true');
    } else {
      fields[name].removeAttribute('aria-invalid');
    }
  }
}

/**
 * @param {string} message
 * @param {string | null} runningId the running draft to link to
 */
function showDesignError(message, runningId) {
  busyShown = Boolean(message) && runningId !== null;
  el('design-error-text').textContent = message;
  const link = el('design-error-link');
  link.hidden = !runningId;
  if (runningId) {
    link.setAttribute('href', draftUrl(runningId));
    link.dataset.draft = runningId;
  }
  el('design-error').hidden = !message;
}

function setSending(value) {
  sending = value;
  designBtn.disabled = value;
  designBtn.textContent = value ? 'Starting…' : 'Start design';
}

designForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending) {
    return;
  }
  const { request, errors } = validateDesign(readForm());
  showFieldErrors(errors);
  showDesignError('', null);
  if (!request) {
    const first = Object.keys(errors)[0];
    if (first) {
      fields[first].focus();
    }
    return;
  }

  setSending(true);
  const { status, body } = await postDesign(request);
  setSending(false);
  if (!loadKey()) {
    return;
  }

  const id = body && typeof body === 'object' && 'id' in body ? body.id : null;
  if (status === 202 && isDraftId(id)) {
    el('design-note').hidden = true;
    openDraft(id, true);
    void refreshList();
    return;
  }

  const error = designerError(status, body);
  if (error.askForKey) {
    askForKey(error.message);
    return;
  }
  if (error.busy) {
    // Link to the design that's running: the 409 doesn't say which it is.
    await refreshList();
    if (!loadKey()) {
      return;
    }
    showDesignError(error.message, drafts ? runningDraftId(drafts) : null);
    return;
  }
  showDesignError(error.offline ? `${error.message} Try again.` : error.message, null);
});

el('design-error-link').addEventListener('click', (event) => {
  const id = el('design-error-link').dataset.draft;
  if (isDraftId(id) && event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
    event.preventDefault();
    openDraft(id, true);
  }
});

// Try again: the form, filled in with the failed draft's request.
el('try-again').addEventListener('click', () => {
  fillForm(formFromRequest(draft?.request));
  showFieldErrors({});
  showDesignError('', null);
  el('design-note').hidden = false;
  designForm.scrollIntoView?.({ block: 'start' });
  designBtn.focus();
});

// --- the key ---------------------------------------------------------------------

signInForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!key) {
    showMessage('sign-in-error', 'Enter the organiser key.');
    return;
  }
  storeKey(key);
  keyInput.value = '';
  showMessage('sign-in-error', '');
  signInBtn.disabled = true;
  signInBtn.textContent = 'Checking…';
  await refreshList();
  signInBtn.disabled = false;
  signInBtn.textContent = 'Continue';
  if (loadKey() && openId) {
    openDraft(openId, false);
  }
});

signOutBtn.addEventListener('click', () => {
  storeKey(null);
  showSignIn('');
});

// --- start -------------------------------------------------------------------------

if (loadKey()) {
  showWorkspace();
  void refreshList();
  if (openId) {
    openDraft(openId, false);
  }
} else {
  showSignIn('');
}
