// In-app camera capture + geolocation for the /challenge page.
//
// The camera stream is rendered directly in the page via getUserMedia and a
// <video>/<canvas> pair, rather than a native `<input type="file" capture>`
// picker — that keeps the capture entirely in-app and never offers a photo
// gallery as an alternative source.

import {
  readIdentityFromQuery,
  describeVerdict,
  describeAccuracyHint,
  describeProximityWarning,
} from './challenge-logic.js';

const PROXIMITY_TIMEOUT_MS = 3000;

const statusEl = document.getElementById('status');
const video = document.getElementById('preview');
const canvas = document.getElementById('snapshot');
const photo = document.getElementById('photo');
const captureBtn = document.getElementById('capture');
const retakeBtn = document.getElementById('retake');
const submitBtn = document.getElementById('submit');
const locationEl = document.getElementById('location');
const locationWarningEl = document.getElementById('location-warning');

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

// There's no join flow yet, so the submission is identified by query params
// on this page's own URL (see issue #14), e.g.
// /challenge?session=...&participant=...&checkpoint=2
const identity = readIdentityFromQuery(new URLSearchParams(window.location.search));

function setStatus(message) {
  statusEl.textContent = message;
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err);
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
  if (!identity) {
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

  setStatus('Point the camera and take a photo.');
  void startCamera();
}

async function submitCapture() {
  if (!identity) {
    setStatus('This link is missing or has an invalid session, participant or checkpoint.');
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

  submitBtn.disabled = true;
  setStatus('Sending…');

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
    const { message, forceRetake } = describeVerdict(response.status, bodyText);
    setStatus(message);
    if (forceRetake) {
      // The photo was rejected; resubmitting the same one won't help, so
      // Retake is the only way forward until a new capture is taken.
      submitBtn.hidden = true;
    }
  } catch (err) {
    setStatus(`Upload failed: ${describeError(err)}`);
  } finally {
    submitBtn.disabled = false;
  }
}

captureBtn.addEventListener('click', capturePhoto);
retakeBtn.addEventListener('click', retake);
submitBtn.addEventListener('click', () => {
  void submitCapture();
});

if (!identity) {
  captureBtn.disabled = true;
  submitBtn.disabled = true;
  setStatus('This link is missing or has an invalid session, participant or checkpoint.');
} else {
  void startCamera();
}
