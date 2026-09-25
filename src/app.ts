import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import multer from 'multer';
import type { Config } from './config.ts';

// Resolves to `src/public` in dev (running src/*.ts directly) and to
// `dist/public` once built, since `npm run build` copies `src/public` there
// alongside the compiled `dist/app.js`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

export type AppConfig = Pick<Config, 'gameServerUrl'>;

export interface AppDeps {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the Express application. Kept separate from the server bootstrap so
 * tests can exercise the routes without binding a port.
 */
export function createApp(config: AppConfig, deps: AppDeps = {}): Express {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const app = express();

  app.disable('x-powered-by');

  app.get('/', (_req: Request, res: Response) => {
    res.type('text/plain').send('hello, world!');
  });

  app.use(express.static(publicDir));

  // The in-app camera + geolocation capture page. Served explicitly (rather
  // than relying on express.static's index/extension handling) so it works
  // at the clean `/challenge` path the issue asks for.
  app.get('/challenge', (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'challenge.html'));
  });

  // Relays a capture to the game-server (a separate service, see issue #7).
  // The browser can't call it directly: this app runs over HTTPS off
  // localhost (required for the camera/geolocation APIs — see issue #3),
  // and the game-server isn't guaranteed to serve HTTPS or allow our origin
  // via CORS, so the request has to go server-to-server.
  // Express 5 forwards a rejected handler promise to the error middleware,
  // so this can be async without an extra try/catch wrapper at the top level.
  app.post('/challenge', upload.single('image'), async (req: Request, res: Response) => {
    const { latitude, longitude, capturedAt } = req.body as Record<string, string | undefined>;

    if (!req.file) {
      res.status(400).json({ error: 'image is required' });
      return;
    }
    if (!latitude || !longitude || !capturedAt) {
      res.status(400).json({ error: 'latitude, longitude and capturedAt are required' });
      return;
    }

    // session/participant are left as "n/a" at this stage (see issue #7).
    const metadata = {
      session: 'n/a',
      participant: 'n/a',
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
      const upstream = await doFetch(new URL('/challenge', config.gameServerUrl), {
        method: 'POST',
        body: form,
      });
      const body = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'text/plain')
        .send(body);
    } catch (err) {
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  });

  return app;
}
