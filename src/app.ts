import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import type { Config } from './config.ts';

// Resolves to `src/public` in dev (running src/*.ts directly) and to
// `dist/public` once built, since `npm run build` copies `src/public` there
// alongside the compiled `dist/app.js`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

export type AppConfig = Pick<Config, 'backendUploadUrl'>;

/**
 * Builds the Express application. Kept separate from the server bootstrap so
 * tests can exercise the routes without binding a port.
 */
export function createApp(config: AppConfig): Express {
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

  // The FastAPI upload backend is built separately; the client fetches its
  // URL here rather than hardcoding it, so it can move without a redeploy of
  // this static page.
  app.get('/api/challenge/config', (_req: Request, res: Response) => {
    res.json({ uploadUrl: config.backendUploadUrl });
  });

  return app;
}
