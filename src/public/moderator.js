// DOM wiring for the moderator screen at /moderator (issues #44 and #55).
// Everything it decides lives in moderator-logic.js; this file reads and
// writes the DOM, keeps the moderator code for this tab, calls this app's
// moderator relays, and polls the overview and the review queue.
//
// The moderator code is typed once and kept in sessionStorage only (so it
// goes when the tab closes), and sent only as `Authorization: Bearer
// <code>`: never in a URL, never in storage that outlives the tab, never
// logged.
//
// Photos need that header too, so an <img> can't load them from the relay
// itself: each is fetched with the header and shown through an object URL,
// revoked when its photo leaves the screen. Photos, notes and the
// referee's reasons are kept in memory only, never stored or logged.

import {
  actionsFor,
  askedFor,
  blockedLine,
  checkpointLabel,
  CONFIRM_START,
  confirmFinishText,
  finishBanner,
  lastCompletedLine,
  moderatorError,
  newestBlocked,
  NOTE_MAX_LENGTH,
  otherChecksLine,
  OVERVIEW_POLL_MS,
  overviewClockOffset,
  phaseBadge,
  photosWaiting,
  readSessionId,
  recentLine,
  recentNewestFirst,
  referencePositions,
  reviewChecks,
  reviewHeading,
  reviewItemHead,
  rulingBody,
  standingsNote,
  teamRow,
  toReviewOldestFirst,
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
const reviewQueueEl = el('review-queue');
const decidedEl = el('decided');
const viewer = el('photo-viewer');

/** @type {import('./moderator-logic.js').Overview | null} */
let overview = null;
/** @type {import('./moderator-logic.js').Review | null} */
let review = null;
let clockOffsetMs = 0;
let pollTimer = null;
let tickTimer = null;
let latestRequestId = 0;
let busy = false;

/**
 * A photo to review, or a Recently decided row, as shown on screen. Kept
 * across polls, by submission, so a note being typed and the loaded photos
 * stay put.
 *
 * @typedef {{
 *   kind: 'review' | 'decided',
 *   submission: number,
 *   label: string,
 *   el: HTMLElement,
 *   urls: string[],
 *   photos: Photo[],
 *   gone: boolean,
 *   buttons: HTMLButtonElement[],
 *   note: HTMLTextAreaElement | null,
 *   error: HTMLElement | null,
 *   status: HTMLElement | null,
 *   meta?: HTMLElement,
 *   line?: { ruling: HTMLElement, text: HTMLElement, note: HTMLElement, change: HTMLButtonElement },
 *   changePanel?: HTMLElement | null,
 * }} Card
 * @typedef {{ button: HTMLButtonElement, url: string, alt: string, state: 'loading' | 'loaded' | 'failed', objectUrl: string }} Photo
 */

/** @type {Map<number, Card>} */
const reviewCards = new Map();
/** @type {Map<number, Card>} */
const decidedRows = new Map();
/** Submissions whose ruling is being saved. */
const saving = new Set();

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
 * Calls one of this app's moderator relays with the code, reading the
 * response with `read` within the same timeout.
 *
 * @template T
 * @param {string} url
 * @param {RequestInit} init
 * @param {(response: Response) => Promise<T>} read
 * @returns {Promise<{ status: number, data: T | null, receivedAt: number }>}
 */
async function fetchRelay(url, init, read) {
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
    const data = await read(response);
    return { status: response.status, data, receivedAt };
  } catch {
    return { status: 0, data: null, receivedAt: Date.now() };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<{ status: number, body: unknown, receivedAt: number }>}
 */
async function callRelay(url, init) {
  const { status, data, receivedAt } = await fetchRelay(url, init, (response) => response.text());
  let body = null;
  try {
    body = JSON.parse(data ?? '');
  } catch {
    // Not JSON: leave body null.
  }
  return { status, body, receivedAt };
}

function fetchOverview() {
  return callRelay(`/moderator/overview?${new URLSearchParams({ session })}`, { method: 'GET' });
}

function fetchReview() {
  return callRelay(`/moderator/review?${new URLSearchParams({ session })}`, { method: 'GET' });
}

function changePhase(action) {
  return callRelay(`/moderator/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session }),
  });
}

/**
 * @param {number} submission
 * @param {'approve' | 'reject'} ruling
 * @param {string} note
 */
function postRuling(submission, ruling, note) {
  return callRelay('/moderator/ruling', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rulingBody(session, submission, ruling, note)),
  });
}

/**
 * Fetches a photo through its relay, with the code.
 *
 * @param {string} url
 * @returns {Promise<{ status: number, blob: Blob | null }>}
 */
async function fetchPhoto(url) {
  const { status, data } = await fetchRelay(url, { method: 'GET' }, (response) =>
    response.ok ? response.blob() : response.text().then(() => null),
  );
  return { status, blob: status === 200 ? /** @type {Blob | null} */ (data) : null };
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
  review = null;
  clearCards();
  if (viewer.open) {
    viewer.close();
  }
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

  const waiting = photosWaiting(overview, review);
  const banner = finishBanner(overview, waiting);
  el('all-finished').textContent = banner;
  el('all-finished').hidden = !banner;
  renderReview();

  const note = standingsNote(overview.session, waiting);
  el('standings-note').textContent = note.text;
  el('standings-note').hidden = !note.text;
  el('standings').replaceChildren(...(overview.teams ?? []).map((team) => standingItem(team, note.final)));

  renderDecided();

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

// --- the review queue and Recently decided (issue #55) -----------------------
// textContent throughout: team and checkpoint names, poses, scenes and
// notes come from the sessions file and the moderators, not code this app
// controls.

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

/**
 * Puts `elements` in `parent` in this order, moving only what's out of
 * place, so a note being typed keeps its focus across polls.
 *
 * @param {HTMLElement} parent
 * @param {HTMLElement[]} elements
 */
function placeInOrder(parent, elements) {
  elements.forEach((element, index) => {
    const at = parent.children[index] ?? null;
    if (at !== element) {
      parent.insertBefore(element, at);
    }
  });
}

/**
 * @param {'review' | 'decided'} kind
 * @param {number} submission
 * @param {string} label the team and checkpoint, for screen readers
 * @returns {Card}
 */
function newCard(kind, submission, label) {
  return {
    kind,
    submission,
    label,
    el: make('li', kind === 'review' ? 'review-item' : 'decided-item'),
    urls: [],
    photos: [],
    gone: false,
    buttons: [],
    note: null,
    error: null,
    status: null,
  };
}

/**
 * A photo, fetched with the code and shown through an object URL. Tap it
 * to see it larger.
 *
 * @param {Card} card
 * @param {string} url the relay to fetch it from
 * @param {string} alt
 * @param {string} className
 * @returns {HTMLButtonElement}
 */
function photoButton(card, url, alt, className) {
  const button = /** @type {HTMLButtonElement} */ (make('button', className));
  button.type = 'button';
  /** @type {Photo} */
  const photo = { button, url, alt, state: 'loading', objectUrl: '' };
  button.addEventListener('click', () => {
    if (photo.state === 'loaded') {
      openViewer(alt, photo.objectUrl);
    }
  });
  card.photos.push(photo);
  void loadPhoto(card, photo);
  return button;
}

/**
 * @param {Card} card
 * @param {Photo} photo
 */
async function loadPhoto(card, photo) {
  photo.state = 'loading';
  photo.button.disabled = true;
  photo.button.replaceChildren(make('span', 'photo-placeholder', 'Loading photo…'));

  const { status, blob } = await fetchPhoto(photo.url);
  if (card.gone || !card.photos.includes(photo)) {
    // Its card left the screen, or Change was closed, while the photo was
    // on its way.
    return;
  }
  if (status === 401) {
    storeCode(null);
    showSignIn(moderatorError(status, null).message);
    return;
  }
  if (!blob) {
    photo.state = 'failed';
    photo.button.replaceChildren(make('span', 'photo-placeholder', "Couldn't load the photo. Trying again…"));
    return;
  }
  photo.objectUrl = URL.createObjectURL(blob);
  card.urls.push(photo.objectUrl);
  const img = /** @type {HTMLImageElement} */ (make('img'));
  img.src = photo.objectUrl;
  img.alt = photo.alt;
  photo.state = 'loaded';
  photo.button.disabled = false;
  photo.button.replaceChildren(img);
}

/** @param {Card} card */
function retryFailedPhotos(card) {
  for (const photo of card.photos) {
    if (photo.state === 'failed') {
      void loadPhoto(card, photo);
    }
  }
}

/**
 * Takes a card off the screen, and revokes its photos' object URLs.
 *
 * @param {Card} card
 */
function disposeCard(card) {
  card.gone = true;
  revokePhotos(card);
  card.el.remove();
}

/** @param {Card} card */
function revokePhotos(card) {
  for (const url of card.urls) {
    URL.revokeObjectURL(url);
  }
  card.urls = [];
  card.photos = [];
}

function clearCards() {
  for (const cards of [reviewCards, decidedRows]) {
    for (const card of cards.values()) {
      disposeCard(card);
    }
    cards.clear();
  }
  saving.clear();
}

/**
 * @param {string} title
 * @param {string} objectUrl
 */
function openViewer(title, objectUrl) {
  el('viewer-title').textContent = title;
  const img = /** @type {HTMLImageElement} */ (el('viewer-image'));
  img.src = objectUrl;
  img.alt = title;
  viewer.showModal();
}

viewer.addEventListener('close', () => {
  el('viewer-image').removeAttribute('src');
});

/**
 * The note and the Approve and Reject buttons. No confirmation: a ruling
 * can be changed from Recently decided.
 *
 * @param {Card} card
 * @param {string} note the note to start from
 * @returns {HTMLElement}
 */
function rulingControls(card, note) {
  const wrap = make('div', 'ruling');
  const noteId = `note-${card.kind}-${card.submission}`;
  const label = make('label', 'field-label', 'Note (optional, for the record)');
  label.setAttribute('for', noteId);
  const textarea = /** @type {HTMLTextAreaElement} */ (make('textarea', 'ruling-note'));
  textarea.id = noteId;
  textarea.rows = 2;
  textarea.maxLength = NOTE_MAX_LENGTH;
  textarea.autocomplete = 'off';
  textarea.value = note;

  const actions = make('div', 'ruling-actions');
  /** @type {HTMLButtonElement[]} */
  const buttons = [];
  for (const [ruling, text, className] of /** @type {const} */ ([
    ['approve', 'Approve', 'ruling-approve'],
    ['reject', 'Reject', 'button-danger ruling-reject'],
  ])) {
    const button = /** @type {HTMLButtonElement} */ (make('button', className, text));
    button.type = 'button';
    button.setAttribute('aria-label', `${text}: ${card.label}`);
    button.addEventListener('click', () => void decide(card, ruling));
    buttons.push(button);
  }
  actions.append(...buttons);

  const status = make('p', 'note ruling-status');
  status.setAttribute('role', 'status');
  const error = make('p', 'message message--error');
  error.setAttribute('role', 'alert');
  error.hidden = true;

  card.buttons = buttons;
  card.note = textarea;
  card.status = status;
  card.error = error;
  wrap.append(label, textarea, actions, status, error);
  return wrap;
}

/** @param {Card} card */
function showSaving(card) {
  const isSaving = saving.has(card.submission);
  for (const button of card.buttons) {
    button.disabled = isSaving;
  }
  if (card.status) {
    card.status.textContent = isSaving ? 'Saving…' : '';
  }
}

/**
 * Approves or rejects a photo, then refreshes: the photo moves from To
 * review to Recently decided.
 *
 * @param {Card} card
 * @param {'approve' | 'reject'} ruling
 */
async function decide(card, ruling) {
  if (saving.has(card.submission)) {
    return;
  }
  saving.add(card.submission);
  if (card.error) {
    card.error.hidden = true;
  }
  showSaving(card);

  const { status, body } = await postRuling(card.submission, ruling, card.note?.value ?? '');
  // 201 for a first ruling, 200 for a changed one: either way it's saved.
  if (status === 200 || status === 201) {
    if (card.kind === 'decided') {
      closeChange(card);
    }
    await refresh();
    saving.delete(card.submission);
    showSaving(card);
    return;
  }

  saving.delete(card.submission);
  showSaving(card);
  const error = moderatorError(status, body);
  if (error.askForCode) {
    storeCode(null);
    showSignIn(error.message);
    return;
  }
  if (card.error && !card.gone) {
    card.error.textContent = error.message;
    card.error.hidden = false;
  }
}

/**
 * @param {import('./moderator-logic.js').ReviewItem} item
 * @returns {Card}
 */
function createReviewCard(item) {
  const head = reviewItemHead(item, serverNow());
  const card = newCard('review', item.submission, [head.team, head.checkpoint].filter(Boolean).join(', '));

  const title = make('h3', 'review-head');
  title.append(make('span', 'review-team', head.team), make('span', 'review-checkpoint', head.checkpoint));
  const meta = make('p', 'review-meta');
  card.meta = meta;

  const photo = photoButton(
    card,
    `/moderator/photo?${new URLSearchParams({ session, submission: String(item.submission) })}`,
    `${head.team}'s photo at ${head.checkpoint}`,
    'photo-button review-photo',
  );
  card.el.append(title, meta, photo);

  const positions = referencePositions(item);
  if (positions.length > 0) {
    const references = make('div', 'reference-photos');
    references.append(make('p', 'reference-label', 'Reference photos, tap to enlarge'));
    const thumbs = make('div', 'reference-thumbs');
    for (const position of positions) {
      const query = new URLSearchParams({
        session,
        checkpoint: String(item.checkpoint.sequence),
        position: String(position),
      });
      thumbs.append(
        photoButton(
          card,
          `/moderator/reference-photo?${query}`,
          `Reference photo ${position + 1} of ${positions.length} for ${head.checkpoint}`,
          'photo-button reference-thumb',
        ),
      );
    }
    references.append(thumbs);
    card.el.append(references);
  }

  const { asked, place } = askedFor(item);
  const askedList = make('dl', 'review-asked');
  askedList.append(make('dt', '', 'Asked:'), make('dd', '', asked), make('dt', '', 'Place:'), make('dd', '', place));
  card.el.append(askedList);

  const { checks, otherPassed, referee } = reviewChecks(item);
  if (checks.length > 0) {
    const list = make('ul', 'verdict-checks review-checks');
    for (const check of checks) {
      const li = make('li', `check--${check.outcome}`, check.text);
      if (check.detail) {
        li.append(make('span', 'check-reason', check.detail));
      }
      list.append(li);
    }
    card.el.append(list);
  }
  if (referee) {
    card.el.append(make('p', 'message message--note review-referee', referee));
  }
  const others = otherChecksLine(otherPassed);
  if (others) {
    card.el.append(make('p', 'note review-others', others));
  }

  card.el.append(rulingControls(card, ''));
  return card;
}

function renderReview() {
  const items = toReviewOldestFirst(review);
  const now = serverNow();
  const onScreen = new Set(items.map((item) => item.submission));
  for (const [submission, card] of reviewCards) {
    if (!onScreen.has(submission)) {
      disposeCard(card);
      reviewCards.delete(submission);
    }
  }

  const elements = items.map((item) => {
    let card = reviewCards.get(item.submission);
    if (!card) {
      card = createReviewCard(item);
      reviewCards.set(item.submission, card);
    } else {
      retryFailedPhotos(card);
    }
    if (card.meta) {
      card.meta.textContent = reviewItemHead(item, now).meta;
    }
    showSaving(card);
    return card.el;
  });
  placeInOrder(reviewQueueEl, elements);

  el('review-title').textContent = reviewHeading(items.length);
  el('review-panel').hidden = items.length === 0;
}

/**
 * @param {import('./moderator-logic.js').RecentRuling} recent
 * @returns {Card}
 */
function createDecidedRow(recent) {
  const label = [recent.team, checkpointLabel(recent.checkpoint)].filter(Boolean).join(', ');
  const card = newCard('decided', recent.submission, label);

  const line = make('div', 'decided-line');
  const ruling = make('span', 'decided-ruling');
  const words = make('span', 'decided-text');
  const change = /** @type {HTMLButtonElement} */ (make('button', 'button-secondary decided-change', 'Change'));
  change.type = 'button';
  change.addEventListener('click', () => openChange(card, recent));
  line.append(ruling, words, change);
  const note = make('p', 'decided-note');
  card.line = { ruling, text: words, note, change };
  card.changePanel = null;
  card.el.append(line, note);
  return card;
}

/**
 * Change: the photo again, the note so far, and Approve and Reject.
 *
 * @param {Card} card
 * @param {import('./moderator-logic.js').RecentRuling} recent
 */
function openChange(card, recent) {
  if (card.changePanel || !card.line) {
    return;
  }
  const panel = make('div', 'change-panel');
  panel.append(
    photoButton(
      card,
      `/moderator/photo?${new URLSearchParams({ session, submission: String(recent.submission) })}`,
      `${card.label}: the photo`,
      'photo-button review-photo',
    ),
    rulingControls(card, typeof recent.note === 'string' ? recent.note : ''),
  );
  const cancel = /** @type {HTMLButtonElement} */ (make('button', 'button-secondary', 'Cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', () => closeChange(card));
  panel.append(cancel);

  card.changePanel = panel;
  card.line.change.hidden = true;
  card.el.append(panel);
  card.note?.focus();
}

/** @param {Card} card */
function closeChange(card) {
  revokePhotos(card);
  card.changePanel?.remove();
  card.changePanel = null;
  card.buttons = [];
  card.note = null;
  card.status = null;
  card.error = null;
  if (card.line) {
    card.line.change.hidden = false;
  }
}

function renderDecided() {
  const recent = recentNewestFirst(review);
  const now = serverNow();
  const onScreen = new Set(recent.map((entry) => entry.submission));
  for (const [submission, card] of decidedRows) {
    if (!onScreen.has(submission)) {
      disposeCard(card);
      decidedRows.delete(submission);
    }
  }

  const elements = recent.map((entry) => {
    let card = decidedRows.get(entry.submission);
    if (!card) {
      card = createDecidedRow(entry);
      decidedRows.set(entry.submission, card);
    } else {
      retryFailedPhotos(card);
    }
    const line = recentLine(entry, now);
    if (card.line) {
      card.line.ruling.textContent = line.ruling;
      card.line.ruling.className = `decided-ruling decided-ruling--${entry.ruling}`;
      card.line.text.textContent = line.text;
      card.line.note.textContent = line.note;
      card.line.note.hidden = !line.note;
      card.line.change.setAttribute('aria-label', `Change: ${card.label}`);
    }
    showSaving(card);
    return card.el;
  });
  placeInOrder(decidedEl, elements);

  el('decided-panel').hidden = recent.length === 0;
}

// --- polling -----------------------------------------------------------------

async function refresh() {
  const requestId = ++latestRequestId;
  // The review queue is refreshed with the overview.
  const [{ status, body, receivedAt }, reviewed] = await Promise.all([fetchOverview(), fetchReview()]);
  if (requestId !== latestRequestId) {
    return;
  }

  if (status === 200 && body && typeof body === 'object') {
    overview = /** @type {import('./moderator-logic.js').Overview} */ (body);
    clockOffsetMs = overviewClockOffset(overview, receivedAt);
    const reviewOk = reviewed.status === 200 && reviewed.body && typeof reviewed.body === 'object';
    if (reviewOk) {
      review = /** @type {import('./moderator-logic.js').Review} */ (reviewed.body);
    }
    const reviewError = reviewOk ? null : moderatorError(reviewed.status, reviewed.body);
    if (reviewError?.askForCode) {
      storeCode(null);
      showSignIn(reviewError.message);
      return;
    }
    // Keep showing the last review queue; say what's wrong and keep trying.
    setConnection(reviewError ? reviewError.message : '');
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
  const text = confirmFinishText(photosWaiting(overview, review));
  if (!busy && (await confirmAction('Finish the session now?', text, 'Finish session now', true))) {
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
