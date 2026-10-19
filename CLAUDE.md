# CLAUDE.md

Guidelines for working in this Node / TypeScript application: an Express server
(`src/`) that serves the play, moderator, designer and account pages (`src/public/`)
and relays their calls to the separate game-server.

## Definition of Done

Before opening a PR, run the full suite locally: lint, typecheck, build and ALL tests,
not a subset. If anything fails, fix every failure before reporting done. Never fix
"a few files to show the pattern": fix every occurrence, then re-run the suite.

If you cannot finish, say so plainly in the PR description and in your summary, and
list exactly what remains.

Commands (the same four steps CI runs in `.github/workflows/pr-build.yml`):

```bash
npm run lint        # ESLint, type-aware rules
npm run typecheck   # tsc over tsconfig.test.json, then tsconfig.dom.json
npm run build       # tsc to dist/, then copies src/public into dist/public
npm test            # Vitest, run once
```

Rules for Claude:
- Every new function or bugfix gets a test in the same change.
- Don't weaken a test (loosen an assertion, add an unwarranted `skip`) to make it pass.
- If a change can't be verified against live Clerk or Railway, say so in the PR. Unit
  tests don't prove sign-in works.

## Environment preflight

Before starting any issue, check the tools this project needs:

```bash
node --version      # must be >= 22 (package.json engines); CI and the Docker build use 24
npm --version
gh auth status      # needed to read issues and open PRs
docker ps           # only needed for Docker builds and the Docker-based checks
```

Then `npm ci` so `node_modules` matches `package-lock.json`.

If something is missing, stop and tell me right away with the exact install or start
command. Don't work around it by skipping lint, typecheck, build or tests.

## Node and TypeScript conventions

- **Package manager:** npm, with `package-lock.json` committed. Use `npm ci` to install
  from the lockfile. Add a dependency with `npm install <pkg>` (or `-D` for dev-only).
  Never edit `package-lock.json` by hand.
- **Modules:** ESM only (`"type": "module"`), `module` and `moduleResolution` are
  `NodeNext`.
- **Imports:** relative imports use the `.ts` extension in source (for example
  `import { loadConfig } from './config.ts'`). `rewriteRelativeImportExtensions` makes
  `tsc` emit `.js` in `dist/`. Don't add `.js` in source.
- **Strictness:** `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `noUnusedParameters`, `noImplicitOverride` and `verbatimModuleSyntax` are all on.
  Don't loosen them or add `// @ts-ignore` to get past them. Use `import type` for
  type-only imports.
- **Browser code:** files in `src/public/` are plain JavaScript served as-is, not
  compiled. Pure logic lives in `*-logic.js` modules with JSDoc types, so tests can
  import them directly. Keep DOM wiring out of those modules.
- **Server code** is never checked against browser globals. Tests that run a page's
  script in a DOM are named `*.dom.test.ts` and are checked by `tsconfig.dom.json`.
- **Config:** read environment variables only in `src/config.ts` (`loadConfig()`), which
  validates them and fails fast at startup. Don't read `process.env` elsewhere.
- **Errors and validation:** validate input at the trust boundary (request bodies,
  headers, webhook payloads) and keep the error handling that prevents data loss.
- **Tests:** Vitest, in `tests/`, named `*.test.ts`. Route tests use supertest against
  the app from `src/app.ts`, which doesn't bind a port.

## Auth & deployment notes (Clerk + Railway)

- **Clerk runs sign-up and sign-in.** Public values are `CLERK_PUBLISHABLE_KEY` and
  `CLERK_FRONTEND_API`. `GET /config` returns them to the pages. Without them the pages
  say sign-in isn't set up and the rest of the app works.
- **Play relays check the session token.** `/join`, `/state`, `/arrive`, `/challenge`
  and `/checkpoint/proximity` run `@clerk/express` with `CLERK_JWT_KEY`, so no request
  makes a network call. The token's `azp` must equal `APP_ORIGIN`.
- **Custom claims come from the Clerk session token.** The game-server copies each
  person's `pid` and `role` from the Clerk user's public metadata into the token's
  claims. Those claims must be configured in Clerk Dashboard → Sessions → Customize
  session token. Missing claims show up as sign-in or JWT errors, so check this first
  before changing provisioning code (`/me/provision`). The exact claim configuration
  hasn't been verified against the live Clerk instance.
- **Rollout order for `REQUIRE_SIGN_IN`:** `false`, then the game-server's
  `GAME_SERVER_AUTH_MODE=optional`, then `REQUIRE_SIGN_IN=true`, then the game-server's
  `GAME_SERVER_AUTH_MODE=required`.
- **Clerk webhook:** `POST /webhooks/clerk` passes the raw body to the game-server
  unchecked; the game-server verifies the Svix signature.

### Railway env vars: web-app service

| Variable | Secret? | Notes |
|---|---|---|
| `GAME_SERVER_URL` | no | Base URL of the game-server's private or public address |
| `GAME_SERVER_TIMEOUT_MS` | no | Default `45000`; keep above the game-server's referee timeout plus retries |
| `CLERK_PUBLISHABLE_KEY` | no | Public, from the Clerk Dashboard API keys |
| `CLERK_FRONTEND_API` | no | e.g. `verb-noun-00.clerk.accounts.dev` |
| `CLERK_SECRET_KEY` | **yes** | Never commit |
| `CLERK_JWT_KEY` | **yes** (treat as secret config) | PEM public key; a literal `\n` is read as a newline |
| `APP_ORIGIN` | no | e.g. `https://<this app's Railway domain>` |
| `REQUIRE_SIGN_IN` | no | `false` until the rollout steps above |

Don't set `TLS_KEY_PATH` or `TLS_CERT_PATH` on Railway: Railway terminates HTTPS, and the
container serves plain HTTP. `PORT` is injected by Railway.

Railway's health check uses `GET /health`.

### Database

This service has **no database**. It doesn't read `DATABASE_URL` or any Postgres
setting. The game's database, its roles (`game_app`, `directory_app`) and the Railway
logins live in the game-server repository (`game-server/README.md`, "The users
directory's logins on Railway"). Don't add database code here. Ask first if a change
seems to need one.

### Deploy and verify

- Pushes to `main` build the Docker image and deploy it to Railway through
  `.github/workflows/railway-deploy.yml`. Rollback is a manual run with an existing tag.
- Any change that touches auth, Clerk, middleware or the play relays must say in its PR
  whether it was checked against a live Clerk instance or a real browser. Unit tests
  alone don't cover this.

## Debugging conventions

- When giving browser-console snippets, wrap async code in an async IIFE:
  `(async () => { ... })()`. Don't use top-level await, because it fails in Safari.
- For auth or JWT errors, inspect the decoded token and its claims before changing code.
  Compare them with what the server validates.

## Definition of Done for PRs
Before opening a PR, run the full suite locally: lint, typecheck (mypy for Python, tsc for TS), and ALL tests, not a subset. If anything fails, fix every failure before reporting done. Never fix 'a few files to show the pattern'. If you cannot finish, say so plainly in the PR description and in your summary, and list exactly what remains.

## Environment preflight
Before starting any issue, check that the tools you need are available: `gh auth status`, `uv --version`, `node --version`, `docker ps`, and that the test Postgres DB is running. If something is missing, stop and tell me right away with the exact install or start command. Don't work around it by skipping lint or tests.

## Auth & deployment notes (Clerk + Railway)
- Our backend requires custom claims in the Clerk session token. Configure them in Clerk Dashboard → Sessions → Customize session token. Missing claims show up as sign-in/JWT errors. Check this first before changing provisioning code.
- List the required Railway env vars per service here:
  - Web-App
    - PORT: http port allocated for the web-app http server
    - GAME_SERVER_URL: game-server url
    - REQUIRE_SIGN_IN: true of web app should enforce sign-in
    - CLERK_FRONTEND_API: clerk FE url
    - CLERK_PUBLISHABLE_KEY: clerk public key
    - APP_ORIGIN: permissioned origins for clerk (points to webapp url)
    - CLERK_SECRET_KEY: clerk secret
  - Game-Server
    - GAME_SERVER_ANTHROPIC_API_KEY: Anthropic API key for game server queries
    - GAME_SERVER_AUTH_MODE: auth mode (required/optional)
    - GAME_SERVER_CLERK_AUTHORIZED_PARTIES: public authorised names
    - GAME_SERVER_CLERK_ISSUER: clerk issuer
    - GAME_SERVER_CLERK_JWT_KEY: clerk private key
    - GAME_SERVER_CLERK_SECRET_KEY: clerk secret
    - GAME_SERVER_CLERK_WEBHOOK_SECRET: cleck webhook secret
    - GAME_SERVER_DB_URL: game DB url (used by game_app)
    - GAME_SERVER_DIRECTORY_DB_URL: user directory DB url
    - GAME_SERVER_MCP_ALLOWED_HOSTS: mcp access
    - GAME_SERVER_MCP_ENABLED: mcp enabled toggle (true/false)
    - GAME_SERVER_SESSIONS_FILE: basic session file location
    - GAME_SERVER_SUPPRESSION_KEY: used to identify supressed connction requests from users while keeping their annonymity.
    - GAME_SERVER_WEB_APP_URL: location of the web-app
    - PORT: http port allocated for the game-server http server
    - RAILWAY_RUN_UID: railway identifier
- List the DB roles and what each is for here:
  - game_app: play of the scavenger hunt session
  - directory_app: users, accounts and game roles management
- If a change can't be verified against live Clerk or Railway, state that explicitly in the PR.

## Debugging conventions section.
When giving browser-console snippets, wrap async code in an async IIFE: `(async () => { ... })()`. Don't use top-level await, because it fails in Safari.
