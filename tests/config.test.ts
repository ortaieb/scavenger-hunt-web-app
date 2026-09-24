import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('falls back to defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      host: '0.0.0.0',
      backendUploadUrl: 'http://localhost:8000/api/challenge/uploads',
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

  it('reads BACKEND_UPLOAD_URL from the environment', () => {
    expect(loadConfig({ BACKEND_UPLOAD_URL: 'http://backend.test/uploads' })).toMatchObject({
      backendUploadUrl: 'http://backend.test/uploads',
    });
  });

  describe('TLS', () => {
    it('is undefined when no cert config is set and no dev cert exists', () => {
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
