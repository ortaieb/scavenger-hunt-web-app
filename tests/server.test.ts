import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');
const testConfig = { gameServerUrl: 'http://game-server.test', gameServerTimeoutMs: 5000 };

describe('createServer', () => {
  it('returns a plain HTTP server when no TLS config is set', () => {
    const server = createServer(createApp(testConfig), { ...testConfig, port: 0, host: '127.0.0.1' });

    expect(server).toBeInstanceOf(HttpServer);
    expect(server).not.toBeInstanceOf(HttpsServer);
  });

  it('returns an HTTPS server when TLS config is set', () => {
    const server = createServer(createApp(testConfig), {
      ...testConfig,
      port: 0,
      host: '127.0.0.1',
      tls: {
        keyPath: path.join(fixturesDir, 'test-key.pem'),
        certPath: path.join(fixturesDir, 'test-cert.pem'),
      },
    });

    expect(server).toBeInstanceOf(HttpsServer);
  });
});
