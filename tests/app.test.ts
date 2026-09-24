import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('GET /', () => {
  it('returns "hello, world!" as plain text', async () => {
    const response = await request(createApp()).get('/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toBe('hello, world!');
  });
});

describe('unknown routes', () => {
  it('responds with 404', async () => {
    const response = await request(createApp()).get('/nope');

    expect(response.status).toBe(404);
  });
});
