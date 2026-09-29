// In-app camera capture + geolocation for the /challenge page.
//
// The camera stream is rendered directly in the page via getUserMedia and a
// <video>/<canvas> pair, rather than a native `<input type="file" capture>`
// picker — that keeps the capture entirely in-app and never offers a photo
// gallery as an alternative source.

import {
  isValidUuid,
  readCheckpointFromQuery,
  describeVerdict,
  describeAccuracyHint,
  describeProximityWarning,
  describeChallenge,
} from './challenge-logic.js';

const PROXIMITY_TIMEOUT_MS = 3000;
const CHALLENGE_TIMEOUT_MS = 3000;
const CHALLENGE_DEBOUNCE_MS = 500;

const statusEl = document.getElementById('status');
const video = document.getElementById('preview');
const canvas = document.getElementById('snapshot');
const photo = document.getElementById('photo');
const captureBtn = document.getElementById('capture');
const retakeBtn = document.getElementById('retake');
const submitBtn = document.getElementById('submit');
const locationEl = document.getElementById('location');
const locationWarningEl = document.getElementById('location-warning');
const sessionInput = document.getElementById('session-input');
const participantInput = document.getElementById('participant-input');
const challengePanelEl = document.getElementById('challenge-panel');
const challengePoseEl = document.getElementById('challenge-pose');
const checklistEl = document.getElementById('verdict-checklist');

const ICON_CLASS = { '✓': 'passed', '✗': 'failed', '?': 'uncertain' };

let stream = null;
let capturedBlob = null;
let position = null;

// The courtesy hints (accuracy + proximity) are independent, but shown
// together in one element. A fix id guards against a slow proximity
// response from an older fix landing after a newer one (e.g. a quick
// Retake) and overwriting its hint.
let accuracyHintText = '';
let proximityHintText = '';
let latestFixId = 0;

// "Your challenge" panel state (see issue #20): re-fetched, debounced, when
// the Session ID field settles on a new valid UUID.
let challengeDebounceTimer = null;
let lastFetchedChallengeSession = null;
let latestChallengeRequestId = 0;

// The checkpoint names a specific point in the hunt, so — unlike
// session/participant — it always has to come from the link, with no
// sensible default (see issue #18); there's still no join flow, so it's
// read once from this page's own query string, e.g. /challenge?checkpoint=2.
const checkpoint = readCheckpointFromQuery(new URLSearchParams(window.location.search));

function setStatus(message) {
  statusEl.textContent = message;
}

/** Success/failure styling for the status line; anything else is neutral. */
function setVerdictVariant(variant) {
  statusEl.classList.remove('status--pass', 'status--failed');
  if (variant === 'pass') {
    statusEl.classList.add('status--pass');
  } else if (variant === 'failed') {
    statusEl.classList.add('status--failed');
  }
}

/**
 * @param {Array<{icon: string, label: string, reason: string}>} items
 */
function renderChecklist(items) {
  checklistEl.replaceChildren();
  if (!items || items.length === 0) {
    checklistEl.hidden = true;
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.className = `verdict-check verdict-check--${ICON_CLASS[item.icon] ?? 'uncertain'}`;
    // textContent, never innerHTML: item.reason is server-written, but this
    // app still never injects it as markup (see issue #20's pose panel).
    li.textContent = item.reason ? `${item.icon} ${item.label} — ${item.reason}` : `${item.icon} ${item.label}`;
    checklistEl.append(li);
  }
  checklistEl.hidden = false;
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err);
}

/** A random UUID for the session/participant fields' default value. */
function generateUuid() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '';
}

/**
 * Session and participant are editable fields, not fixed like checkpoint
 * (see issue #18) — pre-filled from the query string when it supplies a
 * valid UUID (so existing links keep working), a fresh random one
 * otherwise, and editable from there.
 */
function initIdentityFields() {
  const params = new URLSearchParams(window.location.search);
  const sessionFromQuery = params.get('session');
  const participantFromQuery = params.get('participant');

  sessionInput.value = isValidUuid(sessionFromQuery) ? sessionFromQuery : generateUuid();
  participantInput.value = isValidUuid(participantFromQuery) ? participantFromQuery : generateUuid();
}

/**
 * Reads the identity fields as they currently stand — they're editable, so
 * this is read fresh each time, not cached from page load.
 *
 * @returns {{ session: string, participant: string, checkpoint: number } | null}
 */
function getIdentity() {
  const session = sessionInput.value.trim();
  const participant = participantInput.value.trim();

  if (checkpoint === null || !isValidUuid(session) || !isValidUuid(participant)) {
    return null;
  }
  return { session, participant, checkpoint };
}

function renderChallenge(pose) {
  if (pose === null) {
    challengePanelEl.hidden = true;
    challengePoseEl.textContent = '';
  } else {
    // textContent, never innerHTML: the pose comes from a moderator-written
    // file, not code this app controls (see issue #20).
    challengePoseEl.textContent = pose;
    challengePanelEl.hidden = false;
  }
}

/**
 * Fetches the checkpoint's pose instruction for the given session, via this
 * app's own relay. The pose is guidance only: it never blocks Capture or
 * Submit, and every failure mode (404, timeout, network error, a malformed
 * response) just hides the panel rather than showing an error.
 *
 * @param {string} session
 */
async function fetchChallenge(session) {
  const requestId = ++latestChallengeRequestId;
  let pose;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHALLENGE_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(
        `/checkpoint/challenge?session=${encodeURIComponent(session)}&checkpoint=${checkpoint}`,
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const body = await response.json().catch(() => null);
    pose = describeChallenge(response.status, body);
  } catch {
    // Network error or timeout/abort — status 0 stands for "no response at
    // all", which describeChallenge already treats the same as any other
    // failure: hide the panel.
    pose = describeChallenge(0, null);
  }

  if (requestId === latestChallengeRequestId) {
    renderChallenge(pose);
  }
}

/**
 * Re-fetches the pose when the Session ID field settles on a new valid
 * UUID, debounced so a fetch isn't fired on every keystroke.
 */
function scheduleChallengeFetch() {
  clearTimeout(challengeDebounceTimer);
  challengeDebounceTimer = setTimeout(() => {
    if (checkpoint === null) {
      return;
    }
    const session = sessionInput.value.trim();
    if (!isValidUuid(session) || session === lastFetchedChallengeSession) {
      return;
    }
    lastFetchedChallengeSession = session;
    void fetchChallenge(session);
  }, CHALLENGE_DEBOUNCE_MS);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Camera capture is not supported in this browser.');
    captureBtn.disabled = true;
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    video.srcObject = stream;
    setStatus('Point the camera and take a photo.');
  } catch (err) {
    setStatus(`Camera access failed: ${describeError(err)}`);
    captureBtn.disabled = true;
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => {
    track.stop();
  });
  stream = null;
}

function renderLocationHints() {
  const text = [accuracyHintText, proximityHintText].filter(Boolean).join('\n');
  locationWarningEl.textContent = text;
  locationWarningEl.hidden = text === '';
}

function requestLocation() {
  if (!('geolocation' in navigator)) {
    locationEl.textContent = 'Not supported in this browser.';
    return;
  }

  locationEl.textContent = 'Requesting location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      position = pos;
      const { latitude, longitude, accuracy } = pos.coords;
      locationEl.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)} (±${Math.round(accuracy)}m)`;

      // Local, advisory-only — no server round trip.
      accuracyHintText = describeAccuracyHint(accuracy);
      proximityHintText = '';
      renderLocationHints();

      void checkProximity(pos);
    },
    (err) => {
      locationEl.textContent = `Location unavailable: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
}

/**
 * Asks the game-server's proximity advisory (via this app's relay) whether
 * the player looks out of range, at most once per location fix. This is a
 * courtesy only: it never blocks Submit, and any failure (429, 404, network
 * error, timeout) is treated the same as "say nothing" (see issue #15).
 */
async function checkProximity(pos) {
  const identity = getIdentity();
  if (!identity) {
    // Advisory only — if the player has typed something invalid into an
    // identity field, that's surfaced (loudly) at Submit time instead.
    return;
  }

  const fixId = ++latestFixId;
  let warning = '';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXIMITY_TIMEOUT_MS);

    let response;
    try {
      response = await fetch('/checkpoint/proximity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session: identity.session,
          participant: identity.participant,
          checkpoint: identity.checkpoint,
          location: { lat: pos.coords.latitude, long: pos.coords.longitude },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const body = await response
      .json()
      .catch(() => null);
    warning = describeProximityWarning(response.status, body);
  } catch {
    // Network error, timeout/abort, or a malformed response — stay silent.
    warning = '';
  }

  if (fixId === latestFixId) {
    proximityHintText = warning;
    renderLocationHints();
  }
}

function capturePhoto() {
  const { videoWidth, videoHeight } = video;
  canvas.width = videoWidth;
  canvas.height = videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, videoWidth, videoHeight);

  canvas.toBlob(
    (blob) => {
      if (!blob) {
        setStatus('Could not capture the photo. Try again.');
        return;
      }

      capturedBlob = blob;
      photo.src = URL.createObjectURL(blob);

      video.hidden = true;
      photo.hidden = false;
      captureBtn.hidden = true;
      retakeBtn.hidden = false;
      submitBtn.hidden = false;

      stopCamera();
      requestLocation();
    },
    'image/jpeg',
    0.9,
  );
}

function retake() {
  capturedBlob = null;
  position = null;

  photo.hidden = true;
  photo.src = '';
  video.hidden = false;
  captureBtn.hidden = false;
  retakeBtn.hidden = true;
  submitBtn.hidden = true;
  locationEl.textContent = 'Not captured yet';

  // The old fix's hints no longer apply; a new one is requested after the
  // next capture, which also supersedes any still-in-flight proximity check.
  latestFixId += 1;
  accuracyHintText = '';
  proximityHintText = '';
  renderLocationHints();

  // The previous attempt's verdict no longer applies to a fresh photo.
  setVerdictVariant(null);
  renderChecklist([]);

  setStatus('Point the camera and take a photo.');
  void startCamera();
}

async function submitCapture() {
  const identity = getIdentity();
  if (!identity) {
    setStatus('Session and participant must both be a valid ID before you can submit.');
    return;
  }
  if (!capturedBlob) {
    setStatus('Take a photo first.');
    return;
  }
  if (!position) {
    setStatus('Waiting for location…');
    return;
  }

  // The referee now runs before the response, which can take several
  // seconds — lock the whole flow down while it does (see issue #21).
  submitBtn.disabled = true;
  captureBtn.disabled = true;
  retakeBtn.disabled = true;
  setVerdictVariant(null);
  renderChecklist([]);
  setStatus('The referee is checking your photo…');

  try {
    const form = new FormData();
    form.append('session', identity.session);
    form.append('participant', identity.participant);
    form.append('checkpoint', String(identity.checkpoint));
    form.append('image', capturedBlob, 'challenge.jpg');
    form.append('latitude', String(position.coords.latitude));
    form.append('longitude', String(position.coords.longitude));
    form.append('capturedAt', new Date(position.timestamp).toISOString());

    // Posted to this app's own /challenge, same-origin — not the game-server
    // directly, which the browser can't safely reach (see issue #7).
    const response = await fetch('/challenge', { method: 'POST', body: form });
    const bodyText = await response.text().catch(() => '');

    // describeVerdict only reports what the game-server already decided —
    // this page never computes or infers a verdict itself (see issue #14).
    const { message, variant, hideSubmit, hideRetake, checklist } = describeVerdict(response.status, bodyText);
    setStatus(message);
    setVerdictVariant(variant);
    renderChecklist(checklist);
    if (hideSubmit) {
      // A pass needs no more submissions; a failed one needs a fresh photo
      // rather than resubmitting the one that was just rejected.
      submitBtn.hidden = true;
    }
    if (hideRetake) {
      // Only on a pass — there's nothing left to retake.
      retakeBtn.hidden = true;
    }
  } catch (err) {
    setStatus(`Upload failed: ${describeError(err)}`);
  } finally {
    submitBtn.disabled = false;
    captureBtn.disabled = false;
    retakeBtn.disabled = false;
  }
}

captureBtn.addEventListener('click', capturePhoto);
retakeBtn.addEventListener('click', retake);
submitBtn.addEventListener('click', () => {
  void submitCapture();
});
sessionInput.addEventListener('input', scheduleChallengeFetch);

initIdentityFields();
// Fires once the session field already holds a valid UUID at load, going
// through the same debounced path as an edit does.
scheduleChallengeFetch();

if (checkpoint === null) {
  captureBtn.disabled = true;
  submitBtn.disabled = true;
  setStatus('This link is missing a valid checkpoint.');
} else {
  void startCamera();
}
