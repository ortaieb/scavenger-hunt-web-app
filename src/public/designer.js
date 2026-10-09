// DOM wiring for the hunt designer at /designer (issue #59). Everything it
// decides lives in designer-logic.js; this file reads and writes the DOM,
// keeps the organiser key for this tab, calls this app's designer relays,
// and polls a running draft. A ready draft is reviewed card by card and
// published here too (issue #60), under a map of its route (issue #61).
//
// The organiser key is typed once and kept in sessionStorage only (so it
// goes when the tab closes), and sent only as `Authorization: Bearer
// <key>`: never in a URL, never in storage that outlives the tab, never
// logged.
//
// A draft's clues, scenes and coordinates are the answers to its hunt. They
// are kept in memory and on screen only: never stored, never logged, and
// never in the URL, which holds a draft's id and nothing else. The same goes
// for a publication's join codes and moderator code, which are fetched again
// each time a published draft is opened.

import {
  changedFields,
  CHECKPOINT_LIMITS,
  counter,
  designerError,
  DRAFT_POLL_MS,
  draftFacts,
  draftListLine,
  editError,
  elapsedLine,
  failureText,
  fieldError,
  formFromCheckpoint,
  formFromRequest,
  isDraftId,
  isRunning,
  LIST_POLL_MS,
  newestFirst,
  problemLines,
  progressLines,
  publicationError,
  publicationView,
  publishedRows,
  publishError,
  PUBLISH_LIMITS,
  publishReadiness,
  readDraftId,
  requestLine,
  REVIEW_WORDS,
  reviewCards,
  reviewOf,
  reviewSummary,
  routeMap,
  runLine,
  runningDraftId,
  statusLabel,
  TEXT_FIELDS,
  validateDesign,
  validateEdit,
  validatePublish,
} from './designer-logic.js';
import { createRouteMap } from './designer-map.js';
import { clockOffset } from './game-logic.js';

const REQUEST_TIMEOUT_MS = 15000;
const TICK_MS = 1000;
const COPIED_MS = 2000;
const HIGHLIGHT_MS = 2500;
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
const cardsEl = el('cards');
const publishForm = el('publish-form');
const publishBtn = el('publish-button');
const teamsEl = el('teams');
const confirmDialog = /** @type {HTMLDialogElement} */ (el('publish-confirm'));

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

/**
 * The review cards of the open ready draft, by position: the card, whether
 * it's saving, and its errors. Built once per draft, so what's typed in one
 * card survives saving another.
 *
 * @type {Map<number, { li: HTMLElement, saving: boolean, errors: Partial<Record<string, string[]>> }>}
 */
const cards = new Map();
/** Which draft and checkpoints the cards were built for. */
let cardsKey = '';
/** The team names in the publish form, one per row. */
let teamNames = ['', ''];
let publishing = false;
/**
 * The open published draft's codes, in memory only.
 *
 * @type {{ draftId: string, view: NonNullable<ReturnType<typeof publicationView>> } | null}
 */
let publication = null;
let publicationMessage = '';
let publicationRequestId = 0;
/**
 * The route map, made the first time a finished draft is shown (it has to
 * be on screen for that): null when Leaflet didn't load.
 *
 * @type {import('./designer-map.js').RouteMap | null | undefined}
 */
let mapView;
/** The draft the map's view was last fitted to. */
let mapFitted = '';
let tilesFailed = false;
let highlightTimer = null;

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

function patchCheckpoint(id, position, edit) {
  return callRelay(`/designer/drafts/${encodeURIComponent(id)}/checkpoints/${position}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edit),
  });
}

function postPublish(id, request) {
  return callRelay(`/designer/drafts/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

function fetchPublication(id) {
  return callRelay(`/designer/drafts/${encodeURIComponent(id)}/publication`, { method: 'GET' });
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
  // Take every draft and every code off the screen, as well as out of memory.
  drafts = null;
  draft = null;
  draftError = '';
  listError = '';
  forgetPublication();
  resetPublishForm();
  if (confirmDialog.open) {
    confirmDialog.close('cancel');
  }
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
  el('draft-facts').textContent = draft && !isRunning(draft) ? draftFacts(draft) : '';
  showMessage('draft-error', draftError);

  // A failed draft: why, and the problems from its last attempt.
  el('draft-failed').hidden = status !== 'failed';
  const problems = status === 'failed' ? problemLines(draft) : [];
  el('failure-text').textContent = status === 'failed' ? failureText(draft) : '';
  el('problems').replaceChildren(...problems.map((problem) => make('li', '', problem)));
  el('problems-block').hidden = problems.length === 0;

  // A ready draft is reviewed and published; a published one shows its
  // codes and the hunt it became.
  const finished = status === 'ready' || status === 'published';
  el('draft-ready').hidden = !finished;
  // The map first: the cards and rows link to its markers.
  renderMap();
  renderReview();
  renderPublished();
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

// --- the route map -----------------------------------------------------------------

const MAP_UNAVAILABLE = "The map couldn't load. The checkpoints below still work.";
const TILES_FAILED = "The map couldn't load. The numbered places and the loop are still shown.";

/**
 * The open draft's route, once it's finished: drawn again whenever a review
 * changes, but fitted to the view only when the draft is first shown, so a
 * pan or zoom isn't undone.
 */
function renderMap() {
  const view = routeMap(draft);
  const shown = Boolean(view?.bounds);
  el('map-block').hidden = !shown;
  if (!view || !shown) {
    // Take the places off the map, as well as off the screen.
    mapView?.clear();
    mapFitted = '';
    return;
  }
  if (mapView === undefined) {
    mapView = createRouteMap(el('route-map'), {
      onSelect: showCheckpoint,
      onTiles: (loaded) => {
        tilesFailed = !loaded;
        renderMapNote();
      },
    });
  }
  el('route-map').hidden = mapView === null;
  if (mapView) {
    mapView.draw(view, draft.id !== mapFitted);
    mapFitted = draft.id;
  }
  renderMapNote();
}

function renderMapNote() {
  showMessage('map-note', mapView === null ? MAP_UNAVAILABLE : tilesFailed ? TILES_FAILED : '');
}

/**
 * A checkpoint's name: a button that finds it on the map when it's there,
 * or the name alone.
 *
 * @param {number} position
 * @param {string} text
 * @returns {HTMLElement | string}
 */
function placeName(position, text) {
  if (!mapView?.has(position)) {
    return text;
  }
  const button = /** @type {HTMLButtonElement} */ (make('button', 'place-button', text));
  button.type = 'button';
  button.setAttribute('aria-describedby', 'locate-hint');
  return button;
}

/**
 * A marker was tapped: go to its card (its row, once published) and
 * highlight it for a moment.
 *
 * @param {number} position
 */
function showCheckpoint(position) {
  const li =
    draft?.status === 'ready' ? cards.get(position)?.li : el('checkpoints').querySelector(`li[data-position="${position}"]`);
  if (!li) {
    return;
  }
  clearTimeout(highlightTimer);
  for (const other of draftPanel.querySelectorAll('[data-highlighted]')) {
    other.removeAttribute('data-highlighted');
  }
  li.setAttribute('data-highlighted', '');
  // Its top, with the name and the review: a card can be taller than a phone's screen.
  li.scrollIntoView?.({ block: 'start' });
  li.focus({ preventScroll: true });
  highlightTimer = setTimeout(() => li.removeAttribute('data-highlighted'), HIGHLIGHT_MS);
}

/**
 * A checkpoint's name was tapped: centre the map on its marker.
 *
 * @param {number} position
 */
function showOnMap(position) {
  if (mapView?.focus(position)) {
    el('map-block').scrollIntoView?.({ block: 'start' });
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
  if (id !== openId) {
    resetPublishForm();
  }
  openId = id;
  draft = null;
  draftError = '';
  offline.draft = false;
  forgetPublication();
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
  forgetPublication();
  resetPublishForm();
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
    void loadPublication();
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

// --- reviewing a ready draft --------------------------------------------------------

/** A card's text fields: what each is for, and who sees it. */
const CARD_FIELDS = [
  { field: 'clue', label: 'Clue', hint: 'Shown to players on the clue screen.', rows: 3 },
  { field: 'pose', label: 'Pose', hint: 'Shown to players at check-in: what to do in the photo.', rows: 2 },
  { field: 'scene', label: 'Scene', hint: 'For the referee only: never shown to players.', rows: 4 },
];

const fieldId = (position, field) => `card-${position}-${field}`;

/**
 * @param {number} position
 * @returns {import('./designer-logic.js').DraftCheckpoint | null} the checkpoint as saved
 */
function checkpointAt(position) {
  const checkpoints = Array.isArray(draft?.checkpoints) ? draft.checkpoints : [];
  return checkpoints.find((checkpoint) => checkpoint?.position === position) ?? null;
}

/**
 * @param {number} position
 * @returns {import('./designer-logic.js').CheckpointForm} the card's fields, as typed
 */
function readCard(position) {
  const value = (field) => /** @type {HTMLInputElement | null} */ (el(fieldId(position, field)))?.value ?? '';
  return { clue: value('clue'), pose: value('pose'), scene: value('scene'), proximity: value('proximity') };
}

/**
 * @param {number} position
 * @param {import('./designer-logic.js').CheckpointForm} form
 */
function writeCard(position, form) {
  for (const field of [...TEXT_FIELDS, 'proximity']) {
    const input = /** @type {HTMLInputElement | null} */ (el(fieldId(position, field)));
    if (input) {
      input.value = form[field];
    }
  }
}

function makeButton(action, text, className = '') {
  const button = /** @type {HTMLButtonElement} */ (make('button', className, text));
  button.type = 'button';
  button.dataset.action = action;
  return button;
}

/**
 * One checkpoint's card. Its fields are filled in once, here: re-rendering
 * the card later leaves what's typed alone.
 *
 * @param {ReturnType<typeof reviewCards>[number]} card
 * @returns {HTMLElement}
 */
function buildCard(card) {
  const li = make('li', 'card');
  li.dataset.position = String(card.position);
  // Focused when its marker is tapped.
  li.tabIndex = -1;

  const head = make('div', 'card-head');
  const name = make('h3', 'card-name');
  name.append(placeName(card.position, `${card.position}. ${card.name}`));
  head.append(
    name,
    make('span', 'review-badge'),
    make('span', 'edited-mark', 'Edited'),
  );
  li.append(head);
  if (card.kind) {
    li.append(make('p', 'card-kind', card.kind));
  }
  if (card.rationale) {
    const why = make('p', 'card-rationale');
    why.append(make('span', 'card-rationale-label', 'Why this place: '), card.rationale);
    li.append(why);
  }
  if (card.osmUrl) {
    const link = /** @type {HTMLAnchorElement} */ (make('a', 'osm-link', 'Open in OpenStreetMap'));
    link.href = card.osmUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    li.append(link);
  }

  for (const { field, label, hint, rows } of CARD_FIELDS) {
    const id = fieldId(card.position, field);
    const labelEl = /** @type {HTMLLabelElement} */ (make('label', 'field-label', label));
    labelEl.htmlFor = id;
    const area = /** @type {HTMLTextAreaElement} */ (make('textarea'));
    area.id = id;
    area.rows = rows;
    area.dataset.field = field;
    area.value = card.form[field];
    area.setAttribute('aria-describedby', `${id}-hint ${id}-count ${id}-error`);
    const foot = make('div', 'field-foot');
    const hintEl = make('p', 'field-hint', hint);
    hintEl.id = `${id}-hint`;
    const count = make('span', 'counter');
    count.id = `${id}-count`;
    foot.append(hintEl, count);
    const error = make('p', 'field-error');
    error.id = `${id}-error`;
    error.hidden = true;
    li.append(labelEl, area, foot, error);
  }

  const { min, max } = CHECKPOINT_LIMITS.proximity;
  const radiusId = fieldId(card.position, 'proximity');
  const radiusLabel = /** @type {HTMLLabelElement} */ (make('label', 'field-label', 'Check-in radius (m)'));
  radiusLabel.htmlFor = radiusId;
  const radius = /** @type {HTMLInputElement} */ (make('input', 'radius'));
  Object.assign(radius, { id: radiusId, type: 'number', inputMode: 'numeric', min: String(min), max: String(max), step: '1' });
  radius.dataset.field = 'proximity';
  radius.value = card.form.proximity;
  radius.setAttribute('aria-describedby', `${radiusId}-hint ${radiusId}-error`);
  const radiusHint = make('p', 'field-hint', `${min} to ${max} m around the place: how close a team must be to check in.`);
  radiusHint.id = `${radiusId}-hint`;
  const radiusError = make('p', 'field-error');
  radiusError.id = `${radiusId}-error`;
  radiusError.hidden = true;
  li.append(radiusLabel, radius, radiusHint, radiusError);

  const cardError = make('p', 'message message--error card-error');
  cardError.setAttribute('role', 'alert');
  cardError.hidden = true;
  const actions = make('div', 'card-actions');
  actions.append(
    makeButton('save', 'Save changes', 'button-secondary card-save'),
    makeButton('accepted', 'Accept', 'card-accept'),
    makeButton('rejected', 'Reject', 'button-secondary card-reject'),
    makeButton('pending', 'Undo', 'button-secondary card-undo'),
  );
  li.append(cardError, actions);
  return li;
}

/**
 * Brings a card up to date with its checkpoint as saved and its fields as
 * typed: its review, the edited mark, the counters, the errors, and which
 * buttons it offers.
 *
 * @param {number} position
 */
function updateCard(position) {
  const state = cards.get(position);
  const checkpoint = checkpointAt(position);
  if (!state || !checkpoint) {
    return;
  }
  const { li, saving, errors } = state;
  const review = reviewOf(checkpoint);
  li.className = `card card--${review}`;
  li.setAttribute('aria-busy', String(saving));
  const badge = li.querySelector('.review-badge');
  badge.textContent = REVIEW_WORDS[review];
  badge.className = `review-badge review-badge--${review}`;
  li.querySelector('.edited-mark').hidden = checkpoint.edited !== true;

  const form = readCard(position);
  for (const field of TEXT_FIELDS) {
    const { text, over } = counter(field, form[field]);
    const count = el(`${fieldId(position, field)}-count`);
    count.textContent = text;
    count.classList.toggle('counter--over', over);
  }
  for (const field of [...TEXT_FIELDS, 'proximity']) {
    const messages = errors[field] ?? [];
    const error = el(`${fieldId(position, field)}-error`);
    error.textContent = messages.join(' ');
    error.hidden = messages.length === 0;
    const input = el(fieldId(position, field));
    input.readOnly = saving;
    if (messages.length > 0) {
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
    }
  }
  const cardMessages = errors.card ?? [];
  const cardError = li.querySelector('.card-error');
  cardError.textContent = cardMessages.join(' ');
  cardError.hidden = cardMessages.length === 0;

  const dirty = Object.keys(changedFields(checkpoint, form)).length > 0;
  const save = li.querySelector('.card-save');
  save.disabled = saving || !dirty;
  save.textContent = saving ? 'Saving…' : 'Save changes';
  for (const [selector, shown] of [
    ['.card-accept', review !== 'accepted'],
    ['.card-reject', review !== 'rejected'],
    ['.card-undo', review !== 'pending'],
  ]) {
    const button = li.querySelector(selector);
    button.hidden = !shown;
    button.disabled = saving;
  }
}

/** The cards with changes not saved yet. */
function unsavedPositions() {
  return [...cards.keys()].filter((position) => {
    const checkpoint = checkpointAt(position);
    return checkpoint !== null && Object.keys(changedFields(checkpoint, readCard(position))).length > 0;
  });
}

function renderReview() {
  const ready = draft?.status === 'ready';
  el('draft-review').hidden = !ready;
  const list = ready ? reviewCards(draft) : [];
  const key = ready ? `${draft.id}:${list.map((card) => card.position).join(',')}` : '';
  if (key !== cardsKey) {
    cardsKey = key;
    cards.clear();
    cardsEl.replaceChildren(
      ...list.map((card) => {
        const li = buildCard(card);
        cards.set(card.position, { li, saving: false, errors: {} });
        return li;
      }),
    );
  }
  for (const card of list) {
    updateCard(card.position);
  }
  renderSummary();
  renderPublishReadiness();
}

/** The summary bar: the counts, and the loop over the accepted checkpoints. */
function renderSummary() {
  const summary = reviewSummary(draft);
  el('count-accepted').textContent = `${summary.accepted} accepted`;
  el('count-rejected').textContent = `${summary.rejected} rejected`;
  el('count-pending').textContent = `${summary.pending} to review`;
  el('review-loop').textContent = summary.loop;
}

/**
 * Sends an edit, an accept, a reject or an undo for one card. While it's on
 * its way, the card's buttons are disabled and its fields can't change.
 *
 * @param {number} position
 * @param {Record<string, unknown>} edit
 * @param {boolean} fill whether to fill the fields in from the saved checkpoint
 */
async function sendEdit(position, edit, fill) {
  const state = cards.get(position);
  const id = draft?.id;
  if (!state || !id || state.saving) {
    return;
  }
  state.saving = true;
  state.errors = {};
  updateCard(position);
  renderPublishReadiness();
  const { status, body } = await patchCheckpoint(id, position, edit);
  state.saving = false;
  if (!loadKey() || draft?.id !== id || cards.get(position) !== state) {
    return;
  }

  if (status === 200 && body && typeof body === 'object' && body.position === position) {
    const saved = /** @type {import('./designer-logic.js').DraftCheckpoint} */ (body);
    draft = { ...draft, checkpoints: draft.checkpoints.map((checkpoint) => (checkpoint?.position === position ? saved : checkpoint)) };
    if (fill) {
      writeCard(position, formFromCheckpoint(saved));
    }
    updateCard(position);
    // A review restyles its marker, and a rejection redraws the loop.
    renderMap();
    renderSummary();
    renderPublishReadiness();
    return;
  }

  const error = editError(status, body);
  if (error.askForKey) {
    askForKey(error.message);
    return;
  }
  const shown = error.problems && Object.values(error.problems).some((messages) => messages.length > 0);
  state.errors = shown ? error.problems : { card: [error.message || "The game-server didn't accept this change."] };
  updateCard(position);
  renderPublishReadiness();
  if (error.reload) {
    void pollDraft();
  }
}

/** Save: only the fields that changed, checked in the page first. */
async function saveCard(position) {
  const state = cards.get(position);
  const checkpoint = checkpointAt(position);
  if (!state || !checkpoint || state.saving) {
    return;
  }
  const { changes, errors } = validateEdit(checkpoint, readCard(position));
  const invalid = Object.keys(errors);
  if (invalid.length > 0) {
    state.errors = Object.fromEntries(invalid.map((field) => [field, [errors[field]]]));
    updateCard(position);
    el(fieldId(position, invalid[0]))?.focus();
    return;
  }
  if (Object.keys(changes).length > 0) {
    await sendEdit(position, changes, true);
  }
}

cardsEl.addEventListener('input', (event) => {
  const field = event.target?.dataset?.field;
  const position = Number(event.target?.closest?.('li.card')?.dataset.position);
  const state = cards.get(position);
  if (!state || !field) {
    return;
  }
  // What was wrong with this field may not be any more: check it as typed.
  if (state.errors[field]) {
    const message = fieldError(field, event.target.value);
    state.errors = { ...state.errors, [field]: message ? [message] : [] };
  }
  updateCard(position);
  renderPublishReadiness();
});

cardsEl.addEventListener('click', (event) => {
  const place = event.target?.closest?.('button.place-button');
  if (place) {
    showOnMap(Number(place.closest('li.card')?.dataset.position));
    return;
  }
  const button = event.target?.closest?.('button[data-action]');
  const position = Number(button?.closest('li.card')?.dataset.position);
  if (!button || !cards.has(position)) {
    return;
  }
  const { action } = button.dataset;
  if (action === 'save') {
    void saveCard(position);
  } else {
    void sendEdit(position, { review: action }, false);
  }
});

// --- publishing ------------------------------------------------------------------------

function renderPublishReadiness() {
  if (draft?.status !== 'ready') {
    return;
  }
  const readiness = publishReadiness(draft, unsavedPositions());
  const saving = [...cards.values()].some((state) => state.saving);
  publishBtn.disabled = publishing || saving || !readiness.ok;
  publishBtn.textContent = publishing ? 'Publishing…' : 'Publish hunt';
  const reason = el('publish-reason');
  reason.textContent = readiness.message;
  reason.hidden = readiness.ok;
}

function renderTeams() {
  const { min, max } = PUBLISH_LIMITS.teams;
  teamsEl.replaceChildren(
    ...teamNames.map((name, index) => {
      const id = `team-${index + 1}`;
      const li = make('li', 'team-row');
      const label = /** @type {HTMLLabelElement} */ (make('label', 'visually-hidden', `Team ${index + 1}`));
      label.htmlFor = id;
      const input = /** @type {HTMLInputElement} */ (make('input'));
      Object.assign(input, { id, type: 'text', value: name, maxLength: PUBLISH_LIMITS.teamName.max, autocomplete: 'off' });
      input.placeholder = ['Red Foxes', 'Blue Herons'][index] ?? '';
      input.dataset.index = String(index);
      input.setAttribute('aria-describedby', `${id}-error`);
      const remove = makeButton('remove', 'Remove', 'button-secondary remove-team');
      remove.dataset.index = String(index);
      remove.setAttribute('aria-label', `Remove team ${index + 1}`);
      remove.disabled = teamNames.length <= min;
      const row = make('div', 'team-input');
      row.append(input, remove);
      const error = make('p', 'field-error');
      error.id = `${id}-error`;
      error.hidden = true;
      li.append(label, row, error);
      return li;
    }),
  );
  el('add-team').disabled = teamNames.length >= max;
}

teamsEl.addEventListener('input', (event) => {
  const index = Number(event.target?.dataset?.index);
  if (Number.isInteger(index) && index < teamNames.length) {
    teamNames[index] = event.target.value;
  }
});

teamsEl.addEventListener('click', (event) => {
  const button = event.target?.closest?.('button.remove-team');
  const index = Number(button?.dataset.index);
  if (!button || !Number.isInteger(index) || teamNames.length <= PUBLISH_LIMITS.teams.min) {
    return;
  }
  teamNames.splice(index, 1);
  renderTeams();
  el(`team-${Math.min(index + 1, teamNames.length)}`)?.focus();
});

el('add-team').addEventListener('click', () => {
  if (teamNames.length >= PUBLISH_LIMITS.teams.max) {
    return;
  }
  teamNames.push('');
  renderTeams();
  el(`team-${teamNames.length}`)?.focus();
});

const PUBLISH_FIELDS = { name: 'hunt-name', start: 'start-time', end: 'end-time' };

/**
 * @param {import('./designer-logic.js').PublishErrors} errors
 * @param {string[]} teamRows
 */
function showPublishErrors(errors, teamRows) {
  for (const [name, id] of Object.entries(PUBLISH_FIELDS)) {
    const message = errors[name] ?? '';
    el(`${id}-error`).textContent = message;
    el(`${id}-error`).hidden = !message;
    if (message) {
      el(id).setAttribute('aria-invalid', 'true');
    } else {
      el(id).removeAttribute('aria-invalid');
    }
  }
  el('teams-error').textContent = errors.teams ?? '';
  el('teams-error').hidden = !errors.teams;
  teamRows.forEach((message, index) => {
    const error = el(`team-${index + 1}-error`);
    if (error) {
      error.textContent = message;
      error.hidden = !message;
      el(`team-${index + 1}`).toggleAttribute('aria-invalid', Boolean(message));
    }
  });
}

/**
 * @param {string} message
 * @param {string[]} lines
 */
function showPublishError(message, lines) {
  el('publish-error-text').textContent = message;
  el('publish-error-lines').replaceChildren(...lines.map((line) => make('li', '', line)));
  el('publish-error').hidden = !message;
}

/** A fresh publish form, for another draft or once published. */
function resetPublishForm() {
  for (const id of Object.values(PUBLISH_FIELDS)) {
    /** @type {HTMLInputElement} */ (el(id)).value = '';
  }
  teamNames = ['', ''];
  renderTeams();
  showPublishErrors({}, []);
  showPublishError('', []);
}

/**
 * Asks before publishing, in a <dialog> (never a browser confirm).
 *
 * @returns {Promise<boolean>}
 */
function confirmPublish() {
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
  });
}

el('publish-cancel').addEventListener('click', () => confirmDialog.close('cancel'));
el('publish-ok').addEventListener('click', () => confirmDialog.close('ok'));

publishForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = draft?.id;
  if (publishing || !id || publishBtn.disabled) {
    return;
  }
  const { request, errors, teamRows } = validatePublish({
    name: el('hunt-name').value,
    start: el('start-time').value,
    end: el('end-time').value,
    teams: teamNames,
  });
  showPublishErrors(errors, teamRows);
  showPublishError('', []);
  if (!request) {
    const first = Object.keys(PUBLISH_FIELDS).find((name) => errors[name]);
    const firstTeam = teamRows.findIndex(Boolean);
    (first ? el(PUBLISH_FIELDS[first]) : firstTeam >= 0 ? el(`team-${firstTeam + 1}`) : el('add-team'))?.focus();
    return;
  }
  if (!(await confirmPublish()) || draft?.id !== id) {
    return;
  }

  publishing = true;
  renderPublishReadiness();
  const { status, body } = await postPublish(id, request);
  publishing = false;
  if (!loadKey()) {
    return;
  }

  if (status === 201) {
    const view = publicationView(body);
    publication = view ? { draftId: id, view } : null;
    publicationMessage = view ? '' : "It's published, but the codes didn't come through. Open this draft again to see them.";
    resetPublishForm();
    if (draft?.id === id) {
      // Published: show the codes now, then read the draft as it is.
      draft = { ...draft, status: 'published' };
      renderDraft();
      void pollDraft();
    }
    void refreshList();
    return;
  }

  renderPublishReadiness();
  const error = publishError(status, body);
  if (error.askForKey) {
    askForKey(error.message);
    return;
  }
  showPublishError(error.message, error.lines);
  el('publish-error').scrollIntoView?.({ block: 'center' });
  if (error.reload) {
    void pollDraft();
  }
});

// --- a published draft: its codes ------------------------------------------------------

function forgetPublication() {
  publicationRequestId += 1;
  publication = null;
  publicationMessage = '';
}

/** A published draft's codes, fetched again each time it's opened: never kept. */
async function loadPublication() {
  const id = draft?.id;
  if (draft?.status !== 'published' || !id || publication?.draftId === id) {
    return;
  }
  const requestId = ++publicationRequestId;
  publicationMessage = '';
  renderPublication();
  const { status, body } = await fetchPublication(id);
  if (requestId !== publicationRequestId || draft?.id !== id || !loadKey()) {
    return;
  }
  const view = status === 200 ? publicationView(body) : null;
  if (view) {
    publication = { draftId: id, view };
  } else {
    const error = publicationError(status, body);
    if (error.askForKey) {
      askForKey(error.message);
      return;
    }
    publicationMessage = status === 200 ? "The game-server's answer had no codes in it." : error.message;
  }
  renderPublication();
}

el('publication-retry').addEventListener('click', () => void loadPublication());

/**
 * Copies a code or link, and says so in words as well as on the button.
 *
 * @param {string} text
 * @param {HTMLButtonElement} button
 * @param {string} what e.g. "Red Foxes' join code"
 */
async function copyText(text, button, what) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    // No clipboard (an older browser, or permission refused): say so.
  }
  button.textContent = copied ? 'Copied' : "Couldn't copy";
  el('copy-status').textContent = copied ? `Copied ${what}.` : `Couldn't copy ${what}: select it and copy it instead.`;
  setTimeout(() => {
    button.textContent = 'Copy';
  }, COPIED_MS);
}

function moderatorUrl(view) {
  return new URL(view.moderatorPath, window.location.origin).href;
}

el('copy-moderator-link').addEventListener('click', (event) => {
  if (publication) {
    void copyText(moderatorUrl(publication.view), event.currentTarget, 'the moderator link');
  }
});

el('copy-moderator-code').addEventListener('click', (event) => {
  if (publication) {
    void copyText(publication.view.moderatorCode, event.currentTarget, 'the moderator code');
  }
});

function renderPublication() {
  const published = draft?.status === 'published';
  const view = published && publication?.draftId === draft?.id ? publication.view : null;
  el('publication').hidden = !view;
  showMessage('publication-error', published ? publicationMessage : '');
  el('publication-retry').hidden = !(published && publicationMessage);
  el('publication-session').textContent = view?.session ?? '';
  const link = el('moderator-link');
  link.textContent = view ? moderatorUrl(view) : '';
  link.setAttribute('href', view ? view.moderatorPath : '/moderator');
  el('moderator-code').textContent = view?.moderatorCode ?? '';
  el('copy-status').textContent = '';
  el('team-codes').replaceChildren(
    ...(view?.teams ?? []).map((team) => {
      const li = make('li', 'team-code');
      const copy = makeButton('copy', 'Copy', 'button-secondary copy-button');
      copy.setAttribute('aria-label', `Copy ${team.name}'s join code`);
      copy.addEventListener('click', () => void copyText(team.code, copy, `${team.name}'s join code`));
      li.append(make('span', 'team-code-name', team.name), make('code', 'code-text', team.code), copy);
      return li;
    }),
  );
}

function renderPublished() {
  const published = draft?.status === 'published';
  el('draft-published').hidden = !published;
  el('checkpoints').replaceChildren(
    ...(published ? publishedRows(draft) : []).map((row) => {
      const li = make('li', 'checkpoint');
      li.dataset.position = String(row.position);
      li.tabIndex = -1;
      const name = make('h3', 'checkpoint-name');
      name.append(placeName(row.position, `${row.position}. ${row.name}`));
      li.append(name);
      const details = make('dl', 'checkpoint-details');
      details.append(make('dt', '', 'Clue'), make('dd', '', row.clue), make('dt', '', 'Pose'), make('dd', '', row.pose));
      li.append(details);
      return li;
    }),
  );
  renderPublication();
}

el('checkpoints').addEventListener('click', (event) => {
  const place = event.target?.closest?.('button.place-button');
  if (place) {
    showOnMap(Number(place.closest('li.checkpoint')?.dataset.position));
  }
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

renderTeams();
if (loadKey()) {
  showWorkspace();
  void refreshList();
  if (openId) {
    openDraft(openId, false);
  }
} else {
  showSignIn('');
}
