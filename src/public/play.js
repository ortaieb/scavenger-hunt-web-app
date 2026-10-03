// DOM wiring for the participant app at /play (issue #40). Everything the
// page decides lives in game-logic.js; this file only reads and writes the
// DOM, storage and the browser's permission prompts, and polls /state.
//
// The screen is always recomputed from what's stored (the team's identity,
// whether permissions were granted once) and the latest GET /state, so a
// reload, a locked screen or lost signal always lands back on the right one.

import * as api from './api.js';
import {
  clockOffsetFromState,
  clueLineFor,
  formatPlannedTime,
  identityFromJoin,
  instructionFor,
  normaliseTeamCode,
  pointsLabel,
  pointsSheetFor,
  progressLabel,
  readIdentity,
  screenFor,
  screenForError,
  showsStatusBar,
  teamLabel,
  timeLeftFor,
} from './game-logic.js';

const IDENTITY_STORAGE_KEY = 'scavenger-hunt.identity';
const PERMISSIONS_STORAGE_KEY = 'scavenger-hunt.permissionsGranted';
const LOBBY_POLL_MS = 10000;
const LOCATION_TIMEOUT_MS = 15000;
const COUNTDOWN_TICK_MS = 1000;

const SCREENS = ['join', 'permissions', 'loading', 'lobby', 'playing', 'finished', 'ended'];
// Screens that wait on the server, so keep asking it: the lobby for the
// start, and the clue so the countdown re-syncs and a stop is noticed.
const POLLING_SCREENS = new Set(['loading', 'lobby', 'playing']);

const el = (id) => document.getElementById(id);

const menuEl = el('menu');
const menuTeamEl = el('menu-team');
const leaveBtn = el('leave');
const leaveConfirmBtn = el('leave-confirm');
const joinForm = el('join-form');
const teamCodeInput = el('team-code');
const consentInput = el('consent');
const joinBtn = el('join-button');
const joinErrorEl = el('join-error');
const permissionsBtn = el('permissions-button');
const permissionsAskEl = el('permissions-ask');
const permissionsDeniedEl = el('permissions-denied');
const permissionsDeniedWhatEl = el('permissions-denied-what');
const connectionEl = el('connection');
const statusBarEl = el('status-bar');
const sbTeamEl = el('sb-team');
const sbProgressEl = el('sb-progress');
const sbPointsBtn = el('sb-points');
const sbTimeEl = el('sb-time');
const sbTimeTextEl = el('sb-time-text');
const sbTimeWordsEl = el('sb-time-words');
const sbClueBtn = el('sb-clue');
const sbClueTextEl = el('sb-clue-text');
const sbPhaseEl = el('sb-phase');
const pointsSheetEl = el('points-sheet');
const pointsSheetTitleEl = el('points-sheet-title');
const pointsSheetLinesEl = el('points-sheet-lines');

/** @type {import('./game-logic.js').AppState} */
const appState = {
  identity: readIdentity(loadStored(IDENTITY_STORAGE_KEY)),
  permissions: loadStored(PERMISSIONS_STORAGE_KEY) === true ? 'granted' : 'unknown',
  state: null,
  offline: false,
};

let pollTimer = null;
let latestStateRequestId = 0;

// Server time minus the phone's time, re-synced on every state response, so
// the countdown follows the server's clock rather than the phone's.
let clockOffsetMs = 0;
let countdownTimer = null;

// --- storage ---------------------------------------------------------------
// Private browsing can make localStorage throw, or come back empty: the page
// must still work for this visit, it just won't survive a reload.

function loadStored(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Nothing to do: see above.
  }
}

// --- rendering -------------------------------------------------------------

function render() {
  const screen = screenFor(appState);

  for (const name of SCREENS) {
    el(`screen-${name}`).hidden = name !== screen;
  }
  const instruction = instructionFor(appState);
  for (const line of el(`screen-${screen}`).querySelectorAll('[data-instruction]')) {
    line.textContent = instruction;
  }

  menuEl.hidden = !appState.identity;
  if (!appState.identity) {
    menuEl.open = false;
  }
  menuTeamEl.textContent = appState.identity ? `Team: ${appState.identity.team}` : '';

  connectionEl.hidden = !appState.offline || screen === 'join';
  connectionEl.textContent = appState.offline ? instruction : '';

  renderStatusBar(screen);
  if (screen === 'permissions') {
    renderPermissions();
  }
  if (screen === 'lobby') {
    renderLobby();
  }
  if (screen === 'playing') {
    el('playing-clue').textContent = appState.state?.current?.clue ?? '';
  }

  schedulePolling(screen);
}

function renderStatusBar(screen) {
  const shown = showsStatusBar(screen);
  statusBarEl.hidden = !shown;
  if (!shown) {
    stopCountdown();
    return;
  }

  const state = appState.state;
  sbTeamEl.textContent = teamLabel(state?.team ?? appState.identity?.team);
  sbTeamEl.title = state?.team ?? appState.identity?.team ?? '';
  const progress = progressLabel(state);
  sbProgressEl.textContent = progress;
  sbProgressEl.parentElement.hidden = !progress;
  sbProgressEl.parentElement.setAttribute('aria-label', progress ? `Checkpoints: ${progress}` : '');

  const points = pointsLabel(state?.score);
  sbPointsBtn.hidden = !points;
  if (points) {
    sbPointsBtn.textContent = points.text;
    sbPointsBtn.setAttribute(
      'aria-label',
      `${points.final ? 'Final points' : 'Points'}: ${points.text.replace(' •', '')}` +
        `${points.inReview ? ', a photo is in review' : ''}. Lowest wins. Tap for how scoring works.`,
    );
  }

  const clueLine = clueLineFor(appState);
  if (clueLine.isClue) {
    if (sbClueTextEl.textContent !== clueLine.text) {
      // A new clue starts collapsed to one line.
      sbClueBtn.setAttribute('aria-expanded', 'false');
    }
    sbClueTextEl.textContent = clueLine.text;
  }
  sbClueBtn.hidden = clueLine.hidden || !clueLine.isClue;
  sbPhaseEl.textContent = clueLine.isClue ? '' : clueLine.text;
  sbPhaseEl.hidden = clueLine.hidden || clueLine.isClue;

  renderTimeLeft();
  startCountdown();
}

function renderTimeLeft() {
  const time = timeLeftFor(appState, Date.now() + clockOffsetMs);
  sbTimeEl.hidden = time.level === 'none';
  sbTimeEl.className = `sb-time sb-time--${time.level}`;
  sbTimeTextEl.textContent = time.text;
  sbTimeWordsEl.textContent = time.words;
  sbTimeWordsEl.hidden = !time.words;
  sbTimeEl.setAttribute(
    'aria-label',
    time.level === 'normal' || time.level === 'amber' || time.level === 'red'
      ? `Time left: ${time.text}${time.words ? `, ${time.words}` : ''}`
      : time.text,
  );
}

// Ticks every second while the status bar shows; reaching zero ends
// nothing (only the moderator's stop does, and the next poll picks it up).
function startCountdown() {
  if (countdownTimer === null && document.visibilityState === 'visible') {
    countdownTimer = setInterval(renderTimeLeft, COUNTDOWN_TICK_MS);
  }
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

sbClueBtn.addEventListener('click', () => {
  const expanded = sbClueBtn.getAttribute('aria-expanded') === 'true';
  sbClueBtn.setAttribute('aria-expanded', String(!expanded));
});

sbPointsBtn.addEventListener('click', () => {
  const sheet = pointsSheetFor(appState.state?.score);
  pointsSheetTitleEl.textContent = sheet.title;
  pointsSheetLinesEl.replaceChildren(
    ...sheet.lines.map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }),
  );
  pointsSheetEl.showModal();
});

function renderPermissions() {
  const denied = appState.permissions === 'denied';
  permissionsAskEl.hidden = denied;
  permissionsDeniedEl.hidden = !denied;
  permissionsBtn.textContent = denied ? 'Try again' : 'Allow';
}

function renderLobby() {
  const session = appState.identity?.session ?? {};
  el('lobby-team').textContent = appState.state?.team ?? appState.identity?.team ?? '';
  el('lobby-session').textContent = session.name ?? '';
  el('lobby-area').textContent = session.location ?? '';
  el('lobby-start').textContent = formatPlannedTime(session['start-time']) || 'Not set';
}

// --- join ------------------------------------------------------------------

function updateJoinButton() {
  // consent is only ever the player's own tick (the box starts unticked),
  // so Join stays disabled until it's ticked.
  joinBtn.disabled = normaliseTeamCode(teamCodeInput.value) === '' || !consentInput.checked;
}

function showJoinError(message) {
  joinErrorEl.textContent = message;
  joinErrorEl.hidden = !message;
}

teamCodeInput.addEventListener('input', () => {
  // Upper-case as they type, keeping the caret where it was.
  const { selectionStart, selectionEnd } = teamCodeInput;
  teamCodeInput.value = teamCodeInput.value.toUpperCase();
  teamCodeInput.setSelectionRange(selectionStart, selectionEnd);
  showJoinError('');
  updateJoinButton();
});

consentInput.addEventListener('change', updateJoinButton);

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = normaliseTeamCode(teamCodeInput.value);
  if (!code || !consentInput.checked) {
    return;
  }

  joinBtn.disabled = true;
  joinBtn.textContent = 'Joining…';
  showJoinError('');

  const { status, body } = await api.join(code, true);

  joinBtn.textContent = 'Join';
  updateJoinButton();

  const identity = status === 200 || status === 201 ? identityFromJoin(body) : null;
  if (!identity) {
    showJoinError(
      status === 200 || status === 201
        ? 'Something went wrong. Please try again.'
        : screenForError(status, body).message,
    );
    return;
  }

  appState.identity = identity;
  appState.state = null;
  appState.offline = false;
  store(IDENTITY_STORAGE_KEY, identity);
  teamCodeInput.value = '';
  consentInput.checked = false;
  updateJoinButton();

  render();
  void refreshState();
});

// --- permissions -----------------------------------------------------------
// Asked on one tap, after the screen has explained why: the camera first,
// then location. Granted once is remembered; the browser itself remembers
// the actual grant.

permissionsBtn.addEventListener('click', async () => {
  permissionsBtn.disabled = true;
  permissionsBtn.textContent = 'Waiting for your answer…';

  const camera = await requestCamera();
  const location = camera === 'granted' ? await requestLocation() : 'skipped';

  permissionsBtn.disabled = false;

  if (camera === 'granted' && location === 'granted') {
    appState.permissions = 'granted';
    store(PERMISSIONS_STORAGE_KEY, true);
    render();
    void refreshState();
    return;
  }

  appState.permissions = 'denied';
  permissionsDeniedWhatEl.textContent =
    camera !== 'granted'
      ? camera === 'unsupported'
        ? "This browser can't use the camera. Open the link in Safari (iPhone) or Chrome (Android)."
        : 'The camera is blocked for this site.'
      : location === 'unsupported'
        ? "This browser can't share your location. Open the link in Safari (iPhone) or Chrome (Android)."
        : 'Location is blocked for this site.';
  render();
});

/** @returns {Promise<'granted' | 'denied' | 'unsupported'>} */
async function requestCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'unsupported';
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    // Only asking for permission here: release the camera straight away.
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return 'granted';
  } catch (err) {
    // NotFoundError etc. (no camera at all) is still a camera problem the
    // player has to sort out, so it's shown the same way.
    return err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'unsupported';
  }
}

/** @returns {Promise<'granted' | 'denied' | 'unsupported'>} */
function requestLocation() {
  if (!navigator.geolocation) {
    return Promise.resolve('unsupported');
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve('granted'),
      (error) => {
        // Only an actual refusal counts as denied: no fix yet (indoors, a
        // timeout) still means permission was given.
        resolve(error.code === error.PERMISSION_DENIED ? 'denied' : 'granted');
      },
      { enableHighAccuracy: false, timeout: LOCATION_TIMEOUT_MS, maximumAge: 60000 },
    );
  });
}

// --- state and polling -----------------------------------------------------

async function refreshState() {
  const identity = appState.identity;
  if (!identity || appState.permissions !== 'granted') {
    return;
  }

  const requestId = ++latestStateRequestId;
  const { status, body, receivedAt } = await api.fetchState(identity.session.id, identity.participant);
  // Ignore a slow answer that a newer request (or Leave) has overtaken.
  if (requestId !== latestStateRequestId || appState.identity !== identity) {
    return;
  }

  if (status === 200 && body && typeof body === 'object') {
    appState.state = /** @type {import('./game-logic.js').GameState} */ (body);
    appState.offline = false;
    clockOffsetMs = clockOffsetFromState(appState.state, receivedAt);
    render();
    return;
  }

  const outcome = screenForError(status, body);
  if (outcome.forgetIdentity) {
    forgetIdentity();
    showJoinError(outcome.message);
    render();
    return;
  }
  // Keep showing the last known screen; just say we're offline (or what
  // went wrong), and keep polling.
  appState.offline = true;
  render();
  if (status !== 0 && status !== 502 && status !== 503 && status !== 504) {
    connectionEl.textContent = outcome.message;
  }
}

function schedulePolling(screen) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.visibilityState !== 'visible' || !appState.identity || appState.permissions !== 'granted') {
    return;
  }
  // Keep retrying when offline, whatever the screen, so it recovers.
  if (POLLING_SCREENS.has(screen) || appState.offline) {
    pollTimer = setTimeout(() => void refreshState(), LOBBY_POLL_MS);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void refreshState();
  } else {
    // Stop polling and the countdown while hidden; both restart on return.
    clearTimeout(pollTimer);
    pollTimer = null;
    stopCountdown();
  }
});

window.addEventListener('online', () => void refreshState());

// --- leave -----------------------------------------------------------------

function forgetIdentity() {
  appState.identity = null;
  appState.state = null;
  appState.offline = false;
  latestStateRequestId++;
  store(IDENTITY_STORAGE_KEY, null);
}

leaveBtn.addEventListener('click', () => {
  // Two taps rather than a browser confirm(): leaving means re-entering
  // the team code, so make it deliberate.
  leaveBtn.hidden = true;
  leaveConfirmBtn.hidden = false;
});

leaveConfirmBtn.addEventListener('click', () => {
  forgetIdentity();
  leaveBtn.hidden = false;
  leaveConfirmBtn.hidden = true;
  showJoinError('');
  render();
});

menuEl.addEventListener('toggle', () => {
  if (!menuEl.open) {
    leaveBtn.hidden = false;
    leaveConfirmBtn.hidden = true;
  }
});

// --- start -----------------------------------------------------------------

updateJoinButton();
render();
void refreshState();
