import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const testConfig = { backendUploadUrl: 'http://backend.test/api/challenge/uploads' };

describe('GET /', () => {
  it('returns "hello, world!" as plain text', async () => {
    const response = await request(createApp(testConfig)).get('/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toBe('hello, world!');
  });
});

describe('GET /challenge', () => {
  it('serves the capture page', async () => {
    const response = await request(createApp(testConfig)).get('/challenge');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.text).toContain('<video');
  });
});

describe('GET /challenge.js', () => {
  it('serves the client script', async () => {
    const response = await request(createApp(testConfig)).get('/challenge.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('getUserMedia');
  });
});

describe('GET /api/challenge/config', () => {
  it('exposes the configured backend upload URL', async () => {
    const response = await request(createApp(testConfig)).get('/api/challenge/config');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ uploadUrl: testConfig.backendUploadUrl });
  });
});

describe('unknown routes', () => {
  it('responds with 404', async () => {
    const response = await request(createApp(testConfig)).get('/nope');

    expect(response.status).toBe(404);
  });
});
