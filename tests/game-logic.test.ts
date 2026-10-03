import { describe, expect, it } from 'vitest';
import {
  clockOffset,
  clockOffsetFromState,
  clueLineFor,
  formatCountdown,
  formatPlannedTime,
  identityFromJoin,
  instructionFor,
  normaliseTeamCode,
  ordinal,
  pointsLabel,
  pointsSheetFor,
  progressLabel,
  readIdentity,
  screenFor,
  screenForError,
  showsStatusBar,
  teamLabel,
  timeLeftFor,
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
      'code issued',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'code' } },
      'Strike the pose and take the photo.',
    ],
    [
      'photo taken',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'photo' } },
      'Check your photo, then send it.',
    ],
    [
      'sending',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'sending' } },
      'The referee is checking your photo.',
    ],
    [
      'verdict pass',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'verdict', verdict: 'pass' } },
      'Checkpoint done. Tap "Next clue".',
    ],
    [
      'verdict pending',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'verdict', verdict: 'pending' } },
      'A moderator will check your photo. Tap "Next clue".',
    ],
    [
      'verdict failed',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'verdict', verdict: 'failed' } },
      'Not quite. Read why, then tap "Try again".',
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

describe('status bar', () => {
  const plannedEnd = '2026-10-03T13:00:00Z';
  const endMs = Date.parse(plannedEnd);
  const clock = {
    phase: 'running',
    'planned-start': '2026-10-03T10:00:00Z',
    'planned-end': plannedEnd,
    'started-at': '2026-10-03T10:01:00Z',
    'stopped-at': null,
    'server-time': '2026-10-03T12:00:00Z',
  };
  const running = { ...playing, session: clock, score: { points: 7, 'in-review': 0, final: false, place: null } };
  const app = (state: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
    identity,
    permissions: 'granted' as const,
    state: state as never,
    ...extra,
  });

  describe('showsStatusBar', () => {
    it.each([
      ['join', false],
      ['permissions', false],
      ['loading', false],
      ['lobby', true],
      ['playing', true],
      ['finished', true],
      ['ended', true],
    ] as const)('%s → %s', (screen, shown) => {
      expect(showsStatusBar(screen)).toBe(shown);
    });
  });

  describe('teamLabel', () => {
    it('keeps a name of up to 14 characters', () => {
      expect(teamLabel('Red Foxes')).toBe('Red Foxes');
      expect(teamLabel('Fourteen chars')).toBe('Fourteen chars');
    });

    it('cuts a longer name to 14 characters, ending in an ellipsis', () => {
      const label = teamLabel('The Magnificent Seven');
      expect(label).toBe('The Magnifice…');
      expect(label).toHaveLength(14);
    });

    it('is empty for a missing name', () => {
      expect(teamLabel(undefined)).toBe('');
    });
  });

  describe('progressLabel', () => {
    it('shows completed of total', () => {
      expect(progressLabel({ ...playing, progress: { completed: 0, total: 3 } })).toBe('0 of 3');
      expect(progressLabel(playing)).toBe('1 of 3');
    });

    it('adds a tick once finished', () => {
      expect(progressLabel({ status: 'finished', progress: { completed: 3, total: 3 }, current: null })).toBe(
        '3 of 3 ✓',
      );
    });

    it('is empty with no progress', () => {
      expect(progressLabel(null)).toBe('');
      expect(progressLabel({ status: 'playing' })).toBe('');
    });
  });

  describe('pointsLabel', () => {
    it('shows the points', () => {
      expect(pointsLabel({ points: 7, 'in-review': 0 })).toEqual({ text: '7 pts', inReview: false, final: false });
      expect(pointsLabel({ points: 1 })?.text).toBe('1 pt');
    });

    it('adds a dot while a photo is in review', () => {
      expect(pointsLabel({ points: 9, 'in-review': 1 })).toEqual({ text: '9 pts •', inReview: true, final: false });
    });

    it('is null for an older game-server with no score', () => {
      expect(pointsLabel(undefined)).toBeNull();
      expect(pointsLabel(null)).toBeNull();
    });
  });

  describe('ordinal', () => {
    it.each([
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
      [11, '11th'],
      [12, '12th'],
      [13, '13th'],
      [21, '21st'],
      [22, '22nd'],
      [101, '101st'],
    ])('%i → %s', (n, expected) => {
      expect(ordinal(n)).toBe(expected);
    });
  });

  describe('pointsSheetFor', () => {
    it('explains scoring with the current points', () => {
      const sheet = pointsSheetFor({ points: 7, 'in-review': 0, final: false, place: null });

      expect(sheet.title).toBe('Points');
      expect(sheet.lines[0]).toBe('Your points if the session finished now: 7.');
      expect(sheet.lines).toContain('Lowest wins.');
      expect(sheet.lines.join(' ')).toContain('N+1');
      expect(sheet.lines.join(' ')).not.toContain('In review');
    });

    it('says what in review means while a photo is in review', () => {
      expect(pointsSheetFor({ points: 9, 'in-review': 2 }).lines.join(' ')).toContain(
        'In review: 2 photos are waiting for a moderator.',
      );
    });

    it('shows the final points and place after the finish', () => {
      const sheet = pointsSheetFor({ points: 6, 'in-review': 0, final: true, place: 2 });

      expect(sheet.title).toBe('Final points');
      expect(sheet.lines[0]).toBe('Final points: 6. Your team came 2nd.');
    });
  });

  describe('timeLeftFor', () => {
    it.each([
      ['h:mm:ss above an hour', 2 * 3_600_000 + 47 * 60_000 + 12_000, { text: '2:47:12', words: '', level: 'normal' }],
      ['m:ss under an hour', 47 * 60_000 + 12_000, { text: '47:12', words: '', level: 'normal' }],
      ['normal at exactly 15 minutes', 15 * 60_000, { text: '15:00', words: '', level: 'normal' }],
      ['amber under 15 minutes', 14 * 60_000 + 59_000, { text: '14:59', words: '15 min left', level: 'amber' }],
      ['amber at exactly 5 minutes', 5 * 60_000, { text: '5:00', words: '5 min left', level: 'amber' }],
      ['red under 5 minutes', 4 * 60_000 + 10_000, { text: '4:10', words: '5 min left', level: 'red' }],
      ['red, rounding up the last minute', 30_000, { text: '0:30', words: '1 min left', level: 'red' }],
      ['"Finishing soon" at the planned end', 0, { text: 'Finishing soon', words: '', level: 'over' }],
      ['"Finishing soon" past the planned end', -60_000, { text: 'Finishing soon', words: '', level: 'over' }],
    ])('%s', (_label, remaining, expected) => {
      expect(timeLeftFor(app(running), endMs - remaining)).toEqual(expected);
    });

    it('shows the planned start in the lobby', () => {
      const lobby = { ...notStarted, session: { ...clock, phase: 'scheduled', 'started-at': null } };
      const expected = `Planned start ${formatPlannedTime(clock['planned-start'])}`;

      expect(timeLeftFor(app(lobby), endMs)).toEqual({ text: expected, words: '', level: 'lobby' });
    });

    it("falls back to the join response's planned times when /state has no clock", () => {
      const end = Date.parse(identity.session['end-time']);

      expect(timeLeftFor(app(playing), end - 65_000).text).toBe('1:05');
      expect(timeLeftFor(app(notStarted), end).text).toBe(
        `Planned start ${formatPlannedTime(identity.session['start-time'])}`,
      );
    });

    it.each([
      ['finished', { ...running, status: 'finished', current: null }],
      ['ended', { ...running, status: 'ended', current: null }],
      ['stopped', { ...running, session: { ...clock, phase: 'stopped' } }],
    ])('shows nothing once %s', (_label, state) => {
      expect(timeLeftFor(app(state), endMs - 60_000).level).toBe('none');
    });
  });

  describe('clockOffsetFromState', () => {
    it("re-syncs from the state's server time", () => {
      const receivedAt = Date.parse('2026-10-03T11:59:58Z');
      expect(clockOffsetFromState(running, receivedAt)).toBe(2_000);
    });

    it('trusts the phone when there is no server time', () => {
      expect(clockOffsetFromState(playing, Date.now())).toBe(0);
    });
  });

  describe('clueLineFor', () => {
    it('is hidden on the Clue screen, where the clue fills the body', () => {
      expect(clueLineFor(app(running))).toEqual({ text: playing.current.clue, isClue: true, hidden: true });
    });

    it('shows the clue once past the Clue screen', () => {
      expect(clueLineFor(app(running, { checkpoint: { step: 'code' } }))).toEqual({
        text: playing.current.clue,
        isClue: true,
        hidden: false,
      });
    });

    it.each([
      ['lobby', notStarted, 'Waiting for the moderator'],
      ['finished', { ...running, status: 'finished', current: null }, 'All done'],
      ['session over', { ...running, status: 'ended', current: null }, 'Session over'],
    ])('shows the phase in the %s', (_label, state, text) => {
      expect(clueLineFor(app(state))).toEqual({ text, isClue: false, hidden: false });
    });

    it('is hidden before the lobby', () => {
      expect(clueLineFor({ identity: null, permissions: 'unknown', state: null }).hidden).toBe(true);
    });
  });
});
