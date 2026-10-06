// In-app camera capture + geolocation for the /challenge page. The camera
// and location code itself is shared with /play, in camera.js, and so is
// the call to the /arrive relay, in api.js.

import { arrive } from './api.js';
import {
  isValidUuid,
  readCheckpointFromQuery,
  describeVerdict,
  describeAccuracyHint,
  describeArrival,
  readFacingMode,
} from './challenge-logic.js';
import {
  checkProximity,
  createCamera,
  deviceHasMultipleCameras,
  getPosition,
  loadFacingMode,
  storeFacingMode,
} from './camera.js';

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
const arriveBtn = document.getElementById('arrive');
const checkInStatusEl = document.getElementById('check-in-status');
const challengePanelEl = document.getElementById('challenge-panel');
const challengePoseEl = document.getElementById('challenge-pose');
const challengeCodeEl = document.getElementById('challenge-code');
const challengeExpiryEl = document.getElementById('challenge-expiry');
const checklistEl = document.getElementById('verdict-checklist');
const cameraToggleEl = document.getElementById('camera-toggle');
const cameraRadios = cameraToggleEl.querySelectorAll('input[name="camera"]');

const ICON_CLASS = { '✓': 'passed', '✗': 'failed', '?': 'uncertain' };

const camera = createCamera(video);
let capturedBlob = null;
let position = null;

// Front/back camera choice (see issue #31), remembered across visits so a
// solo player taking selfies doesn't have to re-pick it every time.
let facingMode = loadFacingMode();

// The courtesy hints (accuracy + proximity) are independent, but shown
// together in one element. A fix id guards against a slow proximity
// response from an older fix landing after a newer one (e.g. a quick
// Retake) and overwriting its hint.
let accuracyHintText = '';
let proximityHintText = '';
let latestFixId = 0;

// Check-in state (see issue #54): the game-server holds every photo to the
// team's check-in at the checkpoint, one photo per check-in, and judges the
// pose it issued there. So Submit waits for "I'm here", and a photo that
// got a verdict has used the check-in up. An arrive id guards against a
// slow answer landing after the identity fields have changed.
let checkedIn = false;
let arriving = false;
let submitting = false;
let latestArriveId = 0;

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

// TEMP (see issue #32): the session field defaults to this fixed, known id
// (the game-server's example session), so manual testing can reuse the same
// session repeatedly.
const TEMP_DEFAULT_SESSION_ID = 'aeffe667-4f9f-4108-b5e2-56ae821fe413';

/**
 * Session and participant are editable fields, not fixed like checkpoint
 * (see issue #18) — pre-filled from the query string when it supplies a
 * valid UUID (so existing links keep working), and editable from there.
 * Session defaults to TEMP_DEFAULT_SESSION_ID (see issue #32). Participant
 * has no default: a made-up one has never joined, and the game-server
 * refuses it (see issue #54), so it comes from the link or is typed in.
 */
function initIdentityFields() {
  const params = new URLSearchParams(window.location.search);
  const sessionFromQuery = params.get('session');
  const participantFromQuery = params.get('participant');

  sessionInput.value = isValidUuid(sessionFromQuery) ? sessionFromQuery : TEMP_DEFAULT_SESSION_ID;
  participantInput.value = isValidUuid(participantFromQuery) ? participantFromQuery : '';
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

/**
 * The "Your challenge" panel: the pose and code from the latest check-in,
 * or hidden without one.
 *
 * @param {{ pose: string | null, code: string, expiresAt: string } | null} arrival
 */
function renderChallenge(arrival) {
  challengePanelEl.hidden = arrival === null;
  // textContent, never innerHTML: the pose comes from a moderator-written
  // file, not code this app controls (see issue #20).
  challengePoseEl.textContent = arrival?.pose ?? '';
  challengePoseEl.hidden = !arrival?.pose;
  challengeCodeEl.textContent = arrival?.code ?? '';
  const expiresAt = Date.parse(arrival?.expiresAt ?? '');
  challengeExpiryEl.textContent = Number.isFinite(expiresAt)
    ? `(until ${new Date(expiresAt).toLocaleTimeString()})`
    : '';
}

function setCheckInStatus(message) {
  checkInStatusEl.textContent = message;
}

function updateButtons() {
  arriveBtn.disabled = checkpoint === null || arriving || submitting;
  arriveBtn.textContent = arriving ? 'Checking in…' : "I'm here";
  submitBtn.disabled = submitting || !checkedIn;
}

/**
 * Forgets the check-in: when the identity fields change (it was for the old
 * ones), or once a photo has used it.
 *
 * @param {string} [message] what to say instead of the default prompt
 */
function resetCheckIn(message) {
  latestArriveId += 1;
  checkedIn = false;
  arriving = false;
  renderChallenge(null);
  setCheckInStatus(
    message ??
      (getIdentity()
        ? "Not checked in yet: tap I'm here at the checkpoint."
        : "Enter the session and a participant that has joined it, then tap I'm here."),
  );
  updateButtons();
}

/**
 * "I'm here": checks in at the checkpoint via this app's /arrive relay, and
 * shows the pose and code the game-server issued.
 */
async function checkIn() {
  const identity = getIdentity();
  if (!identity) {
    setCheckInStatus('Session and participant must both be a valid ID before you can check in.');
    return;
  }

  const arriveId = ++latestArriveId;
  arriving = true;
  updateButtons();
  setCheckInStatus('Checking in…');

  const { status, body } = await arrive(identity.session, identity.participant, identity.checkpoint);
  if (arriveId !== latestArriveId) {
    return;
  }

  arriving = false;
  const arrival = describeArrival(status, body);
  checkedIn = arrival.ok;
  renderChallenge(arrival.ok ? arrival : null);
  setCheckInStatus(arrival.ok ? 'Checked in. Strike the pose, take the photo and submit.' : arrival.message);
  updateButtons();
}

/**
 * Shows the front/back toggle only on devices with more than one camera.
 * Asked after a stream starts, since browsers only list cameras fully once
 * permission is granted.
 */
async function updateCameraToggle() {
  const multiple = await deviceHasMultipleCameras();
  // Only before taking the picture: the toggle stays hidden once a photo
  // has been captured, until Retake brings the preview back.
  cameraToggleEl.hidden = !multiple || video.hidden;
}

function onCameraToggleChange(event) {
  facingMode = readFacingMode(event.target.value);
  storeFacingMode(facingMode);
  void startCamera();
}

async function startCamera() {
  captureBtn.disabled = true;
  const result = await camera.start(facingMode);
  if (!result.ok) {
    if (!result.superseded) {
      setStatus(result.message);
    }
    return;
  }
  captureBtn.disabled = false;
  setStatus('Point the camera and take a photo.');
  void updateCameraToggle();
}

function renderLocationHints() {
  const text = [accuracyHintText, proximityHintText].filter(Boolean).join('\n');
  locationWarningEl.textContent = text;
  locationWarningEl.hidden = text === '';
}

function requestLocation() {
  locationEl.textContent = 'Requesting location…';
  getPosition().then(
    (pos) => {
      position = pos;
      const { latitude, longitude, accuracy } = pos.coords;
      locationEl.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)} (±${Math.round(accuracy)}m)`;

      // Local, advisory-only — no server round trip.
      accuracyHintText = describeAccuracyHint(accuracy);
      proximityHintText = '';
      renderLocationHints();

      void updateProximityHint(pos);
    },
    (err) => {
      locationEl.textContent = `Location unavailable: ${describeError(err)}`;
    },
  );
}

/**
 * Asks the proximity advisory about this fix, at most once per fix. A
 * courtesy only: it never blocks Submit (see issue #15).
 */
async function updateProximityHint(pos) {
  const identity = getIdentity();
  if (!identity) {
    // Advisory only — if the player has typed something invalid into an
    // identity field, that's surfaced (loudly) at Submit time instead.
    return;
  }

  const fixId = ++latestFixId;
  const warning = await checkProximity(identity, pos);

  if (fixId === latestFixId) {
    proximityHintText = warning;
    renderLocationHints();
  }
}

async function capturePhoto() {
  const blob = await camera.capture(canvas);
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
  cameraToggleEl.hidden = true;

  camera.stop();
  requestLocation();
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
  if (!checkedIn) {
    setStatus("Tap I'm here to check in before you submit.");
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
  submitting = true;
  updateButtons();
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
    if (variant !== 'error') {
      // The photo was recorded against the check-in, whatever its verdict.
      resetCheckIn("That photo used the check-in. Tap I'm here again before the next one.");
    }
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
    submitting = false;
    updateButtons();
    captureBtn.disabled = false;
    retakeBtn.disabled = false;
  }
}

captureBtn.addEventListener('click', () => {
  void capturePhoto();
});
retakeBtn.addEventListener('click', retake);
submitBtn.addEventListener('click', () => {
  void submitCapture();
});
arriveBtn.addEventListener('click', () => {
  void checkIn();
});
// A check-in belongs to the session and participant it was made for.
sessionInput.addEventListener('input', () => resetCheckIn());
participantInput.addEventListener('input', () => resetCheckIn());
cameraRadios.forEach((radio) => {
  radio.checked = radio.value === facingMode;
  radio.addEventListener('change', onCameraToggleChange);
});

initIdentityFields();
resetCheckIn();

if (checkpoint === null) {
  captureBtn.disabled = true;
  setStatus('This link is missing a valid checkpoint.');
} else {
  void startCamera();
}
