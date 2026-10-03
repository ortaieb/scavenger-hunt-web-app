# scavenger-hunt-web-app

Scavenger Hunt mobile application — TypeScript web service running on Node.js.

## Requirements

- Node.js >= 22
- Docker (optional, for the container image)

## Getting started

```bash
npm install
npm run dev        # watch mode, http://localhost:3000
```

`GET /` and `GET /play` serve the participant app (see [/play](#play) below).

`GET /health` responds `200 {"status":"ok"}` — a liveness signal for the
deployment platform, not a dependency check: it never calls the game-server,
so a blip there doesn't make this app look unhealthy and get cycled for no
reason.

### /play

The participant app (issue #40): one page that always shows the screen for
where the team stands, recomputed from what's stored on the phone and the
latest `GET /state`, so a reload, a locked screen or lost signal lands back
on the right screen.

| Screen | Shown when |
| --- | --- |
| Join | No stored identity: team code (upper-cased as typed), the photo privacy summary, an **unticked** consent box, links to the privacy notice and "How to play" |
| Permissions | After join, until camera and location have been granted once: explains why, then asks for the camera, then location, on one tap; if refused, steps for iPhone Safari and Android Chrome, then Try again |
| Lobby | `status: not_started`: team, session name, area and planned start; polls `GET /state` every 10 s (at once when the page becomes visible again, never while hidden) |
| Clue | `playing`, no code yet: the clue in large type and **I'm here** (disabled, with the reason, while `current.open` is false), which calls `POST /arrive` with `current.sequence` |
| Capture | A code issued (`201` or `200`): the code and its countdown, the pose (hidden when `null`), the live camera with a front/back switch, and the advisory "you may be outside the area" note |
| Review | A photo taken: the photo, Retake and **Send**, which posts to `POST /challenge` with the stored identity and `current.sequence` as `checkpoint` |
| Checking | The upload in flight: "Usually under 10 seconds" |
| Verdict | The server's verdict: done, in review or not quite, with the per-check list (skipped checks hidden) and the new points total; **Next clue** reloads `GET /state`, **Try again** arrives again for a fresh code |
| Finished | `status: finished`: "All 3 checkpoints done", the points, and wait for the moderator; polls every 10 s |
| Session over | `session.phase: stopped` (or `status: ended`): when the moderator finished, and the final points and place; polls every 10 s until the result is final |

A **connection banner** with **Retry** shows over any screen when a call
gets no answer; it clears on the next good `GET /state`. A photo on Review
stays in memory, so Send can be tried again.

Refusals (issue #43) are routed by the game-server's `code`, never its
`detail` text, moving the player at once and then confirming with
`GET /state`:

| `code` | App goes to |
| --- | --- |
| `session_not_started` | Lobby |
| `session_stopped` | Session over (Join says "This session is over") |
| `hunt_finished` | Finished |
| `not_current_checkpoint` | Reloads the state |
| `checkpoint_closed` | Clue, with "not open yet" |

A photo sent outside the session comes back as a `failed` verdict whose
rejection code is `session_not_started` or `session_stopped` (the server
records it so teams can challenge results later). The app treats it like
the matching `409`, not as "Not quite", and drops a photo in progress once
the session is over.

Playing a checkpoint (issue #42): the code is issued and shown but **not
checked by the referee yet**, so teams don't need it in the photo. If it
expires before Send, the app quietly arrives again for a fresh one and keeps
the photo. A failed send (no signal, a timeout) goes back to Review with the
photo kept. Progress within a checkpoint lives in memory only: after a
reload the team is back on the Clue, and I'm here issues a fresh code.
`GET /state` is polled every 10 s on the Clue and every 30 s on Capture and
Review (not while checking or on a verdict). The camera stops when the page
is hidden and restarts on return. The camera and location code is shared
with `/challenge`, in `camera.js`.

From the lobby on, a sticky **status bar** (issue #41) shows the team (cut at
14 characters), checkpoints completed ("1 of 3", "3 of 3 ✓" when finished),
points (tap for how scoring works; a • while a photo is in review), the time
to the planned end and the current clue (tap to read it all), or the phase
when there's no clue. The countdown is m:ss under an hour and h:mm:ss above,
amber under 15 minutes and red under 5 with "min left" in words too, and
"Finishing soon" past the planned end: reaching zero ends nothing, only the
moderator's stop does. It follows the server's clock (`server-time` minus
the phone's time on arrival, re-synced on every poll). The lobby shows the
planned start instead. Until the game-server's `/state` carries `session`
and `score`, the planned times come from the join response and the points
are hidden.

Join stays disabled until the box is ticked, so `consent: true` is only
ever the player's own tick. The join response's `{session, participant,
team}` is kept in `localStorage` (read and written inside try/catch, as
private browsing can throw); **Leave this game** in the menu clears it.

The page is split like `/challenge`: `play.js` is DOM wiring only, `api.js`
calls this app's relays with a timeout, and `game-logic.js` holds the pure
logic (`screenFor`, `instructionFor`, `formatCountdown`, `clockOffset`,
`screenForError`), unit-tested with Vitest. The app only describes what the
game-server decided: no verdict, distance or time-window logic on the phone.

`GET /privacy` renders [`docs/privacy-notice.md`](docs/privacy-notice.md)
and `GET /how-to-play` renders [`docs/user-guide.md`](docs/user-guide.md)
(a stub until issue #45). **The privacy notice still has `[placeholders]`,
which must be filled in before real players use the game.**

### /challenge

A developer tool, kept until there's authentication; players use `/play`.


`GET /challenge?checkpoint=<int>` serves an in-app photo + location capture
page. There's no join flow yet, so **Session ID** and **Participant ID** are
plain editable text fields on the page — pre-filled from `?session=<uuid>`/
`?participant=<uuid>` in the link when present and valid, a fresh random
UUID otherwise (via `crypto.randomUUID()`), and freely editable from there.
`checkpoint` is different: it names a specific point in the hunt, so it
always has to come from the link, with no random default — Capture and
Submit are disabled with a clear message if it's missing or malformed.
Submit additionally requires both identity fields to hold a valid UUID at
the moment it's clicked (whatever the player has typed by then).

The page renders the device camera directly via `getUserMedia` (no native
picker, so there's no gallery-upload option), lets the player take and
retake a shot, then reads their location and submits everything.

`POST /challenge` receives that submission (`session`, `participant`,
`checkpoint`, `image`, `latitude`, `longitude`, `capturedAt`), validates
`session`/`participant` as UUIDs and `checkpoint` as an integer >= 1
(`400` otherwise, and nothing is sent upstream), and relays it to the
game-server (a separate service, not part of this repo) as
`multipart/form-data`:

- `metadata` — a JSON string:
  `{"session","participant","checkpoint","location":{"lat","long"},"capture-time"}`,
  built from the request's own fields (no placeholders).
- `challenge-image` — the captured JPEG.

Only these raw claims go upstream — nothing that looks like a pre-computed
result. The game-server alone decides the verdict — a referee now checks
the photo before responding, which can take several seconds; from Submit
until the response, the page shows "The referee is checking your photo…"
and disables Submit, Capture and Retake. The verdict itself is nested under
`verdict.checkpoint` in the response body (`{ verdict: { checkpoint: {
attempt, verdict, checks, rejections } } }`) — this app never recomputes or
reinterprets it, only relays and displays exactly what's there, branching on
`checkpoint.verdict`, not the HTTP status (the status is only a fallback for
a body that isn't a verdict at all):

- **`pass`** → "Checkpoint passed!" (success styling) plus the attempt
  number; Submit and Retake are both hidden
- **`failed`** → every rejection's message, verbatim, plus the attempt
  number; Submit is replaced by **Retake**
- **`pending`** → "Your photo is with the moderator for review." plus the
  attempt number; neither button is forced
- a relay timeout (`504`) → "The referee took too long. Please try again."
- `404` → "Unknown game or checkpoint, check your link"
- anything else, or a network failure → the status code and error body

Below the message, a checklist renders every entry in `checks`: ✓ for
`passed`, ✗ for `failed`, ? for `uncertain`, and `skipped` checks are hidden.
Each line shows the check's own player-safe `reason` verbatim, and a
friendly label for known check names (falling back to the raw name for one
this app doesn't recognize yet) — `confidence` is never shown to the player.

The browser posts to this app's own `/challenge`, not the game-server
directly: this app runs over HTTPS off `localhost` (required for the camera
API, see below), and the game-server isn't guaranteed to serve HTTPS or
allow our origin via CORS, so the request has to go server-to-server.
`GAME_SERVER_TIMEOUT_MS` bounds how long that relay waits before giving up.

The exact verdict schema (field names under `checks`/`rejections`, the set
of check names) is inferred from the issue that introduced it, checked
against its one worked example — not copied verbatim from the game-server's
own README, which this repo doesn't have access to. Worth double-checking
against the real game-server once both are deployed together.

#### Courtesy out-of-range warning

Once a location fix is available, the page calls `POST /checkpoint/proximity`
(this app's own relay, for the same HTTPS/CORS reasons as `/challenge`;
forwards `{session, participant, checkpoint, location}` to
`${GAME_SERVER_URL}/checkpoint/proximity` unchanged and passes the status
and body straight back) once per fix. **This is a courtesy, not a check —
it never blocks Submit**, and the game-server's `/challenge` verdict is the
only thing that counts:

- `in_range: false` → a non-blocking warning near the location line ("You
  may be outside the checkpoint area. You can still submit.")
- `in_range: true` → no warning
- `429`, `404`, a network error, or no response within ~3s → shown nothing;
  the hint never gets in the way

There's also a purely local hint, no server call: if `coords.accuracy` is
over 50m, "Your location fix is imprecise…" appears alongside it. Neither
hint — nor anything else in this app — ever sees or computes the
checkpoint's actual coordinates, a distance, or a radius; the game-server
only ever answers `in_range: true|false`.

#### Pose instruction

Above the camera, a **"Your challenge"** panel shows the checkpoint's pose
text — how the referee expects the player to pose for the photo (see
`ortaieb/scavenger-hunt-game-server#22`) — fetched via `GET
/checkpoint/challenge?session=<uuid>&checkpoint=<int>` (this app's own
relay, validating both before forwarding to
`${GAME_SERVER_URL}/sessions/{session}/checkpoints/{checkpoint}/challenge`
and passing the status/body straight back). It's rendered with
`textContent`, never `innerHTML`, since the text comes from a
moderator-written file, not code this app controls.

It's fetched once the Session ID field holds a valid UUID, and re-fetched
(debounced ~500ms) whenever that field settles on a different valid UUID.
Like the proximity warning, this is guidance only: a `{"pose": null}` body,
a `404`, a malformed response, or no answer within ~3s all just hide the
panel — it never blocks Capture or Submit.

Camera and geolocation only work in a "secure context": HTTPS, or plain HTTP
on `localhost`. To try `/challenge` from a phone over the LAN (not
`localhost`), generate a local HTTPS certificate first:

```bash
npm run certs:dev  # writes certs/dev-{cert,key}.pem (gitignored)
npm run dev         # auto-detects the cert and serves HTTPS
```

Accept the self-signed certificate warning in the browser to continue.

### Game loop: /join, /state, /arrive

Three more relays, for the game-server's game loop (day 4 there; the
screens that call them are day 6 — see issue #30). Same pattern as the
`/challenge` relays: validate what this app can and answer `400` without
calling upstream when that fails, relay with `fetchWithTimeout` and
`GAME_SERVER_TIMEOUT_MS` (`504` on a timeout, `502` when the game-server
can't be reached), and otherwise pass the upstream status, content type and
body straight back unchanged. The contracts below are copied from the
game-server's own issues, since this repo can't see its README.

**`POST /join` → `POST ${GAME_SERVER_URL}/join`** — forwards the JSON body
unchanged: `{"code", "consent"}`. No validation of its own, and in
particular **`consent` is never added or defaulted here** — it has to come
from the player actually ticking a box that starts unticked. The
game-server answers `201` on a team's first join or `200` on a repeat join,
with the same shape either way: `{"participant", "team", "session": {"id",
"name", "location", "start-time", "end-time"}, "checkpoints"}`; otherwise
`404`, `409`, or `422` for an invalid body (including a `consent` that
isn't `true`).

**`GET /state?session=<uuid>&participant=<uuid>` → `GET
${GAME_SERVER_URL}/sessions/{session}/participants/{participant}/state`** —
both must be UUIDs (`400` otherwise). Response: `{"status", "team",
"progress": {"completed", "total"}, "current": {"sequence", "position",
"clue", "open"} | null}`; `status` is `not_started`/`playing`/`finished`/
`ended`, and `current` is only non-null while `playing`.

**`POST /arrive` → `POST
${GAME_SERVER_URL}/sessions/{session}/participants/{participant}/arrive`**
— takes `{"session", "participant", "checkpoint"}`, validates all three
(UUIDs, and an integer >= 1), and sends upstream **only** `{"checkpoint"}`
— session/participant are already in the URL path. Response: `{"checkpoint",
"pose", "code", "issued-at", "expires-at"}` (`pose` can be `null`);
otherwise `404`, `422`, or `409`.

The `participant` id is a team's key to its clues and codes, and `/arrive`'s
`code` is a short-lived secret — neither is ever logged by these relays.

### /moderator

The moderator screen (issue #44), for a phone or a laptop:
`/moderator?session=<uuid>`. The moderator code is typed once on the page,
kept in `sessionStorage` (so it goes when the tab closes) and sent only as
`Authorization: Bearer <code>`: never in a URL, never in `localStorage`,
never logged. A `401` says "That code isn't right for this session." and
asks again.

- **Phase badge**: Not started, Running or Finished, with the planned and
  actual times and the countdown to the planned end; once that passes,
  "Running, past planned end" as a reminder to finish.
- **Start session** (not started only, at any time) and **Finish session
  now** (running only, in the warning colour), each after a confirmation.
- **Standings**, lowest points first: joined or not, checkpoints completed,
  points, photos in review, the current checkpoint, and the last one
  completed with how long ago it was approved, to spot a team that's stuck.
  After the finish they're final, with places.
- **Blocked outside the session**: newest first, up to 50 (time, team, what
  they tried and why).
- Refreshes the overview every 5 s while the page is visible. Shows
  checkpoint numbers and names, never clues, locations or photos.

The pure logic is in `moderator-logic.js`, unit-tested like `game-logic.js`.

### Moderator relays: /moderator/start, /moderator/stop, /moderator/overview

Three relays for the moderator screen (issue #39), following the same
pattern as the game-loop relays above: `fetchWithTimeout` with
`GAME_SERVER_TIMEOUT_MS` (`504` on a timeout, `502` when the game-server
can't be reached), otherwise the upstream status, content type and body
unchanged.

| This app | Game-server | Body |
| --- | --- | --- |
| `POST /moderator/start` | `POST ${GAME_SERVER_URL}/sessions/{session}/start` | `{"session": "<uuid>"}` |
| `POST /moderator/stop` | `POST ${GAME_SERVER_URL}/sessions/{session}/stop` | `{"session": "<uuid>"}` |
| `GET /moderator/overview?session=<uuid>` | `GET ${GAME_SERVER_URL}/sessions/{session}/overview` | none |

`session` must be a UUID (`400` otherwise, nothing sent upstream). Start
and stop send **no body** upstream — the session is in the path.

The moderator code travels in the **`Authorization` header**, which is
forwarded unchanged. It is **never logged**, and never added or defaulted:
a request without it is forwarded without it, so the game-server answers
`401 {"detail": "moderator code required", "code": "moderator_unauthorised"}`.

Start and stop answer `201` when the phase changes and `200` on a repeat,
with the session clock: `{"phase", "planned-start", "planned-end",
"started-at", "stopped-at", "server-time"}` (`phase` is `scheduled`,
`running` or `stopped`). Otherwise `404` for an unknown session, or `409
{"detail", "code"}` with `session_stopped` (start after stop) or
`session_not_started` (stop before start). The overview answers `{"session":
<the clock>, "teams": [...], "blocked": [...]}` — standings, each team's
last completed and current checkpoint, and the newest attempts refused for
being outside the session.

The game-loop relays forward bodies verbatim, so the game-server's newer
fields (`session` and `score` in `/state`, `code` in error bodies) pass
through unchanged.

## Scripts

| Script              | Description                                  |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Run from source in watch mode                 |
| `npm run build`     | Compile TypeScript and copy static assets into `dist/` |
| `npm start`         | Run the compiled server from `dist/`          |
| `npm run certs:dev` | Generate a self-signed TLS cert for local HTTPS testing |
| `npm run typecheck` | Type-check sources, tests and config files    |
| `npm run lint`      | ESLint (type-aware rules)                     |
| `npm test`          | Run the Vitest suite                          |

## Configuration

| Variable                 | Default                 | Description                                                    |
| ------------------------- | ------------------------ | ---------------------------------------------------------------- |
| `PORT`                    | `3000`                   | Port the server binds to                                          |
| `HOST`                    | `0.0.0.0`                | Interface to bind to                                              |
| `GAME_SERVER_URL`         | `http://localhost:8000` | Base URL of the game-server; `POST /challenge` relays to `<this>/challenge` |
| `GAME_SERVER_TIMEOUT_MS`  | `45000`                  | How long `POST /challenge` waits for the game-server before returning `504` |
| `TLS_KEY_PATH`            | —                        | Path to a TLS private key; must be set with `TLS_CERT_PATH`       |
| `TLS_CERT_PATH`           | —                        | Path to a TLS certificate; must be set with `TLS_KEY_PATH`        |

Copy `.env.example` to `.env` to override any of these locally — it's loaded
automatically (and gitignored).

An out-of-range or non-numeric `PORT` or `GAME_SERVER_TIMEOUT_MS` fails fast
at startup, as does setting only one of `TLS_KEY_PATH`/`TLS_CERT_PATH`.

If neither TLS variable is set, the server checks for a cert generated by
`npm run certs:dev` (`certs/dev-{key,cert}.pem`) and uses it automatically;
otherwise it falls back to plain HTTP. Set both `TLS_KEY_PATH`/`TLS_CERT_PATH`
explicitly to serve a real certificate (e.g. one mounted into the container).

## Layout

```
src/
  index.ts     server bootstrap: config, listen, graceful shutdown
  app.ts       Express app factory and routes
  config.ts    environment parsing and validation
  server.ts    HTTP/HTTPS server construction
  public/      static assets for /play and /challenge (html, css, client js)
    game-logic.js       pure screen/instruction/error logic for /play, unit tested directly
    moderator-logic.js  pure phase/standings/blocked logic for /moderator, unit tested directly
    moderator.js        /moderator's DOM, sign-in and polling wiring
    api.js              /play's calls to this app's relays, with timeouts
    play.js             /play's DOM/permissions/polling wiring
    challenge-logic.js  pure identity/verdict/hint logic, unit tested directly
    camera.js           camera, location and proximity code shared by /play and /challenge
    challenge.js        DOM/fetch wiring for /challenge, imports challenge-logic.js and camera.js
docs/          player-facing docs, served at /privacy and /how-to-play
scripts/       dev tooling (self-signed cert generation)
tests/         Vitest suites
```

`app.ts` builds the app without binding a port, so tests exercise the routes
in-process via supertest.

## Docker

The image is built in three stages — compile, production dependencies, and a
[distroless](https://github.com/GoogleContainerTools/distroless) runtime that
runs as the unprivileged `nonroot` user. The runtime base is controlled by
the `RUNTIME_TAG` build arg; see "Shell access" below for the trade-off
between the two values it accepts.

```bash
docker build -t scavenger-hunt-web-app .
docker run --rm -p 3000:3000 scavenger-hunt-web-app
curl localhost:3000
```

The container serves plain HTTP by default. For HTTPS, mount a real
certificate and set `TLS_KEY_PATH`/`TLS_CERT_PATH`, or terminate TLS at a
reverse proxy in front of it.

It also carries a `HEALTHCHECK` hitting `/health` — since distroless has no
`curl` either way, it's a plain `node` script (at `/nodejs/bin/node`, the
image's own entrypoint binary; not on `PATH` for a separate `exec` the way
it is as the container's ENTRYPOINT). This works the same regardless of
`RUNTIME_TAG`.

### Shell access

`RUNTIME_TAG` picks the distroless variant the runtime stage builds from:

- **`debug-nonroot`** (current default — see issue #34): adds BusyBox (a
  shell + core utilities) on top of the hardened base, so tools that need to
  open a shell into the running container — `docker exec`, Railway's
  dashboard "console" — work:
  ```bash
  docker exec -it <container> /busybox/sh
  ```
- **`nonroot`**: the hardened image with no shell or package manager at all.
  Build with `docker build --build-arg RUNTIME_TAG=nonroot ...` to get it —
  same user, same entrypoint, same everything else, just without BusyBox.

Neither affects the app itself (same user, same entrypoint, same
`HEALTHCHECK`) — this is purely a trade-off between a smaller attack
surface (`nonroot`) and the ability to shell in for interactive debugging
(`debug-nonroot`).

### Deploying to Railway

This image is built for exactly this: a platform-only PoC deploy to
[Railway](https://railway.com/), which terminates HTTPS itself in front of
the container.

- **Build from this `Dockerfile`.** It never bakes in a TLS certificate and
  serves plain HTTP by default (see above) — don't set `TLS_KEY_PATH`/
  `TLS_CERT_PATH` or mount anything at `./certs` in this deployment; doing
  so would make the container try to speak HTTPS on a port Railway expects
  plain HTTP on.
- **`PORT`** is already read from the environment with no code changes
  needed — Railway injects its own value at container start, overriding the
  Dockerfile's `ENV PORT=3000` default.
- **Health check**: point Railway's health check (its own setting, separate
  from the Dockerfile `HEALTHCHECK` above) at `GET /health` — that's the
  signal it uses to decide when to switch traffic to a new deployment.

## License

Apache-2.0 — see [LICENSE](LICENSE).
