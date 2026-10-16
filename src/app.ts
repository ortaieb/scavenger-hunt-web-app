import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { clerkMiddleware, getAuth } from '@clerk/express';
import express, {
  type Express,
  type RequestHandler,
  type Request,
  type Response as ExpressResponse,
} from 'express';
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
// Leaflet's built files, for the hunt designer's map (see issue #61): found
// in this app's own node_modules (the Docker image copies the production
// ones), so the page loads no third-party script.
const leafletDir = path.dirname(createRequire(import.meta.url).resolve('leaflet/dist/leaflet.js'));

export type AppConfig = Pick<Config, 'gameServerUrl' | 'gameServerTimeoutMs'> &
  Partial<
    Pick<
      Config,
      'clerkPublishableKey' | 'clerkFrontendApi' | 'clerkSecretKey' | 'clerkJwtKey' | 'appOrigin' | 'requireSignIn'
    >
  >;

export interface AppDeps {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A person's id in the users directory, as the game-server hands it back.
const PID_RE = /^[\w-]{1,100}$/;

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Returns the number, or undefined if it isn't an integer >= min. */
function parseInteger(value: unknown, min: number): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= min ? number : undefined;
}

/** Returns the checkpoint number, or undefined if it isn't an integer >= 1. */
function parseCheckpoint(value: string | undefined): number | undefined {
  return parseInteger(value, 1);
}

// The most checkpoints a hunt design can ask for (the game-server's limit
// for `POST /designer/drafts`), so a draft's checkpoint positions run 1–8.
const MAX_DRAFT_CHECKPOINTS = 8;

/** Returns a draft checkpoint's position, or undefined if it isn't an integer from 1 to 8. */
function parseDraftPosition(value: unknown): number | undefined {
  const position = parseInteger(value, 1);
  return position !== undefined && position <= MAX_DRAFT_CHECKPOINTS ? position : undefined;
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
function markdownPage(
  file: string,
  title: string,
  back: { href: string; text: string } = { href: '/play', text: 'Back to the game' },
): () => Promise<string> {
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
      <a class="doc-back" href="${escapeHtml(back.href)}">‹ ${escapeHtml(back.text)}</a>
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
  'organiser-guide.md': '/organiser-guide',
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

  // The play relays check a player's Clerk session token (see issue #66), and
  // so do the moderator and designer relays (see issue #67).
  // Tokens are verified here with Clerk's public key, so no request makes a
  // network call, and only for a token issued to this app's own origin.
  // Mounted on those relays alone, not on the whole app: for a request with
  // no token, a development instance's middleware can answer a page load with
  // a redirect to Clerk (a "handshake"), and nothing but these fetches should
  // ever depend on someone being signed in.
  // @clerk/express insists on a secret key even when the JWT key makes every
  // check local, so both are needed for it to run.
  const clerkEnabled = Boolean(config.clerkPublishableKey && config.clerkSecretKey);
  const accountAuth: RequestHandler[] = [];
  if (clerkEnabled) {
    accountAuth.push(
      clerkMiddleware({
        publishableKey: config.clerkPublishableKey,
        secretKey: config.clerkSecretKey,
        jwtKey: config.clerkJwtKey,
        authorizedParties: config.appOrigin ? [config.appOrigin] : undefined,
      }),
    );
  }
  // With sign-in required, a call with no signed-in player is turned away
  // here and never reaches the game-server. Without a working Clerk setup
  // nobody is signed in, so it fails closed.
  accountAuth.push((req, res, next) => {
    if (config.requireSignIn) {
      const userId = clerkEnabled ? getAuth(req, { acceptsToken: 'session_token' }).userId : null;
      if (!userId) {
        res.status(401).set('cache-control', 'no-store').json({ detail: 'sign-in required', code: 'sign_in_required' });
        return;
      }
    }
    next();
  });
  // The token goes on to the game-server unchanged when there is one, and is
  // never added, defaulted or logged.
  const authorizationHeader = (req: Request): Record<string, string> => {
    const authorization = req.get('authorization');
    return authorization === undefined ? {} : { authorization };
  };

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

  // The hunt designer (see issue #59), for the organiser, before any session
  // exists. The organiser key is typed on the page and only ever sent in the
  // Authorization header; the only thing in the URL is a draft's id
  // (/designer?draft=<uuid>).
  app.get('/designer', (_req: Request, res: ExpressResponse) => {
    res.sendFile(path.join(publicDir, 'designer.html'));
  });

  // Sign-up and sign-in (see issue #65): Clerk's screens, loaded by the
  // page from the instance's Frontend API.
  app.get('/sign-in', (_req: Request, res: ExpressResponse) => {
    res.sendFile(path.join(publicDir, 'sign-in.html'));
  });
  app.get('/sign-up', (_req: Request, res: ExpressResponse) => {
    res.sendFile(path.join(publicDir, 'sign-up.html'));
  });

  // The player's profile (see issue #68).
  app.get('/profile', (_req: Request, res: ExpressResponse) => {
    res.sendFile(path.join(publicDir, 'profile.html'));
  });

  // What the pages need to load Clerk. Both values are public (they're in
  // every page that loads Clerk); null when the instance isn't set up, and
  // the pages then say so and carry on without accounts.
  app.get('/config', (_req: Request, res: ExpressResponse) => {
    res.set('cache-control', 'no-store').json({
      clerkPublishableKey: config.clerkPublishableKey ?? null,
      clerkFrontendApi: config.clerkFrontendApi ?? null,
      // So /play knows to ask for a sign-in before joining (see issue #66).
      requireSignIn: config.requireSignIn ?? false,
    });
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

  const organiserGuidePage = markdownPage('organiser-guide.md', 'Organiser guide', {
    href: '/designer',
    text: 'Back to the designer',
  });
  app.get('/organiser-guide', async (_req: Request, res: ExpressResponse) => {
    res.type('html').send(await organiserGuidePage());
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
  app.use('/vendor/leaflet', express.static(leafletDir));

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
  app.post('/challenge', ...accountAuth, upload.single('image'), async (req: Request, res: ExpressResponse) => {
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
        { method: 'POST', headers: authorizationHeader(req), body: form },
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
  app.post('/checkpoint/proximity', ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
    try {
      const upstream = await doFetch(new URL('/checkpoint/proximity', config.gameServerUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authorizationHeader(req) },
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

  // Relays a team's join request, for the same HTTPS/CORS reasons as the
  // other relays. No validation of our own, and in particular `consent` is
  // never added or defaulted here: it has to come from the player actually
  // ticking a box that starts unticked, and the game-server alone decides
  // whether the code/consent are valid (see issue #30). The body may carry
  // the team's join code — never logged.
  app.post('/join', ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
    try {
      const upstream = await fetchWithTimeout(
        doFetch,
        new URL('/join', config.gameServerUrl),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authorizationHeader(req) },
          body: JSON.stringify(req.body),
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

  // Relays a participant's current state, for the same HTTPS/CORS reasons
  // as the other relays. Validates session/participant as UUIDs before
  // forwarding (400 otherwise, nothing sent upstream) — see issue #30.
  app.get('/state', ...accountAuth, async (req: Request, res: ExpressResponse) => {
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
        { headers: authorizationHeader(req) },
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
  app.post('/arrive', ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
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
          headers: { 'content-type': 'application/json', ...authorizationHeader(req) },
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

  // Relays a call that carries a credential in the Authorization header: the
  // moderator's session controls, overview, review queue, rulings and photos
  // (see issues #39 and #55), and the organiser's hunt designer (see issue
  // #59). Both screens now sign in with an account (see issue #67), so the
  // credential is the player's Clerk session token, checked first like the
  // play relays'. The browser can't call the game-server directly, for the
  // same HTTPS/CORS reasons as the other relays. Each route validates what
  // goes into the upstream path first (400 otherwise, nothing sent upstream).
  // The Authorization header is forwarded unchanged when present, never added
  // or defaulted when missing (so the game-server answers 401 itself), and
  // never logged. (A moderator code or organiser key still works upstream
  // until the game-server retires them.)
  async function relayAuthorised(
    req: Request,
    res: ExpressResponse,
    upstreamPath: string,
    {
      method = 'GET',
      body,
      photo = false,
      noStore = photo,
    }: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; photo?: boolean; noStore?: boolean } = {},
  ): Promise<void> {
    const authorization = req.get('authorization');
    const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    try {
      const upstream = await fetchWithTimeout(
        doFetch,
        new URL(upstreamPath, config.gameServerUrl),
        { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
        config.gameServerTimeoutMs,
      );
      res.status(upstream.status).type(upstream.headers.get('content-type') ?? 'application/json');
      if (noStore) {
        // Kept by neither the browser nor a proxy.
        res.set('cache-control', 'no-store');
      }
      if (!photo) {
        res.send(await upstream.text());
        return;
      }
      // A player's photo, or a reference photo that can show the answer to
      // a clue: streamed straight through, never kept here.
      if (upstream.body) {
        await pipeline(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>), res);
      } else {
        res.end();
      }
    } catch (err) {
      if (res.headersSent || res.destroyed) {
        // The photo was already on its way when the game-server or the
        // browser went away: there's nothing left to answer.
        res.destroy();
        return;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        res.status(504).json({ error: 'The game server took too long to respond' });
        return;
      }
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  }

  // A new account's first call (see issue #66): the game-server creates the
  // person and puts their id into Clerk, after a `provisioning_required`.
  // Needs the token and nothing else; it answers `{ "pid" }`.
  app.post('/me/provision', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    await relayAuthorised(req, res, '/me/provision', { method: 'POST', noStore: true });
  });

  // The player's profile (see issue #68): their name, home area, language,
  // the upcoming-hunts consent and their hunts. Personal data, so relayed
  // with the token and never cached or logged. The body goes upstream as
  // sent: the game-server alone checks it (422 with a code per field), and
  // `granted` is never added or defaulted here, as with `consent` on /join.
  app.get('/me', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    await relayAuthorised(req, res, '/me', { noStore: true });
  });
  app.patch('/me', ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
    await relayAuthorised(req, res, '/me', { method: 'PATCH', body: req.body ?? {}, noStore: true });
  });
  app.put('/me/consents/upcoming-hunts', ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
    await relayAuthorised(req, res, '/me/consents/upcoming-hunts', {
      method: 'PUT',
      body: req.body ?? {},
      noStore: true,
    });
  });
  app.get('/me/hunts', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    await relayAuthorised(req, res, '/me/hunts', { noStore: true });
  });

  // Delete account and profile (see issue #69): the game-server erases personal
  // data and signs the player out. Personal data never logged or cached.
  app.delete('/me', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    await relayAuthorised(req, res, '/me', { method: 'DELETE', noStore: true });
  });

  // Export the player's data (see issue #69): profile, hunts and consents as
  // JSON, never cached. Sent in the content-type the game-server answers with
  // and never logged.
  app.get('/me/export', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    await relayAuthorised(req, res, '/me/export', { noStore: true });
  });

  // A team's members' display names, for the team's own screens (never email
  // addresses; the game-server answers 404 to anyone outside the team).
  app.get('/members', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    const { session, participant } = req.query as Record<string, string | undefined>;
    if (!isValidUuid(session) || !isValidUuid(participant)) {
      res.status(400).json({ error: 'session and participant must be valid UUIDs' });
      return;
    }
    await relayAuthorised(
      req,
      res,
      `/sessions/${encodeURIComponent(session)}/participants/${encodeURIComponent(participant)}/members`,
      { noStore: true },
    );
  });

  // Clerk's webhooks (see issue #66), passed to the game-server as they came:
  // the raw body, byte for byte, and the three Svix headers, because the
  // signature is over those exact bytes. Nothing is parsed or checked here;
  // the game-server alone holds the signing secret and decides, and its
  // status is the answer (anything but 2xx makes Svix retry). The body is
  // personal data, so it is never logged.
  const WEBHOOK_HEADERS = ['content-type', 'svix-id', 'svix-timestamp', 'svix-signature'];
  app.post(
    '/webhooks/clerk',
    express.raw({ type: () => true, limit: '1mb' }),
    async (req: Request, res: ExpressResponse) => {
      const headers: Record<string, string> = {};
      for (const name of WEBHOOK_HEADERS) {
        const value = req.get(name);
        if (value !== undefined) {
          headers[name] = value;
        }
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      try {
        const upstream = await fetchWithTimeout(
          doFetch,
          new URL('/internal/clerk-events', config.gameServerUrl),
          { method: 'POST', headers, body },
          config.gameServerTimeoutMs,
        );
        res
          .status(upstream.status)
          .type(upstream.headers.get('content-type') ?? 'application/json')
          .send(await upstream.text());
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          res.status(504).json({ error: 'The game server took too long to respond' });
          return;
        }
        res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
      }
    },
  );

  const sessionPath = (session: string) => `/sessions/${encodeURIComponent(session)}`;

  // Start and stop carry no body upstream: the session is in the path.
  for (const action of ['start', 'stop'] as const) {
    app.post(`/moderator/${action}`, ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
      const { session } = (req.body ?? {}) as Record<string, unknown>;
      if (!isValidUuid(session)) {
        res.status(400).json({ error: 'session must be a valid UUID' });
        return;
      }
      await relayAuthorised(req, res, `${sessionPath(session)}/${action}`, { method: 'POST' });
    });
  }

  // The overview and the review queue (photos waiting for a ruling, and
  // the latest rulings) are read the same way.
  for (const view of ['overview', 'review'] as const) {
    app.get(`/moderator/${view}`, ...accountAuth, async (req: Request, res: ExpressResponse) => {
      const { session } = req.query;
      if (!isValidUuid(session)) {
        res.status(400).json({ error: 'session must be a valid UUID' });
        return;
      }
      await relayAuthorised(req, res, `${sessionPath(session)}/${view}`);
    });
  }

  // Approves or rejects a photo. Only { ruling, note } go upstream, as
  // sent: the game-server alone decides whether they're valid. The note may
  // describe the photo, so it's never logged either.
  app.post('/moderator/ruling', ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
    const { session, submission, ruling, note } = (req.body ?? {}) as Record<string, unknown>;
    if (!isValidUuid(session)) {
      res.status(400).json({ error: 'session must be a valid UUID' });
      return;
    }
    if (!isPositiveInteger(submission)) {
      res.status(400).json({ error: 'submission must be an integer >= 1' });
      return;
    }
    await relayAuthorised(req, res, `${sessionPath(session)}/submissions/${submission}/ruling`, {
      method: 'POST',
      body: { ruling, note },
    });
  });

  // A session's moderators, added by email address (see issue #67). The
  // email goes upstream as sent, in the body only (the game-server resolves it
  // to a person and answers `{session, pid}`, or 404 for no account): personal
  // data, so never logged and never cached. A moderator is removed by the
  // `pid` that answer gave, in the query: it's an id, not an address.
  app.post('/moderator/moderators', ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
    const { session, email } = (req.body ?? {}) as Record<string, unknown>;
    if (!isValidUuid(session)) {
      res.status(400).json({ error: 'session must be a valid UUID' });
      return;
    }
    await relayAuthorised(req, res, `${sessionPath(session)}/moderators`, {
      method: 'POST',
      body: { email },
      noStore: true,
    });
  });

  app.delete('/moderator/moderators', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    const { session, pid } = req.query;
    if (!isValidUuid(session)) {
      res.status(400).json({ error: 'session must be a valid UUID' });
      return;
    }
    if (typeof pid !== 'string' || !PID_RE.test(pid)) {
      res.status(400).json({ error: 'pid must be a person id' });
      return;
    }
    await relayAuthorised(req, res, `${sessionPath(session)}/moderators/${encodeURIComponent(pid)}`, {
      method: 'DELETE',
      noStore: true,
    });
  });

  app.get('/moderator/photo', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    const { session, submission } = req.query;
    if (!isValidUuid(session)) {
      res.status(400).json({ error: 'session must be a valid UUID' });
      return;
    }
    const submissionId = parseInteger(submission, 1);
    if (submissionId === undefined) {
      res.status(400).json({ error: 'submission must be an integer >= 1' });
      return;
    }
    await relayAuthorised(req, res, `${sessionPath(session)}/submissions/${submissionId}/photo`, { photo: true });
  });

  app.get('/moderator/reference-photo', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    const { session, checkpoint, position } = req.query;
    if (!isValidUuid(session)) {
      res.status(400).json({ error: 'session must be a valid UUID' });
      return;
    }
    const sequence = parseInteger(checkpoint, 1);
    if (sequence === undefined) {
      res.status(400).json({ error: 'checkpoint must be an integer >= 1' });
      return;
    }
    const index = parseInteger(position, 0);
    if (index === undefined) {
      res.status(400).json({ error: 'position must be an integer >= 0' });
      return;
    }
    await relayAuthorised(req, res, `${sessionPath(session)}/checkpoints/${sequence}/reference-photos/${index}`, {
      photo: true,
    });
  });

  // The hunt designer's drafts (see issue #59), with the organiser key in
  // the Authorization header. A draft's clues, scenes and coordinates are
  // the answers to its hunt: relayed as they come, never logged, and kept by
  // neither the browser's cache nor a proxy.
  app.post('/designer/drafts', ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
    // The request (area, theme, checkpoints, max-walk-km) goes upstream as
    // sent: the game-server alone decides whether it's valid.
    await relayAuthorised(req, res, '/designer/drafts', { method: 'POST', body: req.body ?? {}, noStore: true });
  });

  app.get('/designer/drafts', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    await relayAuthorised(req, res, '/designer/drafts', { noStore: true });
  });

  app.get('/designer/drafts/:draft', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    const { draft } = req.params;
    if (!isValidUuid(draft)) {
      res.status(400).json({ error: 'draft must be a valid UUID' });
      return;
    }
    await relayAuthorised(req, res, `/designer/drafts/${encodeURIComponent(draft)}`, { noStore: true });
  });

  // Reviewing and publishing a ready draft (see issue #60). Edits, reviews
  // and the publish request go upstream as sent: the game-server alone
  // decides whether they're valid. The publish response and the publication
  // carry every team's join code and the moderator code: relayed as they
  // come, never logged, and kept by neither the browser's cache nor a proxy.
  app.patch(
    '/designer/drafts/:draft/checkpoints/:position',
    ...accountAuth,
    express.json(),
    async (req: Request, res: ExpressResponse) => {
      const { draft, position } = req.params;
      if (!isValidUuid(draft)) {
        res.status(400).json({ error: 'draft must be a valid UUID' });
        return;
      }
      const checkpoint = parseDraftPosition(position);
      if (checkpoint === undefined) {
        res.status(400).json({ error: `position must be an integer from 1 to ${MAX_DRAFT_CHECKPOINTS}` });
        return;
      }
      await relayAuthorised(req, res, `/designer/drafts/${encodeURIComponent(draft)}/checkpoints/${checkpoint}`, {
        method: 'PATCH',
        body: req.body ?? {},
        noStore: true,
      });
    },
  );

  app.post('/designer/drafts/:draft/publish', ...accountAuth, express.json(), async (req: Request, res: ExpressResponse) => {
    const { draft } = req.params;
    if (!isValidUuid(draft)) {
      res.status(400).json({ error: 'draft must be a valid UUID' });
      return;
    }
    await relayAuthorised(req, res, `/designer/drafts/${encodeURIComponent(draft)}/publish`, {
      method: 'POST',
      body: req.body ?? {},
      noStore: true,
    });
  });

  app.get('/designer/drafts/:draft/publication', ...accountAuth, async (req: Request, res: ExpressResponse) => {
    const { draft } = req.params;
    if (!isValidUuid(draft)) {
      res.status(400).json({ error: 'draft must be a valid UUID' });
      return;
    }
    await relayAuthorised(req, res, `/designer/drafts/${encodeURIComponent(draft)}/publication`, { noStore: true });
  });

  // The organiser MCP server (see issue #70): Claude reaches the
  // game-server's `/mcp` through this app, so the URL people give Claude
  // never changes. Like relayAuthorised, `Authorization` is forwarded
  // unchanged when present and never added, nothing about the request is
  // logged, and the response is kept by neither a cache nor a proxy. The
  // body goes through raw (no JSON re-encoding), and the response is
  // streamed, since it may be an event stream.
  const MCP_REQUEST_HEADERS = ['authorization', 'accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id'];
  const MCP_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'www-authenticate'];
  // `get_hunt_draft` can wait up to 20 s for a draft, so the relay waits
  // longer than that whatever the other relays' timeout is.
  const mcpTimeoutMs = Math.max(config.gameServerTimeoutMs, 30_000);

  async function relayMcp(req: Request, res: ExpressResponse, upstreamPath: string): Promise<void> {
    const headers: Record<string, string> = {};
    for (const name of MCP_REQUEST_HEADERS) {
      const value = req.get(name);
      if (value !== undefined) {
        headers[name] = value;
      }
    }
    const body = req.method === 'POST' && Buffer.isBuffer(req.body) ? req.body : undefined;

    try {
      const upstream = await fetchWithTimeout(
        doFetch,
        new URL(upstreamPath, config.gameServerUrl),
        { method: req.method, headers, body },
        mcpTimeoutMs,
      );
      res.status(upstream.status);
      for (const name of MCP_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) {
          res.set(name, value);
        }
      }
      res.set('cache-control', 'no-store');
      if (upstream.body) {
        await pipeline(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>), res);
      } else {
        res.end();
      }
    } catch (err) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      // A timeout is a 502 here too: Claude's MCP client sees one kind of
      // "the server behind this URL didn't answer".
      res.status(502).json({ error: `Could not reach the game server: ${describeError(err)}` });
    }
  }

  const mcpBody = express.raw({ type: () => true, limit: '1mb' });
  app.post('/mcp', mcpBody, (req, res) => relayMcp(req, res, '/mcp'));
  app.get('/mcp', (req, res) => relayMcp(req, res, '/mcp'));
  app.delete('/mcp', (req, res) => relayMcp(req, res, '/mcp'));
  // For OAuth discovery (game-server issue #131); the game-server's 404
  // passes through until then.
  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) =>
    relayMcp(req, res, '/.well-known/oauth-protected-resource/mcp'),
  );

  return app;
}
