import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('falls back to defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({ port: 3000, host: '0.0.0.0' });
  });

  it('reads PORT and HOST from the environment', () => {
    expect(loadConfig({ PORT: '8080', HOST: '127.0.0.1' })).toEqual({
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
});
