import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('falls back to defaults when nothing is set', () => {
    // fileExists: () => false keeps this deterministic regardless of whether
    // a real certs/dev-*.pem exists on the machine running the test.
    expect(loadConfig({}, { fileExists: () => false })).toEqual({
      port: 3000,
      host: '0.0.0.0',
      gameServerUrl: 'http://localhost:8000',
      gameServerTimeoutMs: 45000,
    });
  });

  it('reads PORT and HOST from the environment', () => {
    expect(loadConfig({ PORT: '8080', HOST: '127.0.0.1' })).toMatchObject({
      port: 8080,
      host: '127.0.0.1',
    });
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ PORT: 'http' })).toThrow(/Invalid PORT/);
  });

  it('rejects a PORT outside the valid range', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid PORT/);
  });

  it('reads GAME_SERVER_URL from the environment', () => {
    expect(loadConfig({ GAME_SERVER_URL: 'http://game-server.test' })).toMatchObject({
      gameServerUrl: 'http://game-server.test',
    });
  });

  it('reads GAME_SERVER_TIMEOUT_MS from the environment', () => {
    expect(loadConfig({ GAME_SERVER_TIMEOUT_MS: '1000' })).toMatchObject({
      gameServerTimeoutMs: 1000,
    });
  });

  it.each(['0', '-1', '1.5', 'soon'])('rejects an invalid GAME_SERVER_TIMEOUT_MS (%s)', (value) => {
    expect(() => loadConfig({ GAME_SERVER_TIMEOUT_MS: value })).toThrow(/Invalid GAME_SERVER_TIMEOUT_MS/);
  });

  describe('TLS', () => {
    it('is undefined when no cert config is set and no dev cert exists', () => {
      // This is exactly the deployed-container case (see issue #24): no
      // TLS_KEY_PATH/TLS_CERT_PATH set, no certs/ mounted — createServer()
      // then serves plain HTTP, which is what a platform like Railway
      // (terminating HTTPS itself) needs.
      const config = loadConfig({}, { fileExists: () => false });

      expect(config.tls).toBeUndefined();
    });

    it('uses TLS_KEY_PATH and TLS_CERT_PATH when both are set', () => {
      const config = loadConfig(
        { TLS_KEY_PATH: '/certs/key.pem', TLS_CERT_PATH: '/certs/cert.pem' },
        { fileExists: () => false },
      );

      expect(config.tls).toEqual({ keyPath: '/certs/key.pem', certPath: '/certs/cert.pem' });
    });

    it('throws when only TLS_KEY_PATH is set', () => {
      expect(() => loadConfig({ TLS_KEY_PATH: '/certs/key.pem' }, { fileExists: () => false })).toThrow(
        /TLS_KEY_PATH and TLS_CERT_PATH must both be set/,
      );
    });

    it('throws when only TLS_CERT_PATH is set', () => {
      expect(() => loadConfig({ TLS_CERT_PATH: '/certs/cert.pem' }, { fileExists: () => false })).toThrow(
        /TLS_KEY_PATH and TLS_CERT_PATH must both be set/,
      );
    });

    it('falls back to an auto-detected dev cert when present', () => {
      const config = loadConfig(
        {},
        { certsDir: '/repo/certs', fileExists: () => true },
      );

      expect(config.tls).toEqual({
        keyPath: '/repo/certs/dev-key.pem',
        certPath: '/repo/certs/dev-cert.pem',
      });
    });
  });
});
