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

`GET /` responds with `hello, world!` as plain text.

### /challenge

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
result. The game-server alone decides the verdict; this app never
recomputes or reinterprets it, only relays and displays it:

- `202` + a `pending` body → "Checks passed, waiting for the referee."
- `200` + a `failed` body (with `rejections`) → each rejection's message,
  verbatim, and Submit is replaced by **Retake**
- `404` → "Unknown game or checkpoint, check your link"
- anything else, or a network failure → the status code and error body

Where an attempt number is present in the verdict, it's shown alongside the
message. The exact verdict response shape (field names for the attempt
number and rejection list) is inferred from the issue that introduced this —
worth double-checking against the real game-server once both are deployed
together.

The browser posts to this app's own `/challenge`, not the game-server
directly: this app runs over HTTPS off `localhost` (required for the camera
API, see below), and the game-server isn't guaranteed to serve HTTPS or
allow our origin via CORS, so the request has to go server-to-server.

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

| Variable          | Default                 | Description                                                    |
| ----------------- | ------------------------ | ---------------------------------------------------------------- |
| `PORT`            | `3000`                   | Port the server binds to                                          |
| `HOST`            | `0.0.0.0`                | Interface to bind to                                              |
| `GAME_SERVER_URL` | `http://localhost:8000` | Base URL of the game-server; `POST /challenge` relays to `<this>/challenge` |
| `TLS_KEY_PATH`    | —                        | Path to a TLS private key; must be set with `TLS_CERT_PATH`       |
| `TLS_CERT_PATH`   | —                        | Path to a TLS certificate; must be set with `TLS_KEY_PATH`        |

Copy `.env.example` to `.env` to override any of these locally — it's loaded
automatically (and gitignored).

An out-of-range or non-numeric `PORT` fails fast at startup, as does setting
only one of `TLS_KEY_PATH`/`TLS_CERT_PATH`.

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
  public/      static assets for /challenge (html, css, client js)
    challenge-logic.js  pure identity/verdict/hint logic, unit tested directly
    challenge.js        DOM/camera/fetch wiring, imports challenge-logic.js
scripts/       dev tooling (self-signed cert generation)
tests/         Vitest suites
```

`app.ts` builds the app without binding a port, so tests exercise the routes
in-process via supertest.

## Docker

The image is built in three stages — compile, production dependencies, and a
[distroless](https://github.com/GoogleContainerTools/distroless) runtime with no
shell or package manager that runs as the unprivileged `nonroot` user.

```bash
docker build -t scavenger-hunt-web-app .
docker run --rm -p 3000:3000 scavenger-hunt-web-app
curl localhost:3000
```

The container serves plain HTTP by default. For HTTPS, mount a real
certificate and set `TLS_KEY_PATH`/`TLS_CERT_PATH`, or terminate TLS at a
reverse proxy in front of it.

## License

Apache-2.0 — see [LICENSE](LICENSE).
