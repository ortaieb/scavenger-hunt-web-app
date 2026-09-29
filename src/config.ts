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

  return {
    port,
    host: env.HOST ?? DEFAULT_HOST,
    gameServerUrl: env.GAME_SERVER_URL ?? DEFAULT_GAME_SERVER_URL,
    gameServerTimeoutMs,
    tls: resolveTls(env, deps),
  };
}
