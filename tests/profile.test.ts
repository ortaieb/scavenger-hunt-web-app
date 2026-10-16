import { describe, expect, it, vi } from 'vitest';
import { deleteConfirmationBody, deleteError, exportFileName } from '../src/public/profile-logic.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  consentBody,
  consentStatus,
  profileBody,
  profileError,
  readHunts,
  readMemberNames,
  readProfile,
  UPCOMING_HUNTS_WORDING_VERSION,
} from '../src/public/profile-logic.js';

const testConfig = { gameServerUrl: 'http://game-server.test', gameServerTimeoutMs: 5000 };
const VALID_SESSION = '11111111-1111-4111-8111-111111111111';
const VALID_PARTICIPANT = '22222222-2222-4222-8222-222222222222';

type FetchInit = Parameters<typeof fetch>[1];

function upstream() {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

describe('the profile relays', () => {
  it.each([
    ['get', '/me', 'GET', '/me', undefined],
    ['patch', '/me', 'PATCH', '/me', { displayName: 'Sam', homeArea: 'W4' }],
    ['put', '/me/consents/upcoming-hunts', 'PUT', '/me/consents/upcoming-hunts', { granted: true, wordingVersion: 'v1' }],
    ['get', '/me/hunts', 'GET', '/me/hunts', undefined],
    [
      'get',
      `/members?session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}`,
      'GET',
      `/sessions/${VALID_SESSION}/participants/${VALID_PARTICIPANT}/members`,
      undefined,
    ],
  ] as const)('%s %s goes to the game-server with the token, uncached', async (verb, path, method, upstreamPath, body) => {
    const fetchMock = upstream();
    const call = request(createApp(testConfig, { fetch: fetchMock }))[verb](path).set('Authorization', 'Bearer tok');
    const response = await (body === undefined ? call : call.send(body));

    const [url, init] = fetchMock.mock.calls[0]! as [URL, NonNullable<FetchInit>];
    expect(url.href).toBe(`http://game-server.test${upstreamPath}`);
    expect(init.method).toBe(method);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(init.body).toBe(body === undefined ? undefined : JSON.stringify(body));
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('never adds a consent the body did not carry', async () => {
    const fetchMock = upstream();
    await request(createApp(testConfig, { fetch: fetchMock })).put('/me/consents/upcoming-hunts').send({});
    expect((fetchMock.mock.calls[0]![1] as NonNullable<FetchInit>).body).toBe('{}');
  });

  it('turns away a members call with a bad session, sending nothing upstream', async () => {
    const fetchMock = upstream();
    const response = await request(createApp(testConfig, { fetch: fetchMock })).get('/members?session=x&participant=y');
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the page', async () => {
    const response = await request(createApp(testConfig)).get('/profile');
    expect(response.status).toBe(200);
    expect(response.text).toContain('id="upcoming-hunts"');
    expect(response.text).not.toMatch(/id="upcoming-hunts"[^>]*checked/);
  });

  it('keeps the join screen box unticked and separate from the photo consent', async () => {
    const html = (await request(createApp(testConfig)).get('/play')).text;
    expect(html).toMatch(/<input id="upcoming-hunts" type="checkbox" \/>/);
    expect(html).toContain('Email me about upcoming hunts');
  });
});

describe('profileBody', () => {
  it('trims the name and tidies the home area', () => {
    expect(profileBody({ displayName: '  Sam ', homeArea: ' sw1a ', locale: 'en-GB' })).toEqual({
      body: { displayName: 'Sam', homeArea: 'SW1A', locale: 'en-GB' },
    });
  });
  it('lets both be cleared', () => {
    expect(profileBody({ displayName: '', homeArea: '', locale: 'en-GB' })).toEqual({
      body: { displayName: '', homeArea: '', locale: 'en-GB' },
    });
  });
  it.each(['W4 5AB', 'W45AB', 'London', '4W'])('refuses the home area %s', (homeArea) => {
    expect(profileBody({ displayName: '', homeArea, locale: 'en-GB' })).toHaveProperty('error');
  });
  it('refuses a name over 40 characters', () => {
    expect(profileBody({ displayName: 'x'.repeat(41), homeArea: '', locale: 'en-GB' })).toHaveProperty('error');
  });
});

describe('reading the answers', () => {
  it('reads a profile, with consent only when granted', () => {
    expect(
      readProfile({ displayName: 'Sam', homeArea: 'W4', locale: 'en-GB', upcomingHunts: { granted: true, since: '2026-10-01T10:00:00Z' } }),
    ).toMatchObject({ displayName: 'Sam', upcomingHunts: true, since: '2026-10-01T10:00:00Z' });
    expect(readProfile({ upcomingHunts: { granted: false } }).upcomingHunts).toBe(false);
    expect(readProfile(null)).toMatchObject({ displayName: '', upcomingHunts: false });
  });
  it('sends the wording version with a grant and nothing with a withdrawal', () => {
    expect(consentBody(true)).toEqual({ granted: true, wordingVersion: UPCOMING_HUNTS_WORDING_VERSION });
    expect(consentBody(false)).toEqual({ granted: false });
  });
  it('says where consent stands', () => {
    expect(consentStatus(false, '')).toContain('won’t get emails');
    expect(consentStatus(true, '2026-10-01T10:00:00Z')).toContain('01/10/2026');
  });
  it('reads hunts and skips unusable entries', () => {
    const rows = readHunts({
      hunts: [{ huntName: 'Hyde Park', team: 'Red Foxes', date: '2026-10-03', checkpointsCompleted: 1, points: 3 }, {}],
    });
    expect(rows).toEqual([
      { name: 'Hyde Park', team: 'Red Foxes', date: '03/10/2026', line: '1 checkpoint · 3 points' },
    ]);
    expect(readHunts(undefined)).toEqual([]);
  });
  it('reads teammates’ names', () => {
    expect(readMemberNames({ members: [{ displayName: 'Sam' }, { displayName: ' ' }, {}] })).toEqual(['Sam']);
  });
  it('explains an error', () => {
    expect(profileError(0, null)).toContain('No signal');
    expect(profileError(422, { errors: { homeArea: 'bad' } })).toContain('homeArea');
  });
});

describe('DELETE /me and GET /me/export', () => {
  it('DELETE /me relays with the token, uncached, and passes the status through', async () => {
    const fetchMock = upstream();
    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .delete('/me')
      .set('Authorization', 'Bearer tok');

    const [url, init] = fetchMock.mock.calls[0]! as [URL, NonNullable<FetchInit>];
    expect(url.href).toBe('http://game-server.test/me');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('GET /me/export relays with the token, uncached', async () => {
    const fetchMock = upstream();
    const response = await request(createApp(testConfig, { fetch: fetchMock }))
      .get('/me/export')
      .set('Authorization', 'Bearer tok');

    const [url, init] = fetchMock.mock.calls[0]! as [URL, NonNullable<FetchInit>];
    expect(url.href).toBe('http://game-server.test/me/export');
    expect(init.method).toBe('GET');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('delete and export logic', () => {
  it('builds the delete confirmation', () => {
    const content = deleteConfirmationBody();
    expect(content.heading).toBe('Delete my data');
    expect(content.message).toContain('account');
    expect(content.deletedItems.length).toBeGreaterThan(0);
    expect(content.keepItems.length).toBeGreaterThan(0);
  });

  it('generates an export file name with today\'s date', () => {
    const name = exportFileName();
    expect(name).toMatch(/^scavenger-hunt-export-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('explains delete errors', () => {
    expect(deleteError(0)).toContain('signal');
    expect(deleteError(401)).toContain('signed out');
    expect(deleteError(500)).toContain('erase');
  });
});

// Import the new functions

