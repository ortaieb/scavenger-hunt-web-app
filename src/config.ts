import { existsSync } from 'node:fs';
import path from 'node:path';

export interface TlsConfig {
  keyPath: string;
  certPath: string;
}

export interface Config {
  port: number;
  host: string;
  gameServerUrl: string;
  /** How long POST /challenge waits for the game-server before returning 504. */
  gameServerTimeoutMs: number;
  tls?: TlsConfig;
  /** Clerk's public values for sign-in (see issue #65); unset until the instance exists. */
  clerkPublishableKey?: string;
  clerkFrontendApi?: string;
  /** Needed by @clerk/express to check a player's session token (see issue #66). */
  clerkSecretKey?: string;
  /** Clerk's public key (PEM): with it, checking a token needs no network call. */
  clerkJwtKey?: string;
  /** This app's own origin, the only `azp` a session token may carry. */
  appOrigin?: string;
  /** Turn away play calls with no signed-in player, before they reach the game-server. */
  requireSignIn: boolean;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';
// The game-server is a separate service (see issue #7); POST /challenge
// relays captures to `${gameServerUrl}/challenge`. Override with
// GAME_SERVER_URL (directly, or via a .env file) once it's not on localhost.
const DEFAULT_GAME_SERVER_URL = 'http://localhost:8000';
// The referee now runs before the game-server responds (see issue #21),
// which can take several seconds; comfortably above its own timeout+retries.
const DEFAULT_GAME_SERVER_TIMEOUT_MS = 45000;

export interface ConfigDeps {
  /** Directory checked for an auto-generated dev certificate. */
  certsDir?: string;
  /** Injectable for tests; defaults to a real filesystem check. */
  fileExists?: (filePath: string) => boolean;
}

function resolveTls(env: NodeJS.ProcessEnv, deps: ConfigDeps): TlsConfig | undefined {
  const keyPath = env.TLS_KEY_PATH;
  const certPath = env.TLS_CERT_PATH;

  if (keyPath && certPath) {
    return { keyPath, certPath };
  }
  if (keyPath || certPath) {
    throw new Error('TLS_KEY_PATH and TLS_CERT_PATH must both be set, or neither');
  }

  // No explicit config: fall back to the self-signed cert `npm run certs:dev`
  // generates, so local HTTPS testing (required by camera/geolocation off
  // localhost) works without extra setup.
  const certsDir = deps.certsDir ?? path.join(process.cwd(), 'certs');
  const fileExists = deps.fileExists ?? existsSync;
  const devKeyPath = path.join(certsDir, 'dev-key.pem');
  const devCertPath = path.join(certsDir, 'dev-cert.pem');

  if (fileExists(devKeyPath) && fileExists(devCertPath)) {
    return { keyPath: devKeyPath, certPath: devCertPath };
  }

  return undefined;
}

function parseBoolean(name: string, value: string | undefined): boolean {
  if (value === undefined || value === '') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Invalid ${name}: ${value} (expected true or false)`);
}

/** The origin of APP_ORIGIN (no path, no trailing slash), or a startup error. */
function parseAppOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid APP_ORIGIN: ${value}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value.replace(/\/+$/, '')) {
    throw new Error(`Invalid APP_ORIGIN: ${value} (expected an origin such as https://hunt.example)`);
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, deps: ConfigDeps = {}): Config {
  const port = env.PORT === undefined ? DEFAULT_PORT : Number(env.PORT);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${String(env.PORT)}`);
  }

  const gameServerTimeoutMs =
    env.GAME_SERVER_TIMEOUT_MS === undefined ? DEFAULT_GAME_SERVER_TIMEOUT_MS : Number(env.GAME_SERVER_TIMEOUT_MS);
  if (!Number.isInteger(gameServerTimeoutMs) || gameServerTimeoutMs <= 0) {
    throw new Error(`Invalid GAME_SERVER_TIMEOUT_MS: ${String(env.GAME_SERVER_TIMEOUT_MS)}`);
  }

  const requireSignIn = parseBoolean('REQUIRE_SIGN_IN', env.REQUIRE_SIGN_IN);
  const appOrigin = parseAppOrigin(env.APP_ORIGIN);
  // A multi-line PEM often travels in one line with literal "\n"s.
  const clerkJwtKey = env.CLERK_JWT_KEY ? env.CLERK_JWT_KEY.replace(/\\n/g, '\n') : undefined;
  if (requireSignIn) {
    // Failing at startup beats turning every player away (or letting every
    // one in) because of a missing setting.
    if (!env.CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) {
      throw new Error('REQUIRE_SIGN_IN needs CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY');
    }
    if (!appOrigin) {
      throw new Error('REQUIRE_SIGN_IN needs APP_ORIGIN, the only origin a session token may be issued for');
    }
  }

  return {
    port,
    host: env.HOST ?? DEFAULT_HOST,
    gameServerUrl: env.GAME_SERVER_URL ?? DEFAULT_GAME_SERVER_URL,
    gameServerTimeoutMs,
    tls: resolveTls(env, deps),
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || undefined,
    clerkFrontendApi: env.CLERK_FRONTEND_API || undefined,
    clerkSecretKey: env.CLERK_SECRET_KEY || undefined,
    clerkJwtKey,
    appOrigin,
    requireSignIn,
  };
}
