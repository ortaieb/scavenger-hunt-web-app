// Camera and location code shared by /challenge and /play (see issue #42).
// The camera stream is rendered directly in the page via getUserMedia and a
// <video>/<canvas> pair, rather than a native `<input type="file" capture>`
// picker — that keeps the capture entirely in-app and never offers a photo
// gallery as an alternative source.

import { buildVideoConstraints, describeProximityWarning, hasMultipleCameras, readFacingMode } from './challenge-logic.js';

const FACING_MODE_STORAGE_KEY = 'scavenger-hunt.facingMode';
const PROXIMITY_TIMEOUT_MS = 3000;
const LOCATION_TIMEOUT_MS = 15000;

function describeError(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The remembered front/back camera choice (see issue #31). localStorage can
 * throw (private mode, blocked storage) — treat as unset.
 *
 * @returns {import('./challenge-logic.js').FacingMode}
 */
export function loadFacingMode() {
  try {
    return readFacingMode(localStorage.getItem(FACING_MODE_STORAGE_KEY));
  } catch {
    return readFacingMode(null);
  }
}

/** @param {import('./challenge-logic.js').FacingMode} mode */
export function storeFacingMode(mode) {
  try {
    localStorage.setItem(FACING_MODE_STORAGE_KEY, mode);
  } catch {
    // Not remembering the choice is fine; it still applies to this visit.
  }
}

/**
 * @typedef {{ ok: true } | { ok: false, superseded: boolean, message: string }} StartResult
 */

/**
 * Drives one <video> preview. A request id guards against a slow
 * getUserMedia from an earlier start (e.g. quick back-and-forth toggling)
 * landing after a newer one.
 *
 * @param {HTMLVideoElement} video
 */
export function createCamera(video) {
  let stream = null;
  let latestRequestId = 0;

  function stop() {
    // Also supersedes a start that's still opening.
    latestRequestId += 1;
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    stream = null;
    video.srcObject = null;
  }

  /**
   * @param {import('./challenge-logic.js').FacingMode} facingMode
   * @returns {Promise<StartResult>}
   */
  async function start(facingMode) {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, superseded: false, message: 'Camera capture is not supported in this browser.' };
    }

    // Release the current camera first: several mobile browsers (notably
    // iOS Safari) can't open a second camera while one is still streaming.
    stop();
    const requestId = latestRequestId;

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: buildVideoConstraints(facingMode),
        audio: false,
      });
    } catch (err) {
      return { ok: false, superseded: requestId !== latestRequestId, message: `Camera access failed: ${describeError(err)}` };
    }

    if (requestId !== latestRequestId) {
      // Superseded by a newer start (or a stop) while this one was opening.
      newStream.getTracks().forEach((track) => {
        track.stop();
      });
      return { ok: false, superseded: true, message: '' };
    }

    stream = newStream;
    video.srcObject = stream;
    // Mirror by what the device actually opened, falling back to what was
    // asked for when the browser doesn't report it.
    const actualFacingMode = stream.getVideoTracks()[0]?.getSettings?.().facingMode ?? facingMode;
    video.classList.toggle('mirrored', actualFacingMode === 'user');
    return { ok: true };
  }

  /**
   * Grabs the current frame as a JPEG. Drawn from the raw frame, so a
   * mirrored front-camera preview never produces a mirrored photo.
   *
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<Blob | null>} null when there's no frame to take
   */
  function capture(canvas) {
    const { videoWidth, videoHeight } = video;
    if (!stream || videoWidth === 0 || videoHeight === 0) {
      // No frame yet (the camera is still warming up): no photo rather
      // than a blank one.
      return Promise.resolve(null);
    }
    canvas.width = videoWidth;
    canvas.height = videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, videoWidth, videoHeight);
    return new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.9);
    });
  }

  return {
    start,
    stop,
    capture,
    get active() {
      return stream !== null;
    },
  };
}

/**
 * Whether the front/back toggle is worth showing. Browsers only list
 * cameras fully once permission is granted, so ask after a stream starts.
 *
 * @returns {Promise<boolean>}
 */
export async function deviceHasMultipleCameras() {
  try {
    return hasMultipleCameras(await navigator.mediaDevices.enumerateDevices());
  } catch {
    // Can't tell — leave the toggle hidden rather than offer a no-op.
    return false;
  }
}

/**
 * A fresh location fix.
 *
 * @returns {Promise<GeolocationPosition>} rejects with an Error whose
 *   message says why (unsupported, denied, no fix in time)
 */
export function getPosition() {
  if (!('geolocation' in navigator)) {
    return Promise.reject(new Error('Not supported in this browser.'));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, (err) => reject(new Error(err.message)), {
      enableHighAccuracy: true,
      timeout: LOCATION_TIMEOUT_MS,
      maximumAge: 0,
    });
  });
}

/**
 * Asks the game-server's proximity advisory (via this app's relay) whether
 * the player looks out of range. A courtesy only: it never blocks Submit,
 * and any failure (429, 404, network error, timeout) is "say nothing"
 * (see issue #15).
 *
 * @param {{ session: string, participant: string, checkpoint: number }} identity
 * @param {GeolocationPosition} position
 * @returns {Promise<string>} '' if no warning applies
 */
export async function checkProximity(identity, position) {
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
          location: { lat: position.coords.latitude, long: position.coords.longitude },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const body = await response.json().catch(() => null);
    return describeProximityWarning(response.status, body);
  } catch {
    // Network error, timeout/abort, or a malformed response — stay silent.
    return '';
  }
}
