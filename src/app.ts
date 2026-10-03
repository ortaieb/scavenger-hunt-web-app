import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response as ExpressResponse } from 'express';
import { marked } from 'marked';
import multer from 'multer';
import type { Config } from './config.ts';

// Resolves to `src/public` in dev (running src/*.ts directly) and to
// `dist/public` once built, since `npm run build` copies `src/public` there
// alongside the compiled `dist/app.js`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
// The player-facing docs live in the repo's `docs/` (see issue #40): one
// level up from both `src/` and `dist/`, and copied into the Docker image
// alongside `dist/`.
const docsDir = path.join(__dirname, '..', 'docs');

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

function isValidUuid(value: unknown): value is string {
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

/** Like parseCheckpoint, but for a value already parsed from a JSON body. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * Renders one of our own Markdown docs as a phone-friendly page, styled
 * like /play. HTML comments (notes to whoever fills in the doc) are
 * dropped. Read and rendered once, on first request.
 */
function markdownPage(file: string, title: string): () => Promise<string> {
  let page: Promise<string> | undefined;
  return () => {
    page ??= readFile(path.join(docsDir, file), 'utf8')
      .then((markdown) =>
        rewriteDocLinks(marked.parse(markdown.replace(/<!--[\s\S]*?-->/g, ''), { async: false })),
      )
      .then(
        (body) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${escapeHtml(title)} — Scavenger Hunt</title>
    <link rel="stylesheet" href="/play.css" />
  </head>
  <body>
    <main class="doc">
      <a class="doc-back" href="/play">‹ Back to the game</a>
${body}
    </main>
  </body>
</html>
`,
      )
      .catch((err: unknown) => {
        // Don't cache a failure: try again on the next request.
        page = undefined;
        throw err;
      });
    return page;
  };
}

// The docs link to each other by file name, so the links work on GitHub
// too; served by this app, they go to its own pages instead.
const DOC_ROUTES: Record<string, string> = {
  'privacy-notice.md': '/privacy',
  'user-guide.md': '/how-to-play',
  'moderator-guide.md': '/moderator-guide',
};

function rewriteDocLinks(html: string): string {
  return html.replace(/href="([\w-]+\.md)"/g, (match, file: string) =>
    DOC_ROUTES[file] ? `href="${DOC_ROUTES[file]}"` : match,
  );
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

  // The participant app (see issue #40) is the front door: `/` and `/play`
  // both serve it.
  const sendPlay = (_req: Request, res: ExpressResponse) => {
    res.sendFile(path.join(publicDir, 'play.html'));
  };
  app.get('/', sendPlay);
  app.get('/play', sendPlay);

  // The moderator screen (see issue #44). The session id comes from the
  // link (/moderator?session=<uuid>); the moderator code is typed on the
  // page and only ever sent in the Authorization header.
  app.get('/moderator', (_req: Request, res: ExpressResponse) => {
    res.sendFile(path.join(publicDir, 'moderator.html'));
  });

  const privacyPage = markdownPage('privacy-notice.md', 'Your photos and privacy');
  app.get('/privacy', async (_req: Request, res: ExpressResponse) => {
    res.type('html').send(await privacyPage());
  });

  const userGuidePage = markdownPage('user-guide.md', 'How to play');
  app.get('/how-to-play', async (_req: Request, res: ExpressResponse) => {
    res.type('html').send(await userGuidePage());
  });

  const moderatorGuidePage = markdownPage('moderator-guide.md', 'Moderator guide');
  app.get('/moderator-guide', async (_req: Request, res: ExpressResponse) => {
    res.type('html').send(await moderatorGuidePage());
  });

  // The guides' screenshots, linked as `images/…` so they also show on
  // GitHub (see issue #45).
  app.use('/images', express.static(path.join(docsDir, 'images')));

  // Liveness signal for the deployment platform (Railway — see issue #24)
  // to decide when to switch traffic to a new instance. Deliberately cheap:
  // no upstream calls, so a blip in the game-server doesn't make this app
  // look unhealthy and get cycled for no reason.
  app.get('/health', (_req: Request, res: ExpressResponse) => {
    res.json({ status: 'ok' });
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

  // Relays a team's join request, for the same HTTPS/CORS reasons as the
  // other relays. No validation of our own, and in particular `consent` is
  // never added or defaulted here: it has to come from the player actually
  // ticking a box that starts unticked, and the game-server alone decides
  // whether the code/consent are valid (see issue #30). The body may carry
  // the team's join code — never logged.
  app.post('/join', express.json(), async (req: Request, res: ExpressResponse) => {
    try {
      const upstream = await fetchWithTimeout(
        doFetch,
        new URL('/join', config.gameServerUrl),
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body) },
        config.gameServerTimeoutMs,
      );
      const body = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(body);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        res.status(504).json({ error: 'The game server took too long to respond' });
        return;
      }
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  });

  // Relays a participant's current state, for the same HTTPS/CORS reasons
  // as the other relays. Validates session/participant as UUIDs before
  // forwarding (400 otherwise, nothing sent upstream) — see issue #30.
  app.get('/state', async (req: Request, res: ExpressResponse) => {
    const { session, participant } = req.query as Record<string, string | undefined>;

    if (!isValidUuid(session) || !isValidUuid(participant)) {
      res.status(400).json({ error: 'session and participant must be valid UUIDs' });
      return;
    }

    try {
      const upstream = await fetchWithTimeout(
        doFetch,
        new URL(
          `/sessions/${encodeURIComponent(session)}/participants/${encodeURIComponent(participant)}/state`,
          config.gameServerUrl,
        ),
        {},
        config.gameServerTimeoutMs,
      );
      const body = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(body);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        res.status(504).json({ error: 'The game server took too long to respond' });
        return;
      }
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  });

  // Relays a checkpoint arrival, for the same HTTPS/CORS reasons as the
  // other relays. Validates session/participant as UUIDs and checkpoint as
  // an integer >= 1 (400 otherwise, nothing sent upstream), then sends
  // upstream only { checkpoint } — session/participant are already encoded
  // into the upstream URL path, matching its shape (see issue #30). The
  // response carries a short-lived, team-private code — never logged.
  app.post('/arrive', express.json(), async (req: Request, res: ExpressResponse) => {
    const { session, participant, checkpoint } = (req.body ?? {}) as Record<string, unknown>;

    if (!isValidUuid(session) || !isValidUuid(participant)) {
      res.status(400).json({ error: 'session and participant must be valid UUIDs' });
      return;
    }
    if (!isPositiveInteger(checkpoint)) {
      res.status(400).json({ error: 'checkpoint must be an integer >= 1' });
      return;
    }

    try {
      const upstream = await fetchWithTimeout(
        doFetch,
        new URL(
          `/sessions/${encodeURIComponent(session)}/participants/${encodeURIComponent(participant)}/arrive`,
          config.gameServerUrl,
        ),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ checkpoint }),
        },
        config.gameServerTimeoutMs,
      );
      const body = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(body);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        res.status(504).json({ error: 'The game server took too long to respond' });
        return;
      }
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  });

  // Relays the moderator's session controls and overview, for the same
  // HTTPS/CORS reasons as the other relays (see issue #39). The moderator
  // code travels in the Authorization header: forwarded unchanged when
  // present, never added or defaulted when missing (so the game-server
  // answers 401 itself), and never logged.
  async function relayModerator(
    req: Request,
    res: ExpressResponse,
    session: unknown,
    action: 'start' | 'stop' | 'overview',
  ): Promise<void> {
    if (!isValidUuid(session)) {
      res.status(400).json({ error: 'session must be a valid UUID' });
      return;
    }

    const authorization = req.get('authorization');
    try {
      // Start and stop carry no body upstream: the session is in the path.
      const upstream = await fetchWithTimeout(
        doFetch,
        new URL(`/sessions/${encodeURIComponent(session)}/${action}`, config.gameServerUrl),
        {
          method: action === 'overview' ? 'GET' : 'POST',
          headers: authorization === undefined ? {} : { authorization },
        },
        config.gameServerTimeoutMs,
      );
      const body = await upstream.text();
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(body);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        res.status(504).json({ error: 'The game server took too long to respond' });
        return;
      }
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  }

  app.post('/moderator/start', express.json(), async (req: Request, res: ExpressResponse) => {
    await relayModerator(req, res, (req.body as Record<string, unknown> | undefined)?.session, 'start');
  });

  app.post('/moderator/stop', express.json(), async (req: Request, res: ExpressResponse) => {
    await relayModerator(req, res, (req.body as Record<string, unknown> | undefined)?.session, 'stop');
  });

  app.get('/moderator/overview', async (req: Request, res: ExpressResponse) => {
    await relayModerator(req, res, req.query.session, 'overview');
  });

  return app;
}
