import { describe, expect, it } from 'vitest';
import {
  clockOffset,
  formatCountdown,
  formatPlannedTime,
  identityFromJoin,
  instructionFor,
  normaliseTeamCode,
  readIdentity,
  screenFor,
  screenForError,
} from '../src/public/game-logic.js';

const identity = {
  session: {
    id: 'aeffe667-4f9f-4108-b5e2-56ae821fe413',
    name: 'Hyde Park Saturday Hunt',
    location: 'Hyde Park and Kensington Gardens, London',
    'start-time': '2026-10-03T10:00:00+01:00',
    'end-time': '2026-10-03T13:00:00+01:00',
  },
  participant: '7c860ccc-9adf-4e22-b54f-3ff158f5d600',
  team: 'Red Foxes',
};

const notStarted = { status: 'not_started', team: 'Red Foxes', progress: { completed: 0, total: 3 }, current: null };
const playing = {
  status: 'playing',
  team: 'Red Foxes',
  progress: { completed: 1, total: 3 },
  current: { sequence: 2, position: 2, clue: 'He promised never to grow old.', open: true },
};

describe('screenFor', () => {
  it('shows Join when there is no stored identity', () => {
    expect(screenFor({ identity: null, permissions: 'granted', state: notStarted })).toBe('join');
  });

  it.each(['unknown', 'denied'] as const)('shows Permissions after join while they are %s', (permissions) => {
    expect(screenFor({ identity, permissions, state: notStarted })).toBe('permissions');
  });

  it('shows Loading until the first state arrives', () => {
    expect(screenFor({ identity, permissions: 'granted', state: null })).toBe('loading');
  });

  it.each([
    ['not_started', 'lobby'],
    ['playing', 'playing'],
    ['finished', 'finished'],
    ['ended', 'ended'],
    ['something_new', 'loading'],
  ])('maps status %s to %s', (status, screen) => {
    expect(screenFor({ identity, permissions: 'granted', state: { ...playing, status } })).toBe(screen);
  });

  it('shows Session over once the session clock says stopped, whatever the status', () => {
    const state = { ...playing, session: { phase: 'stopped' } };
    expect(screenFor({ identity, permissions: 'granted', state })).toBe('ended');
  });
});

describe('instructionFor', () => {
  it.each([
    ['not joined', { identity: null, permissions: 'unknown', state: null }, 'Enter your team code to join.'],
    [
      'joined, permissions not yet asked',
      { identity, permissions: 'unknown', state: null },
      'Allow the camera and location so you can check in at checkpoints.',
    ],
    [
      'joined, permissions denied',
      { identity, permissions: 'denied', state: null },
      'Turn on camera and location for this site, then tap "Try again".',
    ],
    ['loading', { identity, permissions: 'granted', state: null }, 'Loading your game…'],
    [
      'joined, not started',
      { identity, permissions: 'granted', state: notStarted },
      'Waiting for the moderator to start.',
    ],
    [
      'clue shown, checkpoint open',
      { identity, permissions: 'granted', state: playing },
      'Solve the clue and go there. Tap "I\'m here" when you arrive.',
    ],
    [
      'clue shown, checkpoint not open',
      { identity, permissions: 'granted', state: { ...playing, current: { ...playing.current, open: false } } },
      "This checkpoint isn't open yet. Check back soon.",
    ],
    [
      'finished',
      { identity, permissions: 'granted', state: { ...playing, status: 'finished', current: null } },
      'All checkpoints done. Wait for the moderator.',
    ],
    [
      'session over',
      { identity, permissions: 'granted', state: { ...playing, status: 'ended', current: null } },
      'The session is over. Thanks for playing!',
    ],
    [
      'offline',
      { identity, permissions: 'granted', state: notStarted, offline: true },
      "No connection. We'll retry when you're back online.",
    ],
  ] as const)('%s', (_label, appState, instruction) => {
    expect(instructionFor(appState)).toBe(instruction);
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, '0:00'],
    [-5000, '0:00'],
    [Number.NaN, '0:00'],
    [999, '0:00'],
    [5_000, '0:05'],
    [65_000, '1:05'],
    [59 * 60_000 + 59_000, '59:59'],
    [60 * 60_000, '1:00:00'],
    [2 * 3_600_000 + 47 * 60_000 + 12_000, '2:47:12'],
    [3_600_000 + 5 * 60_000 + 3_000, '1:05:03'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });
});

describe('clockOffset', () => {
  it('is the server time minus the phone time on arrival', () => {
    const receivedAt = Date.parse('2026-10-03T09:00:00Z');
    expect(clockOffset('2026-10-03T09:00:30Z', receivedAt)).toBe(30_000);
    expect(clockOffset('2026-10-03T08:59:58Z', receivedAt)).toBe(-2_000);
  });

  it.each([undefined, null, '', 'not a time', 42])('is 0 for a missing or bad server time (%j)', (serverTime) => {
    expect(clockOffset(serverTime, Date.now())).toBe(0);
  });
});

describe('screenForError', () => {
  it('sends an unknown team code (or a stale identity) back to Join, forgetting the identity', () => {
    const result = screenForError(404, { detail: 'unknown code' });

    expect(result.screen).toBe('join');
    expect(result.forgetIdentity).toBe(true);
    expect(result.message).toContain("don't recognise that team code");
  });

  it("says the session is over for today's plain 409 from /join", () => {
    expect(screenForError(409, { detail: 'session has ended' })).toEqual({
      screen: 'ended',
      message: 'This session is over.',
      forgetIdentity: false,
    });
  });

  it('branches on `code`, not `detail`', () => {
    expect(screenForError(409, { detail: 'anything at all', code: 'session_stopped' }).screen).toBe('ended');
    expect(screenForError(409, { detail: 'session has ended', code: 'session_not_started' }).screen).toBe('lobby');
  });

  it('keeps the player on the form for an invalid body', () => {
    const result = screenForError(422, { detail: 'consent must be true' });

    expect(result.screen).toBeNull();
    expect(result.message).toContain('tick the box');
  });

  it.each([0, 502, 503, 504])('treats %i as a lost connection, staying put', (status) => {
    expect(screenForError(status, null)).toEqual({
      screen: null,
      message: "No connection. We'll retry when you're back online.",
      forgetIdentity: false,
    });
  });

  it('falls back to a generic message for anything else', () => {
    expect(screenForError(500, 'not json').message).toBe('Something went wrong (error 500). Please try again.');
  });
});

describe('normaliseTeamCode', () => {
  it('upper-cases and trims', () => {
    expect(normaliseTeamCode('  fox-7q2k ')).toBe('FOX-7Q2K');
  });
});

describe('readIdentity / identityFromJoin', () => {
  it('keeps session, participant and team from a join response, dropping the rest', () => {
    const joinResponse = { ...identity, checkpoints: 3 };

    expect(identityFromJoin(joinResponse)).toEqual(identity);
  });

  it.each([
    null,
    'a string',
    {},
    { ...identity, participant: 42 },
    { ...identity, team: undefined },
    { ...identity, session: 'aeffe667-4f9f-4108-b5e2-56ae821fe413' },
    { ...identity, session: { name: 'no id' } },
  ])('rejects %j', (value) => {
    expect(readIdentity(value)).toBeNull();
  });
});

describe('formatPlannedTime', () => {
  it('formats a planned time as the local clock time', () => {
    const iso = '2026-10-03T10:00:00+01:00';
    const expected = new Date(Date.parse(iso)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    expect(formatPlannedTime(iso)).toBe(expected);
  });

  it.each([undefined, '', 'soon'])('is empty for %j', (value) => {
    expect(formatPlannedTime(value)).toBe('');
  });
});
