import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const testConfig = { gameServerUrl: 'http://game-server.test' };

const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

interface ErrorBody {
  error: string;
}

type FetchInit = Parameters<typeof fetch>[1];

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
  function postChallenge(app: ReturnType<typeof createApp>) {
    return request(app)
      .post('/challenge')
      .field('latitude', '51.509948')
      .field('longitude', '-1.485923')
      .field('capturedAt', '2012-03-29T10:05:45-06:00')
      .attach('image', jpegBytes, { filename: 'photo.jpg', contentType: 'image/jpeg' });
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

  it('sends the metadata contract the game server expects', async () => {
    let capturedForm: FormData | undefined;
    const fetchMock: typeof fetch = vi.fn((_input, init?: FetchInit) => {
      capturedForm = init?.body as FormData;
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    await postChallenge(createApp(testConfig, { fetch: fetchMock }));

    const metadataField = capturedForm?.get('metadata');
    expect(typeof metadataField).toBe('string');
    expect(JSON.parse(metadataField as string)).toEqual({
      session: 'n/a',
      participant: 'n/a',
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

  it('returns 502 when the game server cannot be reached', async () => {
    const fetchMock: typeof fetch = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const response = await postChallenge(createApp(testConfig, { fetch: fetchMock }));

    expect(response.status).toBe(502);
    expect((response.body as ErrorBody).error).toContain('connect ECONNREFUSED');
  });

  it('rejects a request with no image', async () => {
    const fetchMock = okResponse();

    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .post('/challenge')
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
      .attach('image', jpegBytes, { filename: 'photo.jpg', contentType: 'image/jpeg' });

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
