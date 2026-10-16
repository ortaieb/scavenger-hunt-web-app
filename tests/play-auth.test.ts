import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { APP_ORIGIN, forgedToken, JWT_KEY, PUBLISHABLE_KEY, sessionToken } from './clerk-token.js';

const VALID_SESSION = '11111111-1111-4111-8111-111111111111';
const VALID_PARTICIPANT = '22222222-2222-4222-8222-222222222222';

const baseConfig = { gameServerUrl: 'http://game-server.test', gameServerTimeoutMs: 5000 };
const clerkConfig = {
  ...baseConfig,
  clerkPublishableKey: PUBLISHABLE_KEY,
  clerkSecretKey: 'sk_test_unused-because-the-jwt-key-checks-tokens',
  clerkJwtKey: JWT_KEY,
  appOrigin: APP_ORIGIN,
};
const requiredConfig = { ...clerkConfig, requireSignIn: true };

const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function okFetch() {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

type App = ReturnType<typeof createApp>;

// Every play relay, with how to call it and the token to send.
const playCalls: [string, (app: App, token?: string) => request.Test][] = [
  [
    'POST /join',
    (app, token) => withToken(request(app).post('/join').send({ code: 'FOX-1', consent: true }), token),
  ],
  [
    'GET /state',
    (app, token) =>
      withToken(request(app).get(`/state?session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}`), token),
  ],
  [
    'POST /arrive',
    (app, token) =>
      withToken(
        request(app).post('/arrive').send({ session: VALID_SESSION, participant: VALID_PARTICIPANT, checkpoint: 2 }),
        token,
      ),
  ],
  [
    'POST /challenge',
    (app, token) =>
      withToken(
        request(app)
          .post('/challenge')
          .field('latitude', '51.5')
          .field('longitude', '-0.1')
          .field('capturedAt', '2026-10-15T12:00:00Z')
          .field('session', VALID_SESSION)
          .field('participant', VALID_PARTICIPANT)
          .field('checkpoint', '2')
          .attach('image', jpegBytes, { filename: 'photo.jpg', contentType: 'image/jpeg' }),
        token,
      ),
  ],
  [
    'POST /checkpoint/proximity',
    (app, token) =>
      withToken(
        request(app)
          .post('/checkpoint/proximity')
          .send({
            session: VALID_SESSION,
            participant: VALID_PARTICIPANT,
            checkpoint: 2,
            location: { lat: 51.5, long: -0.1 },
          }),
        token,
      ),
  ],
];

function withToken(test: request.Test, token: string | undefined): request.Test {
  return token === undefined ? test : test.set('authorization', `Bearer ${token}`);
}

function sentAuthorization(fetchMock: ReturnType<typeof okFetch>): string | undefined {
  const init = (fetchMock.mock.calls[0] as [URL, RequestInit])[1];
  return (init.headers as Record<string, string> | undefined)?.authorization;
}

describe.each(playCalls)('%s with sign-in not required', (_name, send) => {
  it('forwards the Authorization header unchanged', async () => {
    const fetchMock = okFetch();

    const response = await send(createApp(clerkConfig, { fetch: fetchMock }), 'any.opaque.token');

    expect(response.status).toBe(200);
    expect(sentAuthorization(fetchMock)).toBe('Bearer any.opaque.token');
  });

  it('adds no Authorization when there is none', async () => {
    const fetchMock = okFetch();

    const response = await send(createApp(clerkConfig, { fetch: fetchMock }));

    expect(response.status).toBe(200);
    expect(sentAuthorization(fetchMock)).toBeUndefined();
  });

  it('works with Clerk not set up at all', async () => {
    const fetchMock = okFetch();

    const response = await send(createApp(baseConfig, { fetch: fetchMock }));

    expect(response.status).toBe(200);
    expect(sentAuthorization(fetchMock)).toBeUndefined();
  });
});

describe.each(playCalls)('%s with sign-in required', (_name, send) => {
  it('forwards a valid token unchanged', async () => {
    const fetchMock = okFetch();
    const token = sessionToken();

    const response = await send(createApp(requiredConfig, { fetch: fetchMock }), token);

    expect(response.status).toBe(200);
    expect(sentAuthorization(fetchMock)).toBe(`Bearer ${token}`);
  });

  it.each([
    ['no token', undefined],
    ['an expired token', sessionToken({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ['a token for another origin', sessionToken({ azp: 'https://evil.example' })],
    ['a token signed by another key', forgedToken()],
    ['garbage', 'not-a-token'],
  ])('answers 401 sign_in_required for %s, without calling the game-server', async (_case, token) => {
    const fetchMock = okFetch();

    const response = await send(createApp(requiredConfig, { fetch: fetchMock }), token);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: 'sign-in required', code: 'sign_in_required' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns everyone away when Clerk is not set up, rather than letting everyone in', async () => {
    const fetchMock = okFetch();

    const response = await send(createApp({ ...baseConfig, requireSignIn: true }, { fetch: fetchMock }), sessionToken());

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the rest of the app with sign-in required', () => {
  it.each(['/', '/play', '/sign-in', '/config', '/health', '/challenge'])(
    'still serves %s to a signed-out visitor, with no redirect',
    async (route) => {
      const response = await request(createApp(requiredConfig, { fetch: okFetch() })).get(route);

      expect(response.status).toBe(200);
    },
  );

});

// The moderator and designer relays sign in with an account too (issue #67).
const DRAFT = '5b0c7a1e-1111-4111-8111-111111111111';
const accountCalls: [string, (app: App, token?: string) => request.Test][] = [
  ['POST /moderator/start', (app, token) => withToken(request(app).post('/moderator/start').send({ session: VALID_SESSION }), token)],
  ['GET /moderator/overview', (app, token) => withToken(request(app).get(`/moderator/overview?session=${VALID_SESSION}`), token)],
  ['GET /moderator/review', (app, token) => withToken(request(app).get(`/moderator/review?session=${VALID_SESSION}`), token)],
  [
    'POST /moderator/ruling',
    (app, token) =>
      withToken(
        request(app).post('/moderator/ruling').send({ session: VALID_SESSION, submission: 1, ruling: 'approve' }),
        token,
      ),
  ],
  ['GET /moderator/photo', (app, token) => withToken(request(app).get(`/moderator/photo?session=${VALID_SESSION}&submission=1`), token)],
  [
    'POST /moderator/moderators',
    (app, token) =>
      withToken(request(app).post('/moderator/moderators').send({ session: VALID_SESSION, email: 'bob@example.com' }), token),
  ],
  [
    'DELETE /moderator/moderators',
    (app, token) => withToken(request(app).delete(`/moderator/moderators?session=${VALID_SESSION}&pid=p_1`), token),
  ],
  ['GET /designer/drafts', (app, token) => withToken(request(app).get('/designer/drafts'), token)],
  ['POST /designer/drafts', (app, token) => withToken(request(app).post('/designer/drafts').send({ area: 'x' }), token)],
  ['GET /designer/drafts/:draft', (app, token) => withToken(request(app).get(`/designer/drafts/${DRAFT}`), token)],
  [
    'PATCH /designer/drafts/:draft/checkpoints/:position',
    (app, token) => withToken(request(app).patch(`/designer/drafts/${DRAFT}/checkpoints/1`).send({ review: 'accepted' }), token),
  ],
  ['POST /designer/drafts/:draft/publish', (app, token) => withToken(request(app).post(`/designer/drafts/${DRAFT}/publish`).send({}), token)],
  ['GET /designer/drafts/:draft/publication', (app, token) => withToken(request(app).get(`/designer/drafts/${DRAFT}/publication`), token)],
];

describe.each(accountCalls)('%s', (_name, send) => {
  it('forwards a valid token unchanged when sign-in is required', async () => {
    const fetchMock = okFetch();
    const token = sessionToken();

    const response = await send(createApp(requiredConfig, { fetch: fetchMock }), token);

    expect(response.status).toBe(200);
    expect(sentAuthorization(fetchMock)).toBe(`Bearer ${token}`);
  });

  it.each([
    ['no token', undefined],
    ['a token signed by another key', forgedToken()],
  ])('answers 401 sign_in_required for %s, without calling the game-server', async (_case, token) => {
    const fetchMock = okFetch();

    const response = await send(createApp(requiredConfig, { fetch: fetchMock }), token);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: 'sign-in required', code: 'sign_in_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards whatever Authorization there is, and adds none, when sign-in is not required', async () => {
    const withIt = okFetch();
    const without = okFetch();

    await send(createApp(clerkConfig, { fetch: withIt }), 'a-moderator-code');
    await send(createApp(clerkConfig, { fetch: without }));

    expect(sentAuthorization(withIt)).toBe('Bearer a-moderator-code');
    expect(sentAuthorization(without)).toBeUndefined();
  });
});

describe('POST /me/provision', () => {
  it('relays to the game-server with the token, uncached', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"pid":"p_1"}', { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const token = sessionToken();

    const response = await request(createApp(requiredConfig, { fetch: fetchMock }))
      .post('/me/provision')
      .set('authorization', `Bearer ${token}`);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe('http://game-server.test/me/provision');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ pid: 'p_1' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('adds no Authorization when there is none, and passes the game-server\'s 401 through', async () => {
    const body = { detail: 'unauthorised', code: 'unauthorised' };
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 401, headers: { 'content-type': 'application/json' } })),
    );

    const response = await request(createApp(clerkConfig, { fetch: fetchMock })).post('/me/provision');

    expect((fetchMock.mock.calls[0] as [URL, RequestInit])[1].headers).toEqual({});
    expect(response.status).toBe(401);
    expect(response.body).toEqual(body);
  });

  it('answers 401 without calling the game-server when sign-in is required and there is no player', async () => {
    const fetchMock = okFetch();

    const response = await request(createApp(requiredConfig, { fetch: fetchMock })).post('/me/provision');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: 'sign-in required', code: 'sign_in_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 502 when the game-server cannot be reached', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));

    const response = await request(createApp(clerkConfig, { fetch: fetchMock })).post('/me/provision');

    expect(response.status).toBe(502);
  });
});

describe('POST /webhooks/clerk', () => {
  const svixHeaders = {
    'svix-id': 'msg_2abc',
    'svix-timestamp': '1760000000',
    'svix-signature': 'v1,Zm9vYmFy v1,YmF6',
  };

  it('passes the raw body byte for byte, with the Svix headers, and returns the status', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"ok":true}', { status: 202 })));
    // Whitespace, key order, escapes and a non-ASCII character: anything a
    // JSON parse and re-encode would change, and the signature would break.
    const text = '{ "type":"user.created",\n  "data" : {"id":"user_1","name":"Zoë \\u00e9"} ,"a":1.0 }';
    const raw = Buffer.from(text, 'utf8');

    const response = await request(createApp(requiredConfig, { fetch: fetchMock }))
      .post('/webhooks/clerk')
      .set('content-type', 'application/json')
      .set(svixHeaders)
      .send(text);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe('http://game-server.test/internal/clerk-events');
    expect(init.method).toBe('POST');
    expect(Buffer.from(init.body as Buffer).equals(raw)).toBe(true);
    expect(init.headers).toEqual({ 'content-type': 'application/json', ...svixHeaders });
    expect(response.status).toBe(202);
  });

  it('needs no sign-in, adds no Authorization and passes none on', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));

    const response = await request(createApp(requiredConfig, { fetch: fetchMock }))
      .post('/webhooks/clerk')
      .set('authorization', `Bearer ${sessionToken()}`)
      .set('content-type', 'application/json')
      .set(svixHeaders)
      .send('{}');

    expect(response.status).toBe(204);
    expect((fetchMock.mock.calls[0] as [URL, RequestInit])[1].headers).not.toHaveProperty('authorization');
  });

  it('passes the game-server\'s refusal of a bad signature through', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('{"detail":"bad signature"}', { status: 400, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const response = await request(createApp(clerkConfig, { fetch: fetchMock }))
      .post('/webhooks/clerk')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ detail: 'bad signature' });
    expect((fetchMock.mock.calls[0] as [URL, RequestInit])[1].headers).toEqual({ 'content-type': 'application/json' });
  });

  it('answers 502 when the game-server cannot be reached, so Svix retries', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));

    const response = await request(createApp(clerkConfig, { fetch: fetchMock }))
      .post('/webhooks/clerk')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(502);
  });

  it('refuses a body over 1 MB without calling the game-server', async () => {
    const fetchMock = okFetch();

    const response = await request(createApp(clerkConfig, { fetch: fetchMock }))
      .post('/webhooks/clerk')
      .set('content-type', 'application/json')
      .send(Buffer.alloc(1024 * 1024 + 1, 'a'));

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs nothing about the event or the token', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const token = sessionToken();

    await request(createApp(requiredConfig, { fetch: okFetch() }))
      .post('/webhooks/clerk')
      .set('content-type', 'application/json')
      .set(svixHeaders)
      .send('{"email":"NEVERLOG@example.com"}');
    await request(createApp(requiredConfig, { fetch: okFetch() })).post('/join').set('authorization', `Bearer ${token}`);
    await request(createApp(requiredConfig, { fetch: okFetch() })).post('/join').set('authorization', 'Bearer bad');

    for (const log of logs) {
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    }
  });
});
