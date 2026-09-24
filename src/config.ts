import { existsSync } from 'node:fs';
import path from 'node:path';

export interface TlsConfig {
  keyPath: string;
  certPath: string;
}

export interface Config {
  port: number;
  host: string;
  backendUploadUrl: string;
  tls?: TlsConfig;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';
// The FastAPI backend is built separately (see issue #3); this default keeps
// `npm run dev` usable out of the box and should be overridden once it exists.
const DEFAULT_BACKEND_UPLOAD_URL = 'http://localhost:8000/api/challenge/uploads';

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

  return {
    port,
    host: env.HOST ?? DEFAULT_HOST,
    backendUploadUrl: env.BACKEND_UPLOAD_URL ?? DEFAULT_BACKEND_UPLOAD_URL,
    tls: resolveTls(env, deps),
  };
}
