import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp, fetchWithTimeout } from '../src/app.js';

const testConfig = { gameServerUrl: 'http://game-server.test', gameServerTimeoutMs: 5000 };

const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const VALID_SESSION = '11111111-1111-4111-8111-111111111111';
const VALID_PARTICIPANT = '22222222-2222-4222-8222-222222222222';
const VALID_CHECKPOINT = '2';

interface ErrorBody {
  error: string;
}

type FetchInit = Parameters<typeof fetch>[1];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchWithTimeout', () => {
  // Pure function, no HTTP/supertest involved, so fake timers are safe here
  // — unlike in the POST /challenge 504 test below, which goes through a
  // real request and found faking setTimeout globally breaks that.
  it('rejects with an AbortError once the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
      );

      const resultPromise = fetchWithTimeout(fetchMock, 'http://game-server.test/challenge', {}, 1000);
      const assertion = expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });

      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves normally when fetch settles before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(new Response('ok')));

      const result = await fetchWithTimeout(fetchMock, 'http://game-server.test/challenge', {}, 1000);

      expect(await result.text()).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.each(['/', '/play'])('GET %s', (path) => {
  it('serves the participant app', async () => {
    const response = await request(createApp(testConfig)).get(path);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.text).toContain('<script type="module" src="/play.js"></script>');
  });

  it('asks for consent with a box that starts unticked, using the game-server\'s wording', async () => {
    const response = await request(createApp(testConfig)).get(path);

    expect(response.text).toMatch(/<input id="consent" type="checkbox" \/>/);
    expect(response.text.replace(/\s+/g, ' ')).toContain(
      'I agree to my photos and checkpoint locations being used as described to verify my progress in this game.',
    );
  });
});

describe.each(['/play.js', '/play.css', '/api.js', '/game-logic.js'])('GET %s', (asset) => {
  it('is served', async () => {
    const response = await request(createApp(testConfig)).get(asset);

    expect(response.status).toBe(200);
  });
});

describe('GET /moderator', () => {
  it('serves the moderator screen', async () => {
    const response = await request(createApp(testConfig)).get(`/moderator?session=${VALID_SESSION}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.text).toContain('<script type="module" src="/moderator.js"></script>');
  });

  it('asks for the code in a form that never puts it in a URL', async () => {
    const response = await request(createApp(testConfig)).get('/moderator');

    // POST, so even without JavaScript the code isn't sent as a query string.
    expect(response.text).toMatch(/<form id="sign-in-form" method="post"/);
    expect(response.text).toMatch(/id="moderator-code"[\s\S]*?type="password"/);
  });
});

describe.each(['/moderator.js', '/moderator-logic.js', '/moderator.css'])('GET %s', (asset) => {
  it('is served', async () => {
    const response = await request(createApp(testConfig)).get(asset);

    expect(response.status).toBe(200);
  });
});

describe('the moderator code', () => {
  it.each(['/moderator.js', '/moderator-logic.js'])('is never kept in localStorage by %s', async (asset) => {
    const response = await request(createApp(testConfig)).get(asset);

    expect(response.text).not.toContain('localStorage');
  });

  it('is kept in sessionStorage and sent only as a Bearer token', async () => {
    const response = await request(createApp(testConfig)).get('/moderator.js');

    expect(response.text).toContain('sessionStorage.setItem');
    expect(response.text).toContain('authorization: `Bearer ${');
    expect(response.text).not.toMatch(/console\./);
  });
});

describe('GET /privacy', () => {
  it('renders the privacy notice as HTML, without the notes for whoever fills it in', async () => {
    const response = await request(createApp(testConfig)).get('/privacy');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.text).toContain('<h2>Full privacy notice</h2>');
    expect(response.text).toContain('href="/play.css"');
    expect(response.text).not.toContain('Before publishing');
  });
});

describe('GET /how-to-play', () => {
  it('renders the user guide as HTML', async () => {
    const response = await request(createApp(testConfig)).get('/how-to-play');

    expect(response.status).toBe(200);
    expect(response.text).toContain('<h1>How to play</h1>');
  });

  it("points the guide's links at this app's pages", async () => {
    const response = await request(createApp(testConfig)).get('/how-to-play');

    expect(response.text).toContain('href="/privacy"');
    expect(response.text).not.toContain('href="privacy-notice.md"');
  });
});

describe('GET /moderator-guide', () => {
  it('renders the moderator guide as HTML', async () => {
    const response = await request(createApp(testConfig)).get('/moderator-guide');

    expect(response.status).toBe(200);
    expect(response.text).toContain('<h1>Moderator guide</h1>');
  });
});

describe('the guides', () => {
  it.each(['/how-to-play', '/moderator-guide'])('serves every screenshot %s shows', async (page) => {
    const app = createApp(testConfig);
    const html = (await request(app).get(page)).text;
    const images = [...html.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]!);

    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      // Relative to the page, so `images/x.png` is served at `/images/x.png`.
      const response = await request(app).get(`/${image}`);
      expect(response.status, image).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
    }
  });
});

describe('GET /health', () => {
  it('returns 200 without calling the game server', async () => {
    const fetchMock: typeof fetch = vi.fn();

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /challenge', () => {
  it('serves the capture page', async () => {
    const response = await request(createApp(testConfig)).get('/challenge');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.text).toContain('<video');
  });

  it('includes editable session and participant fields', async () => {
    const response = await request(createApp(testConfig)).get('/challenge');

    expect(response.text).toContain('id="session-input"');
    expect(response.text).toContain('id="participant-input"');
    expect(response.text).not.toMatch(/id="session-input"[^>]*\breadonly\b/);
    expect(response.text).not.toMatch(/id="participant-input"[^>]*\breadonly\b/);
    expect(response.text).not.toMatch(/id="session-input"[^>]*\bdisabled\b/);
    expect(response.text).not.toMatch(/id="participant-input"[^>]*\bdisabled\b/);
  });

  it('includes the "Your challenge" panel, hidden by default', async () => {
    const response = await request(createApp(testConfig)).get('/challenge');

    expect(response.text).toMatch(/id="challenge-panel"[^>]*\bhidden\b/);
    expect(response.text).toContain('id="challenge-pose"');
  });

  it('includes the verdict checklist, hidden by default', async () => {
    const response = await request(createApp(testConfig)).get('/challenge');

    expect(response.text).toMatch(/id="verdict-checklist"[^>]*\bhidden\b/);
  });
});

describe('GET /challenge.js', () => {
  it('serves the client script', async () => {
    const response = await request(createApp(testConfig)).get('/challenge.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain("from './camera.js'");
  });
});

describe('GET /camera.js', () => {
  it('serves the shared camera code', async () => {
    const response = await request(createApp(testConfig)).get('/camera.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('getUserMedia');
  });
});

describe('POST /challenge', () => {
  const validFields: Record<string, string> = {
    session: VALID_SESSION,
    participant: VALID_PARTICIPANT,
    checkpoint: VALID_CHECKPOINT,
    latitude: '51.509948',
    longitude: '-1.485923',
    capturedAt: '2012-03-29T10:05:45-06:00',
  };

  function postChallenge(app: ReturnType<typeof createApp>, fields: Record<string, string | undefined> = {}) {
    const merged = { ...validFields, ...fields };
    let req = request(app).post('/challenge');
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined) {
        req = req.field(key, value);
      }
    }
    return req.attach('image', jpegBytes, { filename: 'photo.jpg', contentType: 'image/jpeg' });
  }

  function okResponse(): typeof fetch {
    return vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })));
  }

  it('relays the capture to the game server and forwards a 200', async () => {
    const fetchMock = okResponse();

    const response = await postChallenge(createApp(testConfig, { fetch: fetchMock }));

    expect(response.status).toBe(200);
    expect(response.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = vi.mocked(fetchMock).mock.calls[0]!;
    expect((calledUrl as URL).href).toBe('http://game-server.test/challenge');
    expect(calledInit).toMatchObject({ method: 'POST' });
  });

  it('sends the metadata contract the game server expects, with no placeholders', async () => {
    let capturedForm: FormData | undefined;
    const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) => {
      capturedForm = init?.body as FormData;
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    await postChallenge(createApp(testConfig, { fetch: fetchMock }));

    const metadataField = capturedForm?.get('metadata');
    expect(typeof metadataField).toBe('string');
    expect(JSON.parse(metadataField as string)).toEqual({
      session: VALID_SESSION,
      participant: VALID_PARTICIPANT,
      checkpoint: 2,
      location: { lat: 51.509948, long: -1.485923 },
      'capture-time': '2012-03-29T10:05:45-06:00',
    });

    const imageField = capturedForm?.get('challenge-image');
    expect(imageField).toBeInstanceOf(Blob);
    const imageBytes = new Uint8Array(await (imageField as Blob).arrayBuffer());
    expect(imageBytes).toEqual(new Uint8Array(jpegBytes));
  });

  it('relays a non-200 upstream status and body', async () => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(new Response('bad request upstream', { status: 422 })),
    );

    const response = await postChallenge(createApp(testConfig, { fetch: fetchMock }));

    expect(response.status).toBe(422);
    expect(response.text).toBe('bad request upstream');
  });

  it('relays a 202 pending verdict body unchanged', async () => {
    const body = JSON.stringify({ attempt: 1 });
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(new Response(body, { status: 202, headers: { 'content-type': 'application/json' } })),
    );

    const response = await postChallenge(createApp(testConfig, { fetch: fetchMock }));

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ attempt: 1 });
  });

  it('relays a 404 (unknown session/checkpoint) unchanged', async () => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(new Response('not found upstream', { status: 404 })),
    );

    const response = await postChallenge(createApp(testConfig, { fetch: fetchMock }));

    expect(response.status).toBe(404);
    expect(response.text).toBe('not found upstream');
  });

  it('returns 502 when the game server cannot be reached', async () => {
    const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const response = await postChallenge(createApp(testConfig, { fetch: fetchMock }));

    expect(response.status).toBe(502);
    expect((response.body as ErrorBody).error).toContain('connect ECONNREFUSED');
  });

  it('returns 504 when the game server does not respond within the configured timeout', async () => {
    // A genuinely short real timeout, not a faked one: faking setTimeout
    // globally also freezes parts of the real HTTP/multer plumbing this
    // test's actual request depends on (verified experimentally — it hangs
    // indefinitely). fetchWithTimeout's own timing is covered in isolation,
    // with fake timers, below; this proves the route maps that into a 504.
    const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
    );

    const response = await postChallenge(createApp({ ...testConfig, gameServerTimeoutMs: 30 }, { fetch: fetchMock }));

    expect(response.status).toBe(504);
    expect((response.body as ErrorBody).error).toContain('too long');
  });

  it('rejects a request with no image', async () => {
    const fetchMock = okResponse();

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/challenge')
      .field('session', VALID_SESSION)
      .field('participant', VALID_PARTICIPANT)
      .field('checkpoint', VALID_CHECKPOINT)
      .field('latitude', '51.5')
      .field('longitude', '-1.5')
      .field('capturedAt', '2012-03-29T10:05:45-06:00');

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a request missing location fields', async () => {
    const fetchMock = okResponse();

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/challenge')
      .field('session', VALID_SESSION)
      .field('participant', VALID_PARTICIPANT)
      .field('checkpoint', VALID_CHECKPOINT)
      .attach('image', jpegBytes, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing session', { session: undefined }],
    ['invalid session', { session: 'not-a-uuid' }],
    ['missing participant', { participant: undefined }],
    ['invalid participant', { participant: 'not-a-uuid' }],
    ['missing checkpoint', { checkpoint: undefined }],
    ['non-integer checkpoint', { checkpoint: '1.5' }],
    ['checkpoint below 1', { checkpoint: '0' }],
    ['non-numeric checkpoint', { checkpoint: 'two' }],
  ])('rejects a request with %s, and sends nothing upstream', async (_label, overrides) => {
    const fetchMock = okResponse();

    const response = await postChallenge(createApp(testConfig, { fetch: fetchMock }), overrides);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /checkpoint/proximity', () => {
  const proximityBody = {
    session: VALID_SESSION,
    participant: VALID_PARTICIPANT,
    checkpoint: 2,
    location: { lat: 51.509948, long: -1.485923 },
  };

  it('forwards the request body upstream unchanged', async () => {
    let capturedBody: string | undefined;
    const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(JSON.stringify({ in_range: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/checkpoint/proximity')
      .send(proximityBody);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = vi.mocked(fetchMock).mock.calls[0]!;
    expect((calledUrl as URL).href).toBe('http://game-server.test/checkpoint/proximity');
    expect(calledInit).toMatchObject({ method: 'POST' });
    expect(JSON.parse(capturedBody as string)).toEqual(proximityBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ in_range: true });
  });

  it.each([
    ['a false verdict', 200, { in_range: false }],
    ['a 429', 429, { error: 'rate limited' }],
    ['a 404', 404, { error: 'unknown checkpoint' }],
  ])('passes back status and body unchanged for %s', async (_label, status, body) => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/checkpoint/proximity')
      .send(proximityBody);

    expect(response.status).toBe(status);
    expect(response.body).toEqual(body);
  });

  it('returns 502 when the game server cannot be reached', async () => {
    const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/checkpoint/proximity')
      .send(proximityBody);

    expect(response.status).toBe(502);
    expect((response.body as ErrorBody).error).toContain('connect ECONNREFUSED');
  });
});

describe('GET /checkpoint/challenge', () => {
  it('relays to the correct game-server URL and passes the response through', async () => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ pose: 'Stand next to the red door' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get(
      `/checkpoint/challenge?session=${VALID_SESSION}&checkpoint=2`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = vi.mocked(fetchMock).mock.calls[0]!;
    expect((calledUrl as URL).href).toBe(
      `http://game-server.test/sessions/${VALID_SESSION}/checkpoints/2/challenge`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ pose: 'Stand next to the red door' });
  });

  it.each([
    ['a null pose', 200, { pose: null }],
    ['a 404', 404, { error: 'unknown session or checkpoint' }],
  ])('passes back status and body unchanged for %s', async (_label, status, body) => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get(
      `/checkpoint/challenge?session=${VALID_SESSION}&checkpoint=2`,
    );

    expect(response.status).toBe(status);
    expect(response.body).toEqual(body);
  });

  it('returns 502 when the game server cannot be reached', async () => {
    const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get(
      `/checkpoint/challenge?session=${VALID_SESSION}&checkpoint=2`,
    );

    expect(response.status).toBe(502);
    expect((response.body as ErrorBody).error).toContain('connect ECONNREFUSED');
  });

  it.each([
    ['missing session', ''],
    ['invalid session', 'session=not-a-uuid&checkpoint=2'],
    ['missing checkpoint', `session=${VALID_SESSION}`],
    ['non-integer checkpoint', `session=${VALID_SESSION}&checkpoint=1.5`],
    ['checkpoint below 1', `session=${VALID_SESSION}&checkpoint=0`],
  ])('rejects a request with %s, and sends nothing upstream', async (_label, query) => {
    const fetchMock: typeof fetch = vi.fn();

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get(
      `/checkpoint/challenge?${query}`,
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /join', () => {
  const joinRequest = { code: 'FOX-7Q2K', consent: true };
  const joinResponse = {
    participant: '7c860ccc-9adf-4e22-b54f-3ff158f5d600',
    team: 'Red Foxes',
    session: {
      id: 'aeffe667-4f9f-4108-b5e2-56ae821fe413',
      name: 'Hyde Park Saturday Hunt',
      location: 'Hyde Park and Kensington Gardens, London',
      'start-time': '2026-10-03T10:00:00+01:00',
      'end-time': '2026-10-03T13:00:00+01:00',
    },
    checkpoints: 3,
  };

  it('relays to the correct URL and passes a 201 through unchanged', async () => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(joinResponse), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/join')
      .send(joinRequest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = vi.mocked(fetchMock).mock.calls[0]!;
    expect((calledUrl as URL).href).toBe('http://game-server.test/join');

    expect(response.status).toBe(201);
    expect(response.body).toEqual(joinResponse);
  });

  it('forwards the body unchanged, including one with no consent key at all', async () => {
    let capturedBody: string | undefined;
    const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response(JSON.stringify({ detail: 'consent is required' }), { status: 422 }));
    });

    // No "consent" field at all — this app must never add or default it.
    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/join')
      .send({ code: 'FOX-7Q2K' });

    expect(JSON.parse(capturedBody as string)).toEqual({ code: 'FOX-7Q2K' });
    expect(response.status).toBe(422);
  });

  it.each([
    [404, { detail: 'unknown code' }],
    [409, { detail: 'session has ended' }],
    [422, { detail: 'consent must be true' }],
  ])('passes back status and body unchanged for %i', async (status, body) => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/join')
      .send(joinRequest);

    expect(response.status).toBe(status);
    expect(response.body).toEqual(body);
  });

  it('returns 502 when the game server cannot be reached', async () => {
    const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const response = await request(createApp(testConfig, { fetch: fetchMock })).post('/join').send(joinRequest);

    expect(response.status).toBe(502);
    expect((response.body as ErrorBody).error).toContain('connect ECONNREFUSED');
  });

  it('returns 504 when the game server does not respond within the configured timeout', async () => {
    // A genuinely short real timeout rather than faked — see the equivalent
    // POST /challenge test for why.
    const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
    );

    const response = await request(createApp({ ...testConfig, gameServerTimeoutMs: 30 }, { fetch: fetchMock }))
      .post('/join')
      .send(joinRequest);

    expect(response.status).toBe(504);
  });
});

describe('GET /state', () => {
  const stateResponse = {
    status: 'playing',
    team: 'Red Foxes',
    progress: { completed: 1, total: 3 },
    current: {
      sequence: 2,
      position: 2,
      clue: 'He promised never to grow old; find him by the long water.',
      open: true,
    },
  };

  it('relays to the correct URL and passes a 200 through unchanged', async () => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(stateResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get(
      `/state?session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = vi.mocked(fetchMock).mock.calls[0]!;
    expect((calledUrl as URL).href).toBe(
      `http://game-server.test/sessions/${VALID_SESSION}/participants/${VALID_PARTICIPANT}/state`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(stateResponse);
  });

  it('passes back a 404 for an unknown session or participant, unchanged', async () => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get(
      `/state?session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}`,
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: 'not found' });
  });

  it.each([
    ['missing session', `participant=${VALID_PARTICIPANT}`],
    ['invalid session', `session=not-a-uuid&participant=${VALID_PARTICIPANT}`],
    ['missing participant', `session=${VALID_SESSION}`],
    ['invalid participant', `session=${VALID_SESSION}&participant=not-a-uuid`],
  ])('rejects a request with %s, and sends nothing upstream', async (_label, query) => {
    const fetchMock: typeof fetch = vi.fn();

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get(`/state?${query}`);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the game server cannot be reached', async () => {
    const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get(
      `/state?session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}`,
    );

    expect(response.status).toBe(502);
    expect((response.body as ErrorBody).error).toContain('connect ECONNREFUSED');
  });

  it('returns 504 when the game server does not respond within the configured timeout', async () => {
    const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
    );

    const response = await request(
      createApp({ ...testConfig, gameServerTimeoutMs: 30 }, { fetch: fetchMock }),
    ).get(`/state?session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}`);

    expect(response.status).toBe(504);
  });
});

describe('POST /arrive', () => {
  const arriveRequest = { session: VALID_SESSION, participant: VALID_PARTICIPANT, checkpoint: 2 };
  const arriveResponse = {
    checkpoint: 2,
    pose: 'Arms raised as if flying, facing the camera, with the landmark behind you.',
    code: '4719',
    'issued-at': '2026-10-03T09:41:05Z',
    'expires-at': '2026-10-03T09:51:05Z',
  };

  it('relays to the correct URL, sends only checkpoint upstream, and passes a 201 through unchanged', async () => {
    let capturedBody: string | undefined;
    const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(JSON.stringify(arriveResponse), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/arrive')
      .send(arriveRequest);

    const [calledUrl] = vi.mocked(fetchMock).mock.calls[0]!;
    expect((calledUrl as URL).href).toBe(
      `http://game-server.test/sessions/${VALID_SESSION}/participants/${VALID_PARTICIPANT}/arrive`,
    );
    expect(JSON.parse(capturedBody as string)).toEqual({ checkpoint: 2 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(arriveResponse);
  });

  it.each([
    [409, { detail: "session hasn't started" }],
    [409, { detail: 'not your current checkpoint' }],
    [422, { detail: 'invalid checkpoint' }],
    [404, { detail: 'not found' }],
  ])('passes back status and body unchanged for %i', async (status, body) => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/arrive')
      .send(arriveRequest);

    expect(response.status).toBe(status);
    expect(response.body).toEqual(body);
  });

  it.each([
    ['missing session', { ...arriveRequest, session: undefined }],
    ['invalid session', { ...arriveRequest, session: 'not-a-uuid' }],
    ['missing participant', { ...arriveRequest, participant: undefined }],
    ['invalid participant', { ...arriveRequest, participant: 'not-a-uuid' }],
    ['missing checkpoint', { ...arriveRequest, checkpoint: undefined }],
    ['non-integer checkpoint', { ...arriveRequest, checkpoint: 1.5 }],
    ['checkpoint below 1', { ...arriveRequest, checkpoint: 0 }],
    ['checkpoint as a string', { ...arriveRequest, checkpoint: '2' }],
  ])('rejects a request with %s, and sends nothing upstream', async (_label, body) => {
    const fetchMock: typeof fetch = vi.fn();

    const response = await request(createApp(testConfig, { fetch: fetchMock })).post('/arrive').send(body);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the game server cannot be reached', async () => {
    const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/arrive')
      .send(arriveRequest);

    expect(response.status).toBe(502);
    expect((response.body as ErrorBody).error).toContain('connect ECONNREFUSED');
  });

  it('returns 504 when the game server does not respond within the configured timeout', async () => {
    const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
    );

    const response = await request(createApp({ ...testConfig, gameServerTimeoutMs: 30 }, { fetch: fetchMock }))
      .post('/arrive')
      .send(arriveRequest);

    expect(response.status).toBe(504);
  });
});

describe('moderator relays', () => {
  const MODERATOR_AUTH = 'Bearer moderator-secret';
  const clock = {
    phase: 'running',
    'planned-start': '2026-10-03T10:00:00+01:00',
    'planned-end': '2026-10-03T13:00:00+01:00',
    'started-at': '2026-10-03T09:02:11Z',
    'stopped-at': null,
    'server-time': '2026-10-03T09:02:11Z',
  };
  const overview = {
    session: clock,
    teams: [
      {
        team: 'Red Foxes',
        joined: true,
        completed: 1,
        total: 3,
        points: 7,
        'in-review': 0,
        place: null,
        'last-completed': { sequence: 1, name: 'Stone fountain', verdict: 'pass', at: '2026-10-03T09:58:10Z' },
        current: { sequence: 2, name: 'Boy who never grew up' },
      },
    ],
    blocked: [{ at: '2026-10-03T13:05:02Z', team: 'Blue Herons', action: 'photo', code: 'session_stopped' }],
  };
  const review = {
    'to-review': [
      {
        submission: 42,
        team: 'Red Foxes',
        checkpoint: { sequence: 2, name: 'Lion fountain' },
        attempt: 1,
        'received-at': '2026-10-03T10:41:05Z',
        pose: 'Arms raised as if flying, facing the camera',
        scene: "A stone fountain with a lion's head spout",
        'reference-photos': 2,
        checks: [{ check: 'pose_correct', outcome: 'uncertain', confidence: 0.62, reason: '…', detail: 'One arm raised.' }],
        referee: { status: 'ok', 'error-code': null },
      },
    ],
    recent: [],
  };

  // Each relay, with how to call it for a given session and what it relays to.
  const relays = [
    {
      name: 'POST /moderator/start',
      method: 'POST',
      upstreamPath: 'start',
      success: { status: 201, body: clock },
      send: (app: ReturnType<typeof createApp>, session: unknown) =>
        request(app).post('/moderator/start').send({ session }),
    },
    {
      name: 'POST /moderator/stop',
      method: 'POST',
      upstreamPath: 'stop',
      success: { status: 200, body: { ...clock, phase: 'stopped', 'stopped-at': '2026-10-03T12:00:00Z' } },
      send: (app: ReturnType<typeof createApp>, session: unknown) =>
        request(app).post('/moderator/stop').send({ session }),
    },
    {
      name: 'GET /moderator/overview',
      method: 'GET',
      upstreamPath: 'overview',
      success: { status: 200, body: overview },
      send: (app: ReturnType<typeof createApp>, session: unknown) =>
        request(app)
          .get('/moderator/overview')
          .query(session === undefined ? {} : { session: session as string }),
    },
    {
      name: 'GET /moderator/review',
      method: 'GET',
      upstreamPath: 'review',
      success: { status: 200, body: review },
      send: (app: ReturnType<typeof createApp>, session: unknown) =>
        request(app)
          .get('/moderator/review')
          .query(session === undefined ? {} : { session: session as string }),
    },
  ] as const;

  describe.each(relays)('$name', ({ method, upstreamPath, success, send }) => {
    it('forwards the path, method and Authorization header, sends no body, and passes the response through', async () => {
      const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(success.status, success.body)));

      const response = await send(createApp(testConfig, { fetch: fetchMock }), VALID_SESSION).set(
        'Authorization',
        MODERATOR_AUTH,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = vi.mocked(fetchMock).mock.calls[0]!;
      expect((calledUrl as URL).href).toBe(`http://game-server.test/sessions/${VALID_SESSION}/${upstreamPath}`);
      expect(init?.method).toBe(method);
      expect(init?.headers).toEqual({ authorization: MODERATOR_AUTH });
      expect(init?.body).toBeUndefined();

      expect(response.status).toBe(success.status);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toEqual(success.body);
    });

    it('forwards a missing Authorization header as missing, and passes the 401 back', async () => {
      const unauthorised = { detail: 'moderator code required', code: 'moderator_unauthorised' };
      const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(401, unauthorised)));

      const response = await send(createApp(testConfig, { fetch: fetchMock }), VALID_SESSION);

      const [, init] = vi.mocked(fetchMock).mock.calls[0]!;
      expect(init?.headers).toEqual({});
      expect(response.status).toBe(401);
      expect(response.body).toEqual(unauthorised);
    });

    it('passes back a 404 for an unknown session unchanged', async () => {
      const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(404, { detail: 'not found' })));

      const response = await send(createApp(testConfig, { fetch: fetchMock }), VALID_SESSION).set(
        'Authorization',
        MODERATOR_AUTH,
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ detail: 'not found' });
    });

    it.each([
      ['missing', undefined],
      ['not a UUID', 'not-a-uuid'],
    ])('rejects a session that is %s with 400, and sends nothing upstream', async (_label, session) => {
      const fetchMock: typeof fetch = vi.fn();

      const response = await send(createApp(testConfig, { fetch: fetchMock }), session).set(
        'Authorization',
        MODERATOR_AUTH,
      );

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 502 when the game server cannot be reached', async () => {
      const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

      const response = await send(createApp(testConfig, { fetch: fetchMock }), VALID_SESSION);

      expect(response.status).toBe(502);
      expect((response.body as ErrorBody).error).toContain('connect ECONNREFUSED');
    });

    it('returns 504 when the game server does not respond within the configured timeout', async () => {
      const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
      );

      const response = await send(
        createApp({ ...testConfig, gameServerTimeoutMs: 30 }, { fetch: fetchMock }),
        VALID_SESSION,
      );

      expect(response.status).toBe(504);
    });
  });

  it.each([
    ['POST /moderator/start', 0, { detail: 'session has been stopped', code: 'session_stopped' }],
    ['POST /moderator/stop', 1, { detail: 'session has not started', code: 'session_not_started' }],
  ])('%s passes a 409 with its code through unchanged', async (_name, index, body) => {
    const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(409, body)));

    const response = await relays[index]!.send(createApp(testConfig, { fetch: fetchMock }), VALID_SESSION).set(
      'Authorization',
      MODERATOR_AUTH,
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual(body);
  });

  describe('POST /moderator/ruling', () => {
    const ruled = {
      submission: 42,
      verdict: 'pending',
      ruling: { ruling: 'approve', note: 'Arm just cropped', 'ruled-at': '2026-10-03T10:52:40Z' },
      'effective-verdict': 'pass',
    };
    const send = (app: ReturnType<typeof createApp>, body: object) =>
      request(app).post('/moderator/ruling').set('Authorization', MODERATOR_AUTH).send(body);

    it.each([
      ['approve', 'Arm just cropped'],
      ['reject', undefined],
    ])(
      'sends only { ruling: %j, note } to the submission, with the Authorization header, and passes the response through',
      async (ruling, note) => {
        const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(201, ruled)));

        const response = await send(createApp(testConfig, { fetch: fetchMock }), {
          session: VALID_SESSION,
          submission: 42,
          ruling,
          note,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [calledUrl, init] = vi.mocked(fetchMock).mock.calls[0]!;
        expect((calledUrl as URL).href).toBe(
          `http://game-server.test/sessions/${VALID_SESSION}/submissions/42/ruling`,
        );
        expect(init?.method).toBe('POST');
        expect(init?.headers).toEqual({ authorization: MODERATOR_AUTH, 'content-type': 'application/json' });
        expect(JSON.parse(init?.body as string)).toEqual(note === undefined ? { ruling } : { ruling, note });
        expect(response.status).toBe(201);
        expect(response.body).toEqual(ruled);
      },
    );

    it('passes a 200 for a changed ruling, and a 422 for an invalid one, through unchanged', async () => {
      const invalid = { detail: [{ msg: 'Input should be approve or reject' }] };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, ruled))
        .mockResolvedValueOnce(jsonResponse(422, invalid));
      const app = createApp(testConfig, { fetch: fetchMock });

      const changed = await send(app, { session: VALID_SESSION, submission: 42, ruling: 'reject' });
      const refused = await send(app, { session: VALID_SESSION, submission: 42, ruling: 'maybe' });

      expect(changed.status).toBe(200);
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual(invalid);
    });

    it('forwards a missing Authorization header as missing, and passes the 401 back', async () => {
      const unauthorised = { detail: 'moderator code required', code: 'moderator_unauthorised' };
      const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(401, unauthorised)));

      const response = await request(createApp(testConfig, { fetch: fetchMock }))
        .post('/moderator/ruling')
        .send({ session: VALID_SESSION, submission: 42, ruling: 'approve' });

      const [, init] = vi.mocked(fetchMock).mock.calls[0]!;
      expect(init?.headers).toEqual({ 'content-type': 'application/json' });
      expect(response.status).toBe(401);
      expect(response.body).toEqual(unauthorised);
    });

    it.each([
      ['a missing session', { submission: 42, ruling: 'approve' }],
      ['a session that is not a UUID', { session: 'not-a-uuid', submission: 42, ruling: 'approve' }],
      ['a missing submission', { session: VALID_SESSION, ruling: 'approve' }],
      ['a submission of 0', { session: VALID_SESSION, submission: 0, ruling: 'approve' }],
      ['a fractional submission', { session: VALID_SESSION, submission: 1.5, ruling: 'approve' }],
      ['a submission sent as text', { session: VALID_SESSION, submission: '42/../7', ruling: 'approve' }],
    ])('rejects %s with 400, and sends nothing upstream', async (_label, body) => {
      const fetchMock: typeof fetch = vi.fn();

      const response = await send(createApp(testConfig, { fetch: fetchMock }), body);

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 502 when the game server cannot be reached, and 504 when it is too slow', async () => {
      const unreachable: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));
      const slow: typeof fetch = vi.fn((_input, init?: FetchInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
      );
      const body = { session: VALID_SESSION, submission: 42, ruling: 'approve' };

      const notReached = await send(createApp(testConfig, { fetch: unreachable }), body);
      const tooSlow = await send(createApp({ ...testConfig, gameServerTimeoutMs: 30 }, { fetch: slow }), body);

      expect(notReached.status).toBe(502);
      expect(tooSlow.status).toBe(504);
    });
  });

  // The two photo relays: a player's photo and a checkpoint's reference photo.
  const photoRelays = [
    {
      name: 'GET /moderator/photo',
      query: { submission: '42' },
      upstreamPath: 'submissions/42/photo',
      invalid: [
        ['a missing submission', {}],
        ['a submission of 0', { submission: '0' }],
        ['a submission that is not a number', { submission: '42/../7' }],
      ],
      path: '/moderator/photo',
    },
    {
      name: 'GET /moderator/reference-photo',
      query: { checkpoint: '2', position: '0' },
      upstreamPath: 'checkpoints/2/reference-photos/0',
      invalid: [
        ['a missing checkpoint', { position: '0' }],
        ['a checkpoint of 0', { checkpoint: '0', position: '0' }],
        ['a missing position', { checkpoint: '2' }],
        ['an empty position', { checkpoint: '2', position: '' }],
        ['a negative position', { checkpoint: '2', position: '-1' }],
        ['a fractional position', { checkpoint: '2', position: '0.5' }],
      ],
      path: '/moderator/reference-photo',
    },
  ] as const;

  describe.each(photoRelays)('$name', ({ query, upstreamPath, invalid, path }) => {
    const get = (app: ReturnType<typeof createApp>, params: Record<string, string>) =>
      request(app)
        .get(path)
        .query(params)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });

    it('forwards the Authorization header and streams the JPEG back with Cache-Control: no-store', async () => {
      const fetchMock: typeof fetch = vi.fn(() =>
        Promise.resolve(new Response(jpegBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } })),
      );

      const response = await get(createApp(testConfig, { fetch: fetchMock }), {
        session: VALID_SESSION,
        ...query,
      }).set('Authorization', MODERATOR_AUTH);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = vi.mocked(fetchMock).mock.calls[0]!;
      expect((calledUrl as URL).href).toBe(`http://game-server.test/sessions/${VALID_SESSION}/${upstreamPath}`);
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ authorization: MODERATOR_AUTH });
      expect(init?.body).toBeUndefined();

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual(jpegBytes);
    });

    it('forwards a missing Authorization header as missing, and passes the 401 back', async () => {
      const unauthorised = { detail: 'moderator code required', code: 'moderator_unauthorised' };
      const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(401, unauthorised)));

      const response = await get(createApp(testConfig, { fetch: fetchMock }), { session: VALID_SESSION, ...query });

      const [, init] = vi.mocked(fetchMock).mock.calls[0]!;
      expect(init?.headers).toEqual({});
      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.parse((response.body as Buffer).toString())).toEqual(unauthorised);
    });

    it('passes a 404 back unchanged', async () => {
      const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(404, { detail: 'photo not found' })));

      const response = await get(createApp(testConfig, { fetch: fetchMock }), {
        session: VALID_SESSION,
        ...query,
      }).set('Authorization', MODERATOR_AUTH);

      expect(response.status).toBe(404);
      expect(JSON.parse((response.body as Buffer).toString())).toEqual({ detail: 'photo not found' });
    });

    const badRequests: [string, Record<string, string>][] = [
      ['a missing session', { ...query }],
      ['a session that is not a UUID', { ...query, session: 'not-a-uuid' }],
      ...invalid.map(([label, params]): [string, Record<string, string>] => [
        label,
        { session: VALID_SESSION, ...params },
      ]),
    ];

    it.each(badRequests)('rejects %s with 400, and sends nothing upstream', async (_label, params) => {
      const fetchMock: typeof fetch = vi.fn();

      const response = await get(createApp(testConfig, { fetch: fetchMock }), params).set(
        'Authorization',
        MODERATOR_AUTH,
      );

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 502 when the game server cannot be reached', async () => {
      const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

      const response = await get(createApp(testConfig, { fetch: fetchMock }), { session: VALID_SESSION, ...query });

      expect(response.status).toBe(502);
    });

    it('returns 504 when the game server does not respond within the configured timeout', async () => {
      const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
      );

      const response = await get(createApp({ ...testConfig, gameServerTimeoutMs: 30 }, { fetch: fetchMock }), {
        session: VALID_SESSION,
        ...query,
      });

      expect(response.status).toBe(504);
    });
  });

  it('never logs the moderator code, a note or a photo, whatever the outcome', async () => {
    const secret = 'Bearer never-log-this-code';
    const note = 'never-log-this-note';
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      for (const upstream of [
        () => Promise.resolve(jsonResponse(200, review)),
        () => Promise.resolve(new Response(jpegBytes, { headers: { 'content-type': 'image/jpeg' } })),
        () => Promise.resolve(jsonResponse(401, { detail: 'moderator code required' })),
        () => Promise.reject(new Error('connect ECONNREFUSED')),
      ]) {
        const app = createApp(testConfig, { fetch: vi.fn(upstream) });
        await request(app).get(`/moderator/review?session=${VALID_SESSION}`).set('Authorization', secret);
        await request(app).get(`/moderator/photo?session=${VALID_SESSION}&submission=42`).set('Authorization', secret);
        await request(app)
          .get(`/moderator/reference-photo?session=${VALID_SESSION}&checkpoint=2&position=0`)
          .set('Authorization', secret);
        await request(app)
          .post('/moderator/ruling')
          .set('Authorization', secret)
          .send({ session: VALID_SESSION, submission: 42, ruling: 'approve', note });
      }

      for (const spy of logged) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of logged) {
        spy.mockRestore();
      }
    }
  });
});

describe('game loop relays pass new fields through unchanged', () => {
  it('passes the new `session` and `score` fields in a /state body', async () => {
    const state = {
      status: 'playing',
      team: 'Red Foxes',
      session: { phase: 'running', 'server-time': '2026-10-03T09:02:11Z' },
      score: { points: 7, 'in-review': 0, place: null },
      progress: { completed: 1, total: 3 },
      current: null,
    };
    const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(200, state)));

    const response = await request(createApp(testConfig, { fetch: fetchMock })).get(
      `/state?session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}`,
    );

    expect(response.body).toEqual(state);
  });

  it.each([
    [
      'POST /join',
      (app: ReturnType<typeof createApp>) => request(app).post('/join').send({ code: 'FOX-7Q2K', consent: true }),
    ],
    [
      'POST /arrive',
      (app: ReturnType<typeof createApp>) =>
        request(app).post('/arrive').send({ session: VALID_SESSION, participant: VALID_PARTICIPANT, checkpoint: 2 }),
    ],
    [
      'GET /state',
      (app: ReturnType<typeof createApp>) =>
        request(app).get(`/state?session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}`),
    ],
  ])('%s passes `code` in an error body through unchanged', async (_name, send) => {
    const body = { detail: 'session has not started', code: 'session_not_started' };
    const fetchMock: typeof fetch = vi.fn(() => Promise.resolve(jsonResponse(409, body)));

    const response = await send(createApp(testConfig, { fetch: fetchMock }));

    expect(response.status).toBe(409);
    expect(response.body).toEqual(body);
  });
});

describe('unknown routes', () => {
  it('responds with 404', async () => {
    const response = await request(createApp(testConfig)).get('/nope');

    expect(response.status).toBe(404);
  });
});
