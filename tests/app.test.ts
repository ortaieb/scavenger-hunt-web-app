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

describe('GET /', () => {
  it('returns "hello, world!" as plain text', async () => {
    const response = await request(createApp(testConfig)).get('/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toBe('hello, world!');
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

describe('unknown routes', () => {
  it('responds with 404', async () => {
    const response = await request(createApp(testConfig)).get('/nope');

    expect(response.status).toBe(404);
  });
});
