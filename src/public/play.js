// DOM wiring for the participant app at /play (issue #40). Everything the
// page decides lives in game-logic.js; this file only reads and writes the
// DOM, storage, the camera and the browser's permission prompts, and polls
// /state.
//
// The screen is always recomputed from what's stored (the team's identity,
// whether permissions were granted once) and the latest GET /state, so a
// reload, a locked screen or lost signal always lands back on the right one.

import * as api from './api.js';
import { checkProximity, createCamera, deviceHasMultipleCameras, getPosition, loadFacingMode, storeFacingMode } from './camera.js';
import { describeAccuracyHint } from './challenge-logic.js';
import {
  checkpointAfterArrive,
  checkpointAfterPhoto,
  checkpointAfterRetake,
  checkpointAfterVerdict,
  checkpointSending,
  clockOffsetFromState,
  finishedSummary,
  sessionOverSummary,
  sessionRejectionFor,
  stateAfterError,
  codeExpired,
  codeTimeLeft,
  clueLineFor,
  formatPlannedTime,
  identityFromJoin,
  instructionFor,
  normaliseTeamCode,
  pollIntervalFor,
  pointsLabel,
  pointsSheetFor,
  progressLabel,
  readIdentity,
  screenFor,
  screenForError,
  showsStatusBar,
  teamLabel,
  timeLeftFor,
  verdictHeading,
} from './game-logic.js';

const IDENTITY_STORAGE_KEY = 'scavenger-hunt.identity';
const PERMISSIONS_STORAGE_KEY = 'scavenger-hunt.permissionsGranted';
const OFFLINE_RETRY_MS = 10000;
const LOCATION_TIMEOUT_MS = 15000;
const COUNTDOWN_TICK_MS = 1000;

const SCREENS = [
  'join',
  'permissions',
  'loading',
  'lobby',
  'clue',
  'capture',
  'review',
  'checking',
  'verdict',
  'finished',
  'ended',
];
const CHECK_CLASS = { '✓': 'passed', '✗': 'failed', '?': 'uncertain' };

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
const connectionTextEl = el('connection-text');
const connectionRetryBtn = el('connection-retry');
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
  checkpoint: null,
  offline: false,
};

let pollTimer = null;
let latestStateRequestId = 0;
// What the connection banner says while `appState.offline` (a lost
// connection, or an error the player can retry).
let connectionMessage = '';

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
  connectionTextEl.textContent = appState.offline ? connectionMessage || instruction : '';

  if (screen === 'ended') {
    // A photo in progress is dropped once the session is over.
    appState.checkpoint = null;
    clearPhoto();
  }

  renderStatusBar(screen);
  if (screen === 'permissions') {
    renderPermissions();
  }
  if (screen === 'lobby') {
    renderLobby();
  }
  if (screen === 'clue') {
    renderClue();
  }
  if (screen === 'capture') {
    renderCapture();
  }
  if (screen === 'review') {
    renderReview();
  }
  if (screen === 'verdict') {
    renderVerdict();
  }
  if (screen === 'finished') {
    renderSummary('finished', finishedSummary(appState.state));
  }
  if (screen === 'ended') {
    renderSummary('ended', sessionOverSummary(appState.state));
  }
  syncCamera(screen);

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
    countdownTimer = setInterval(tick, COUNTDOWN_TICK_MS);
  }
}

function tick() {
  renderTimeLeft();
  renderCodeTimeLeft();
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

function renderSummary(screen, summary) {
  if (screen === 'finished') {
    el('finished-title').textContent = summary.title;
  }
  el(`${screen}-lines`).replaceChildren(
    ...summary.lines.map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }),
  );
}

/** Shows the connection banner, over any screen, until the next good answer. */
function goOffline(message) {
  appState.offline = true;
  connectionMessage = message;
}

connectionRetryBtn.addEventListener('click', () => {
  connectionRetryBtn.disabled = true;
  void refreshState().finally(() => {
    connectionRetryBtn.disabled = false;
  });
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
    connectionMessage = '';
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
  goOffline(outcome.offline ? '' : outcome.message);
  render();
}

function schedulePolling(screen) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.visibilityState !== 'visible' || !appState.identity || appState.permissions !== 'granted') {
    return;
  }
  // Keep retrying when offline, whatever the screen, so it recovers.
  const interval = appState.offline ? OFFLINE_RETRY_MS : pollIntervalFor(screen, appState.state);
  if (interval > 0) {
    pollTimer = setTimeout(() => void refreshState(), interval);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Restarts the camera (if on Capture) and the countdown straight away.
    render();
    void refreshState();
  } else {
    // Stop polling, the countdown and the camera while hidden; all restart
    // on return (iOS releases the camera anyway).
    clearTimeout(pollTimer);
    pollTimer = null;
    stopCountdown();
    camera.stop();
  }
});

window.addEventListener('online', () => void refreshState());

// --- playing a checkpoint (issue #42) --------------------------------------
// Clue → (I'm here) → Capture → (Take photo) → Review → (Send) → Checking →
// Verdict → (Next clue | Try again). Progress within a checkpoint lives in
// memory only: after a reload the team is back on the Clue, and "I'm here"
// issues a fresh code.

const camera = createCamera(el('preview'));
const snapshotCanvas = el('snapshot');
const arriveBtn = el('arrive-button');
const captureBtn = el('capture-button');
const cameraSwitchBtn = el('camera-switch');
const retakeBtn = el('retake-button');
const sendBtn = el('send-button');
const verdictBtn = el('verdict-button');

let facingMode = loadFacingMode();
let cameraStarting = false;
/** @type {Blob | null} */
let photoBlob = null;
let photoUrl = '';
/** @type {GeolocationPosition | null} */
let photoPosition = null;
let photoHint = '';
let codeRefresh = null;
let busy = false;
let proximityCheckedFor = '';

function showMessage(id, message) {
  el(id).textContent = message;
  el(id).hidden = !message;
}

function serverNow() {
  return Date.now() + clockOffsetMs;
}

function identityFor(sequence) {
  const identity = appState.identity;
  return { session: identity.session.id, participant: identity.participant, checkpoint: sequence };
}

function renderClue() {
  const current = appState.state?.current;
  el('clue-text').textContent = current?.clue ?? '';
  const closed = current?.open === false;
  // Disabled, with the reason, while the checkpoint isn't open.
  el('clue-closed').hidden = !closed;
  arriveBtn.disabled = closed || busy;
  arriveBtn.textContent = busy ? 'Checking in…' : "I'm here";
}

function renderCapture() {
  const code = appState.checkpoint?.code;
  el('code-value').textContent = code?.value ?? '';
  el('pose-text').textContent = code?.pose ?? '';
  el('pose-text').hidden = !code?.pose;
  renderCodeTimeLeft();
  maybeCheckProximity();
}

function renderCodeTimeLeft() {
  const checkpoint = appState.checkpoint;
  if (!checkpoint?.code) {
    return;
  }
  el('code-time-left').textContent = codeTimeLeft(checkpoint, serverNow());
  const screen = screenFor(appState);
  // The code isn't checked yet, but an expired one is quietly swapped for a
  // fresh one, keeping the photo.
  if ((screen === 'capture' || screen === 'review') && codeExpired(checkpoint, serverNow())) {
    void refreshCode();
  }
}

function renderReview() {
  el('photo-preview').src = photoUrl;
  showMessage('review-hint', photoHint);
  showMessage('review-error', appState.checkpoint?.message ?? '');
  el('location-status').textContent = photoPosition
    ? `Location recorded (±${Math.round(photoPosition.coords.accuracy)} m).`
    : 'Getting your location…';
  retakeBtn.disabled = busy;
  sendBtn.disabled = busy || !photoBlob;
  sendBtn.textContent = busy ? 'Sending…' : 'Send';
}

function renderVerdict() {
  const checkpoint = appState.checkpoint;
  const display = checkpoint?.display;
  el('verdict-heading').textContent = verdictHeading(checkpoint);
  el('verdict-message').textContent = display?.message ?? '';
  el('verdict-checks').replaceChildren(
    ...(display?.checklist ?? []).map((item) => {
      const li = document.createElement('li');
      li.className = `check--${CHECK_CLASS[item.icon] ?? 'uncertain'}`;
      // textContent, never innerHTML: reasons are server-written.
      li.textContent = `${item.icon} ${item.label}`;
      if (item.reason) {
        const reason = document.createElement('span');
        reason.className = 'check-reason';
        reason.textContent = item.reason;
        li.append(reason);
      }
      return li;
    }),
  );
  const points = pointsLabel(appState.state?.score);
  el('verdict-points').textContent = points ? `Your points now: ${points.text}. Lowest wins.` : '';
  el('verdict-points').hidden = !points;
  verdictBtn.disabled = busy;
  verdictBtn.textContent = checkpoint?.verdict === 'failed' ? (busy ? 'Getting a new code…' : 'Try again') : 'Next clue';
}

// The camera runs only on Capture, and only while the page is visible.
function syncCamera(screen) {
  const wanted = screen === 'capture' && document.visibilityState === 'visible';
  if (!wanted) {
    if (camera.active || cameraStarting) {
      camera.stop();
      cameraStarting = false;
    }
    captureBtn.disabled = true;
    return;
  }
  if (!camera.active && !cameraStarting) {
    void startCamera();
  }
}

async function startCamera() {
  cameraStarting = true;
  captureBtn.disabled = true;
  showMessage('capture-problem', '');
  const result = await camera.start(facingMode);
  cameraStarting = false;
  if (!result.ok) {
    if (!result.superseded) {
      showMessage('capture-problem', result.message);
    }
    return;
  }
  captureBtn.disabled = false;
  cameraSwitchBtn.hidden = !(await deviceHasMultipleCameras());
}

cameraSwitchBtn.addEventListener('click', () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  storeFacingMode(facingMode);
  void startCamera();
});

// The advisory "you may be outside the area" note: once per code, never
// blocking anything.
function maybeCheckProximity() {
  const checkpoint = appState.checkpoint;
  const key = `${checkpoint?.sequence}:${checkpoint?.code?.value}`;
  if (!checkpoint?.sequence || proximityCheckedFor === key) {
    return;
  }
  proximityCheckedFor = key;
  showMessage('proximity-note', '');
  getPosition()
    .then((position) => checkProximity(identityFor(checkpoint.sequence), position))
    .then(
      (warning) => {
        if (proximityCheckedFor === key) {
          showMessage('proximity-note', warning);
        }
      },
      () => {
        // No fix yet: say nothing; the photo's own fix is taken on Review.
      },
    );
}

async function arriveAt(sequence) {
  const identity = identityFor(sequence);
  const result = await api.arrive(identity.session, identity.participant, sequence);
  return checkpointAfterArrive(appState.checkpoint, sequence, result.status, result.body);
}

/**
 * Takes the player where a refused call's `code` says (issue #43): straight
 * away from the last known state, then confirmed by a fresh GET /state.
 *
 * @param {import('./game-logic.js').ErrorOutcome} error
 * @param {string} messageId where to show a message for an outcome that stays put
 */
async function applyError(error, messageId) {
  if (error.forgetIdentity) {
    forgetIdentity();
    showJoinError(error.message);
    render();
    return;
  }
  if (error.offline) {
    goOffline('');
  } else if (error.screen === 'clue') {
    showMessage('clue-error', error.message);
  } else if (error.screen === null) {
    showMessage(messageId, error.message);
  }
  if (error.screen !== null) {
    // Progress on this checkpoint no longer applies.
    appState.checkpoint = null;
    clearPhoto();
  }
  appState.state = stateAfterError(appState.state, error);
  render();
  if (error.reload) {
    await refreshState();
  }
}

arriveBtn.addEventListener('click', async () => {
  const sequence = appState.state?.current?.sequence;
  if (busy || typeof sequence !== 'number') {
    return;
  }
  busy = true;
  showMessage('clue-error', '');
  render();
  const { checkpoint, error } = await arriveAt(sequence);
  busy = false;
  if (error) {
    render();
    await applyError(error, 'clue-error');
    return;
  }
  appState.checkpoint = checkpoint;
  render();
});

/** Swaps an expired code for a fresh one, staying on the same screen. */
function refreshCode() {
  const sequence = appState.checkpoint?.sequence;
  if (codeRefresh || typeof sequence !== 'number') {
    return codeRefresh ?? Promise.resolve();
  }
  codeRefresh = arriveAt(sequence)
    .then(({ checkpoint, error }) => {
      if (!error && appState.checkpoint?.sequence === sequence) {
        // Keep what's in memory (the photo, a message); only the code changes.
        appState.checkpoint = { ...appState.checkpoint, code: checkpoint.code };
        render();
      }
    })
    .finally(() => {
      codeRefresh = null;
    });
  return codeRefresh;
}

captureBtn.addEventListener('click', async () => {
  const checkpoint = appState.checkpoint;
  if (!checkpoint || !camera.active) {
    return;
  }
  const blob = await camera.capture(snapshotCanvas);
  if (!blob) {
    showMessage('capture-problem', 'The camera isn\'t ready yet. Wait a moment, then tap Take photo again.');
    return;
  }
  clearPhoto();
  photoBlob = blob;
  photoUrl = URL.createObjectURL(blob);
  appState.checkpoint = checkpointAfterPhoto(checkpoint);
  render();
  void locatePhoto();
});

/** The fix sent with the photo, taken when the photo is. */
async function locatePhoto() {
  const blob = photoBlob;
  try {
    const position = await getPosition();
    if (photoBlob !== blob) {
      return;
    }
    photoPosition = position;
    const hints = [describeAccuracyHint(position.coords.accuracy)];
    const sequence = appState.checkpoint?.sequence;
    if (typeof sequence === 'number') {
      hints.push(await checkProximity(identityFor(sequence), position));
    }
    if (photoBlob === blob) {
      photoHint = hints.filter(Boolean).join('\n');
    }
  } catch (err) {
    if (photoBlob === blob) {
      photoHint = `Location unavailable: ${err instanceof Error ? err.message : String(err)}. Tap Send to try again.`;
    }
  }
  if (screenFor(appState) === 'review') {
    render();
  }
}

function clearPhoto() {
  if (photoUrl) {
    URL.revokeObjectURL(photoUrl);
  }
  photoBlob = null;
  photoUrl = '';
  photoPosition = null;
  photoHint = '';
}

retakeBtn.addEventListener('click', () => {
  if (busy || !appState.checkpoint) {
    return;
  }
  clearPhoto();
  appState.checkpoint = checkpointAfterRetake(appState.checkpoint);
  render();
});

sendBtn.addEventListener('click', async () => {
  const checkpoint = appState.checkpoint;
  if (busy || !checkpoint || !photoBlob || typeof checkpoint.sequence !== 'number') {
    return;
  }
  busy = true;
  render();

  // Location is needed upstream; get it now if it wasn't ready.
  if (!photoPosition) {
    await locatePhoto();
  }
  // An expired code is swapped quietly first; the photo is kept.
  if (codeExpired(appState.checkpoint, serverNow())) {
    await refreshCode();
  }
  busy = false;
  if (!photoPosition || !photoBlob) {
    render();
    return;
  }

  appState.checkpoint = checkpointSending(appState.checkpoint);
  render();

  const identity = identityFor(checkpoint.sequence);
  const result = await api.sendPhoto({ ...identity, image: photoBlob, position: photoPosition });

  // A photo sent outside the session is recorded but doesn't count: that's
  // Session over (or the lobby), never "Not quite".
  const sessionRejection = sessionRejectionFor(result.text);
  if (sessionRejection) {
    await applyError(sessionRejection, 'review-error');
    return;
  }
  if (result.status === 0) {
    // The photo stays in memory, so Send can be tried again.
    goOffline("No connection. Your photo is kept: tap Send to try again.");
  }
  appState.checkpoint = checkpointAfterVerdict(appState.checkpoint, result.status, result.text);
  if (appState.checkpoint.step === 'verdict') {
    clearPhoto();
  }
  render();
  // The new points total and progress.
  void refreshState();
});

verdictBtn.addEventListener('click', async () => {
  const checkpoint = appState.checkpoint;
  if (busy || !checkpoint) {
    return;
  }
  if (checkpoint.verdict !== 'failed') {
    // Next clue.
    appState.checkpoint = null;
    render();
    void refreshState();
    return;
  }

  // Try again: the failed photo used up the code, so arrive again for a
  // fresh one, back on Capture.
  busy = true;
  render();
  const sequence = checkpoint.sequence;
  const { checkpoint: next, error } = await arriveAt(sequence);
  busy = false;
  if (error) {
    appState.checkpoint = null;
    render();
    await applyError(error, 'clue-error');
    return;
  }
  appState.checkpoint = next;
  render();
});

// --- leave -----------------------------------------------------------------

function forgetIdentity() {
  appState.identity = null;
  appState.state = null;
  appState.checkpoint = null;
  appState.offline = false;
  clearPhoto();
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
