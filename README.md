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

## Scripts

| Script              | Description                                  |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Run from source in watch mode                 |
| `npm run build`     | Compile TypeScript into `dist/`               |
| `npm start`         | Run the compiled server from `dist/`          |
| `npm run typecheck` | Type-check sources, tests and config files    |
| `npm run lint`      | ESLint (type-aware rules)                     |
| `npm test`          | Run the Vitest suite                          |

## Configuration

| Variable | Default   | Description               |
| -------- | --------- | ------------------------- |
| `PORT`   | `3000`    | Port the server binds to  |
| `HOST`   | `0.0.0.0` | Interface to bind to      |

An out-of-range or non-numeric `PORT` fails fast at startup.

## Layout

```
src/
  index.ts    server bootstrap: config, listen, graceful shutdown
  app.ts      Express app factory and routes
  config.ts   environment parsing and validation
tests/        Vitest suites
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

## License

Apache-2.0 — see [LICENSE](LICENSE).
