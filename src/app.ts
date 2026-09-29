import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response as ExpressResponse } from 'express';
import multer from 'multer';
import type { Config } from './config.ts';

// Resolves to `src/public` in dev (running src/*.ts directly) and to
// `dist/public` once built, since `npm run build` copies `src/public` there
// alongside the compiled `dist/app.js`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

export type AppConfig = Pick<Config, 'gameServerUrl' | 'gameServerTimeoutMs'>;

export interface AppDeps {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Returns the checkpoint number, or undefined if it isn't an integer >= 1. */
function parseCheckpoint(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const checkpoint = Number(value);
  return Number.isInteger(checkpoint) && checkpoint >= 1 ? checkpoint : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Calls fetchImpl, aborting it if it hasn't settled within timeoutMs. On a
 * timeout this rejects with an AbortError (name === 'AbortError'), same as a
 * real aborted fetch, so callers can tell "took too long" apart from any
 * other failure to reach the server (see issue #21).
 */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Builds the Express application. Kept separate from the server bootstrap so
 * tests can exercise the routes without binding a port.
 */
export function createApp(config: AppConfig, deps: AppDeps = {}): Express {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const app = express();

  app.disable('x-powered-by');

  app.get('/', (_req: Request, res: ExpressResponse) => {
    res.type('text/plain').send('hello, world!');
  });

  app.use(express.static(publicDir));

  // The in-app camera + geolocation capture page. Served explicitly (rather
  // than relying on express.static's index/extension handling) so it works
  // at the clean `/challenge` path the issue asks for.
  app.get('/challenge', (_req: Request, res: ExpressResponse) => {
    res.sendFile(path.join(publicDir, 'challenge.html'));
  });

  // Relays a capture to the game-server (a separate service, see issue #7).
  // The browser can't call it directly: this app runs over HTTPS off
  // localhost (required for the camera/geolocation APIs — see issue #3),
  // and the game-server isn't guaranteed to serve HTTPS or allow our origin
  // via CORS, so the request has to go server-to-server.
  // Express 5 forwards a rejected handler promise to the error middleware,
  // so this can be async without an extra try/catch wrapper at the top level.
  app.post('/challenge', upload.single('image'), async (req: Request, res: ExpressResponse) => {
    const { latitude, longitude, capturedAt, session, participant, checkpoint } = req.body as Record<
      string,
      string | undefined
    >;

    if (!req.file) {
      res.status(400).json({ error: 'image is required' });
      return;
    }
    if (!latitude || !longitude || !capturedAt) {
      res.status(400).json({ error: 'latitude, longitude and capturedAt are required' });
      return;
    }
    // There's no join flow yet: the page reads these from its own query
    // string and posts them with the capture (see issue #14). Validated
    // here rather than trusted, since the client's own check can be bypassed.
    if (!isValidUuid(session) || !isValidUuid(participant)) {
      res.status(400).json({ error: 'session and participant must be valid UUIDs' });
      return;
    }
    const checkpointNumber = parseCheckpoint(checkpoint);
    if (checkpointNumber === undefined) {
      res.status(400).json({ error: 'checkpoint must be an integer >= 1' });
      return;
    }

    // Only raw claims go upstream — location, capture-time and the image.
    // Nothing here may look like a pre-computed result: the game-server
    // alone decides the verdict (see issue #14).
    const metadata = {
      session,
      participant,
      checkpoint: checkpointNumber,
      location: { lat: Number(latitude), long: Number(longitude) },
      'capture-time': capturedAt,
    };

    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    form.append(
      'challenge-image',
      new Blob([req.file.buffer], { type: req.file.mimetype || 'image/jpeg' }),
      'photo.jpeg',
    );

    try {
      const upstream = await fetchWithTimeout(
        doFetch,
        new URL('/challenge', config.gameServerUrl),
        { method: 'POST', body: form },
        config.gameServerTimeoutMs,
      );
      const body = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'text/plain')
        .send(body);
    } catch (err) {
      // The referee now runs before the game-server responds, which can
      // take a while (see issue #21) — distinguish "took too long" from any
      // other failure to reach it, so the player sees the right message.
      if (err instanceof Error && err.name === 'AbortError') {
        res.status(504).json({ error: 'The game server took too long to respond' });
        return;
      }
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  });

  // Relays a courtesy proximity check to the game-server, for the same
  // HTTPS/CORS reasons as /challenge. Forwards the request body unchanged
  // and passes the upstream status/body straight back — this is advisory
  // only (see issue #15), so it does no validation of its own; the
  // game-server's answer (in_range: true|false) never includes checkpoint
  // coordinates, distance or a radius, and neither does this relay.
  app.post('/checkpoint/proximity', express.json(), async (req: Request, res: ExpressResponse) => {
    try {
      const upstream = await doFetch(new URL('/checkpoint/proximity', config.gameServerUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const body = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(body);
    } catch (err) {
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  });

  // Relays the checkpoint's pose instruction, for the same HTTPS/CORS
  // reasons as the other relays. Validates its own input (unlike
  // /checkpoint/proximity, this one takes query params, not a body the
  // game-server can reject on its own), then passes the upstream status and
  // body straight back unchanged — this app never sees or reinterprets the
  // pose, only relays it (see issue #20).
  app.get('/checkpoint/challenge', async (req: Request, res: ExpressResponse) => {
    const { session, checkpoint } = req.query as Record<string, string | undefined>;

    if (!isValidUuid(session)) {
      res.status(400).json({ error: 'session must be a valid UUID' });
      return;
    }
    const checkpointNumber = parseCheckpoint(checkpoint);
    if (checkpointNumber === undefined) {
      res.status(400).json({ error: 'checkpoint must be an integer >= 1' });
      return;
    }

    try {
      const upstream = await doFetch(
        new URL(
          `/sessions/${encodeURIComponent(session)}/checkpoints/${checkpointNumber}/challenge`,
          config.gameServerUrl,
        ),
      );
      const body = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(body);
    } catch (err) {
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  });

  return app;
}
