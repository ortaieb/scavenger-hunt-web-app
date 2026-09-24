// In-app camera capture + geolocation for the /challenge page.
//
// The camera stream is rendered directly in the page via getUserMedia and a
// <video>/<canvas> pair, rather than a native `<input type="file" capture>`
// picker — that keeps the capture entirely in-app and never offers a photo
// gallery as an alternative source.

const statusEl = document.getElementById('status');
const video = document.getElementById('preview');
const canvas = document.getElementById('snapshot');
const photo = document.getElementById('photo');
const captureBtn = document.getElementById('capture');
const retakeBtn = document.getElementById('retake');
const submitBtn = document.getElementById('submit');
const locationEl = document.getElementById('location');

let stream = null;
let capturedBlob = null;
let position = null;

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
    },
    (err) => {
      locationEl.textContent = `Location unavailable: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
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

  setStatus('Point the camera and take a photo.');
  void startCamera();
}

async function submitCapture() {
  if (!capturedBlob) {
    setStatus('Take a photo first.');
    return;
  }
  if (!position) {
    setStatus('Waiting for location…');
    return;
  }

  submitBtn.disabled = true;
  setStatus('Uploading…');

  try {
    const configRes = await fetch('/api/challenge/config');
    if (!configRes.ok) {
      throw new Error(`config request failed (${configRes.status})`);
    }
    const { uploadUrl } = await configRes.json();

    const form = new FormData();
    form.append('image', capturedBlob, 'challenge.jpg');
    form.append('latitude', String(position.coords.latitude));
    form.append('longitude', String(position.coords.longitude));
    form.append('accuracy', String(position.coords.accuracy));
    form.append('capturedAt', new Date(position.timestamp).toISOString());

    const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form });
    if (!uploadRes.ok) {
      throw new Error(`upload failed (${uploadRes.status})`);
    }

    setStatus('Uploaded! Thanks.');
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

void startCamera();
