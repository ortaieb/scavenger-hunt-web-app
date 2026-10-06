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
  checkpointAfterArrive,
  checkpointAfterCheckIn,
  challengeErrorFor,
  CHECK_IN_RAN_OUT,
  onlyCheckInFailed,
  finishedSummary,
  sessionOverSummary,
  sessionRejectionFor,
  stateAfterError,
  checkpointAfterPhoto,
  checkpointAfterRetake,
  checkpointAfterVerdict,
  checkpointSending,
  codeExpired,
  codeTimeLeft,
  pollIntervalFor,
  verdictHeading,
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
    ['playing', 'clue'],
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
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'code', sequence: 2 } },
      'Strike the pose and take the photo.',
    ],
    [
      'photo taken',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'photo', sequence: 2 } },
      'Check your photo, then send it.',
    ],
    [
      'sending',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'sending', sequence: 2 } },
      'The referee is checking your photo.',
    ],
    [
      'verdict pass',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'verdict', sequence: 2, verdict: 'pass' } },
      'Checkpoint done. Tap "Next clue".',
    ],
    [
      'verdict pending',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'verdict', sequence: 2, verdict: 'pending' } },
      'A moderator will check your photo. Tap "Next clue".',
    ],
    [
      'verdict failed',
      { identity, permissions: 'granted', state: playing, checkpoint: { step: 'verdict', sequence: 2, verdict: 'failed' } },
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
      reload: false,
      offline: false,
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
      reload: false,
      offline: true,
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
      ['clue', true],
      ['capture', true],
      ['review', true],
      ['checking', true],
      ['verdict', true],
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
      expect(clueLineFor(app(running, { checkpoint: { step: 'code', sequence: 2 } }))).toEqual({
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

describe('playing a checkpoint', () => {
  const arriveBody = {
    checkpoint: 2,
    pose: 'Arms raised as if flying.',
    code: '4821',
    'issued-at': '2026-10-03T09:41:05Z',
    'expires-at': '2026-10-03T09:51:05Z',
  };
  const issued = { value: '4821', pose: 'Arms raised as if flying.', issuedAt: arriveBody['issued-at'], expiresAt: arriveBody['expires-at'] };
  const app = (checkpoint: Record<string, unknown> | null, state: Record<string, unknown> = playing) => ({
    identity,
    permissions: 'granted' as const,
    state: state as never,
    checkpoint: checkpoint as never,
  });

  /** Real POST /challenge response bodies, with the server's `check` field (see issue #38). */
  function verdictBody(verdict: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      verdict: {
        game: 'hunt-1',
        participant: identity.participant,
        checkpoint: {
          sequence: 2,
          attempt: 2,
          time: '2026-10-03T09:45:00Z',
          verdict,
          checks: [
            { check: 'window_open', outcome: 'passed', confidence: 1, reason: 'Open.' },
            { check: 'photo_unique', outcome: 'skipped', confidence: 0, reason: 'Not checked.' },
            { check: 'pose_correct', outcome: verdict === 'failed' ? 'failed' : 'passed', confidence: 0.9, reason: 'Pose.' },
          ],
          rejections: verdict === 'failed' ? [{ code: 'pose_mismatch', message: "Your pose doesn't match the challenge." }] : [],
          ...extra,
        },
      },
      image_id: 'img-1',
    });
  }

  describe('screens', () => {
    it.each([
      ['no progress yet', null, 'clue'],
      ['a code issued', { step: 'code', sequence: 2 }, 'capture'],
      ['a photo taken', { step: 'photo', sequence: 2 }, 'review'],
      ['the photo sending', { step: 'sending', sequence: 2 }, 'checking'],
      ['a verdict back', { step: 'verdict', sequence: 2, verdict: 'failed' }, 'verdict'],
    ])('shows the right screen with %s', (_label, checkpoint, screen) => {
      expect(screenFor(app(checkpoint))).toBe(screen);
    });

    it('goes back to the clue when the server has moved on to another checkpoint', () => {
      expect(screenFor(app({ step: 'code', sequence: 1 }))).toBe('clue');
    });

    it('keeps a pass up after the server has moved on, until "Next clue"', () => {
      const next = { ...playing, current: { ...playing.current, sequence: 3 } };
      expect(screenFor(app({ step: 'verdict', sequence: 2, verdict: 'pass' }, next))).toBe('verdict');
    });

    it('keeps the last pass up after the server says finished', () => {
      const finished = { ...playing, status: 'finished', current: null };
      expect(screenFor(app({ step: 'verdict', sequence: 3, verdict: 'pass' }, finished))).toBe('verdict');
      expect(screenFor(app(null, finished))).toBe('finished');
    });

    it('drops everything once the session is over', () => {
      const ended = { ...playing, status: 'ended', current: null };
      expect(screenFor(app({ step: 'photo', sequence: 2 }, ended))).toBe('ended');
    });
  });

  describe("checkpointAfterArrive (I'm here, Try again, code expiry)", () => {
    it.each([200, 201])('shows the code on Capture for a %i', (status) => {
      expect(checkpointAfterArrive(null, 2, status, arriveBody)).toEqual({
        checkpoint: { step: 'code', sequence: 2, code: issued },
        error: null,
      });
    });

    it('hides the pose when it is null', () => {
      expect(checkpointAfterArrive(null, 2, 201, { ...arriveBody, pose: null }).checkpoint?.code?.pose).toBeNull();
    });

    it('Try again after a failed verdict goes back to Capture with a fresh code', () => {
      const failed = { step: 'verdict' as const, sequence: 2, verdict: 'failed' as const };
      const result = checkpointAfterArrive(failed, 2, 201, { ...arriveBody, code: '9150' });

      expect(result.checkpoint?.step).toBe('code');
      expect(result.checkpoint?.code?.value).toBe('9150');
      expect(screenFor(app(result.checkpoint))).toBe('capture');
    });

    it('a code that expires on Review is replaced quietly, keeping the photo', () => {
      const review = { step: 'photo' as const, sequence: 2, code: issued };
      const result = checkpointAfterArrive(review, 2, 200, { ...arriveBody, code: '7302' });

      expect(result.checkpoint).toEqual({ step: 'photo', sequence: 2, code: { ...issued, value: '7302' } });
      expect(screenFor(app(result.checkpoint))).toBe('review');
    });

    it('a code that expires on Capture is replaced, staying on Capture', () => {
      const capture = { step: 'code' as const, sequence: 2, code: issued };
      const result = checkpointAfterArrive(capture, 2, 200, { ...arriveBody, code: '7302' });

      expect(screenFor(app(result.checkpoint))).toBe('capture');
    });

    it('keeps the previous progress and reports an error when arrive is refused', () => {
      const result = checkpointAfterArrive(null, 2, 409, { detail: 'not your current checkpoint' });

      expect(result.checkpoint).toBeNull();
      expect(result.error?.screen).toBeNull();
      expect(result.error?.message).toContain("Couldn't check in");
    });

    it('follows the game-server code when there is one', () => {
      const result = checkpointAfterArrive(null, 2, 409, { detail: '…', code: 'session_stopped' });
      expect(result.error?.screen).toBe('ended');
    });

    it('treats a 2xx without a code as an error', () => {
      expect(checkpointAfterArrive(null, 2, 201, {}).error?.message).toBe('Something went wrong. Please try again.');
    });
  });

  describe('photo, retake and send', () => {
    const capture = { step: 'code' as const, sequence: 2, code: issued };

    it('Take photo → Review, Retake → Capture, Send → Checking', () => {
      const review = checkpointAfterPhoto(capture);
      expect(screenFor(app(review))).toBe('review');
      expect(screenFor(app(checkpointAfterRetake(review)))).toBe('capture');
      expect(screenFor(app(checkpointSending(review)))).toBe('checking');
    });
  });

  describe('checkpointAfterVerdict', () => {
    const sending = { step: 'sending' as const, sequence: 2, code: issued };

    it.each([
      ['pass', 200, '✓ Checkpoint done', 'Checkpoint done. Tap "Next clue".'],
      ['pending', 202, '? In review', 'A moderator will check your photo. Tap "Next clue".'],
      ['failed', 200, '✗ Not quite', 'Not quite. Read why, then tap "Try again".'],
    ] as const)('a %s goes to the Verdict screen', (verdict, status, heading, instruction) => {
      const checkpoint = checkpointAfterVerdict(sending, status, verdictBody(verdict));

      expect(checkpoint.step).toBe('verdict');
      expect(checkpoint.verdict).toBe(verdict);
      expect(screenFor(app(checkpoint))).toBe('verdict');
      expect(verdictHeading(checkpoint)).toBe(heading);
      expect(instructionFor(app(checkpoint))).toBe(instruction);
    });

    it('lists the checks with their labels, hiding skipped ones', () => {
      const checkpoint = checkpointAfterVerdict(sending, 200, verdictBody('failed'));

      expect(checkpoint.display?.checklist).toEqual([
        { icon: '✓', label: 'Checkpoint open', reason: 'Open.' },
        { icon: '✗', label: 'Right pose', reason: 'Pose.' },
      ]);
      expect(checkpoint.display?.message).toContain("Your pose doesn't match the challenge.");
    });

    it('goes back to Review, keeping the photo, when the send fails', () => {
      const checkpoint = checkpointAfterVerdict(sending, 504, '{"error":"The game server took too long to respond"}');

      expect(screenFor(app(checkpoint))).toBe('review');
      expect(checkpoint.message).toBe('The referee took too long. Please try again.');
    });

    it('says the photo is kept when there was no connection', () => {
      const checkpoint = checkpointAfterVerdict(sending, 0, '');

      expect(screenFor(app(checkpoint))).toBe('review');
      expect(checkpoint.message).toContain('Your photo is kept');
    });
  });

  describe('a photo refused only for its check-in (game-server#61)', () => {
    const sending = { step: 'sending' as const, sequence: 2, code: issued };
    const CHECK_IN_MESSAGES: Record<string, string> = {
      check_in_expired: "Your check-in ran out. Tap I'm here again, then send your photo.",
      not_checked_in: "Tap I'm here at the checkpoint before sending a photo.",
    };

    /**
     * A real POST /challenge body for a photo whose `checked_in` failed: the
     * referee isn't consulted, so the visual checks are skipped. `alsoOutOfRange`
     * fails the geofence too.
     */
    function checkInVerdict(code: string, { alsoOutOfRange = false } = {}) {
      const rejections = [{ code, message: CHECK_IN_MESSAGES[code] }];
      if (alsoOutOfRange) {
        rejections.push({ code: 'out_of_range', message: "You're not inside the checkpoint area." });
      }
      return JSON.stringify({
        verdict: {
          game: identity.session.id,
          participant: identity.participant,
          checkpoint: {
            sequence: 2,
            attempt: 3,
            time: '2026-10-03T09:52:00Z',
            verdict: 'failed',
            checks: [
              { check: 'session_running', outcome: 'passed', confidence: 1, reason: 'The session is running.' },
              { check: 'checked_in', outcome: 'failed', confidence: 1, reason: CHECK_IN_MESSAGES[code] },
              { check: 'window_open', outcome: 'passed', confidence: 1, reason: 'Open.' },
              { check: 'capture_fresh', outcome: 'passed', confidence: 1, reason: 'Recent.' },
              { check: 'capture_time_plausible', outcome: 'passed', confidence: 1, reason: 'Plausible.' },
              alsoOutOfRange
                ? { check: 'in_range', outcome: 'failed', confidence: 1, reason: "You're not inside the checkpoint area." }
                : { check: 'in_range', outcome: 'passed', confidence: 1, reason: 'Inside.' },
              { check: 'photo_unique', outcome: 'passed', confidence: 1, reason: 'New.' },
              { check: 'scene_matches', outcome: 'skipped', confidence: 0, reason: 'Not checked for this attempt.' },
              { check: 'pose_correct', outcome: 'skipped', confidence: 0, reason: 'Not checked for this attempt.' },
            ],
            rejections,
          },
        },
        image_id: 'img-3',
      });
    }

    it.each(['check_in_expired', 'not_checked_in'])(
      'a %s alone checks in again and goes back to Review, keeping the photo',
      (code) => {
        const body = checkInVerdict(code);
        expect(onlyCheckInFailed(body)).toBe(true);
        expect(challengeErrorFor(200, body)).toBeNull();

        const { checkpoint, error } = checkpointAfterCheckIn(sending, 201, { ...arriveBody, code: '6034' });

        expect(error).toBeNull();
        expect(checkpoint).toEqual({
          step: 'photo',
          sequence: 2,
          code: { ...issued, value: '6034' },
          message: 'Your check-in ran out. Tap Send to try again.',
        });
        expect(checkpoint?.message).toBe(CHECK_IN_RAN_OUT);
        expect(screenFor(app(checkpoint))).toBe('review');
      },
    );

    it('keeps the photo when the server returns the check-in it already has (200)', () => {
      const { checkpoint } = checkpointAfterCheckIn(sending, 200, arriveBody);

      expect(checkpoint?.code).toEqual(issued);
      expect(screenFor(app(checkpoint))).toBe('review');
    });

    it.each(['check_in_expired', 'not_checked_in'])(
      'a %s with another failed check goes to the Verdict screen as before',
      (code) => {
        const body = checkInVerdict(code, { alsoOutOfRange: true });
        expect(onlyCheckInFailed(body)).toBe(false);

        const checkpoint = checkpointAfterVerdict(sending, 200, body);

        expect(screenFor(app(checkpoint))).toBe('verdict');
        expect(verdictHeading(checkpoint)).toBe('✗ Not quite');
        expect(checkpoint.display?.checklist).toContainEqual({
          icon: '✗',
          label: 'Checked in',
          reason: CHECK_IN_MESSAGES[code],
        });
      },
    );

    it('is not a check-in problem for a pass, an ordinary failure or a non-verdict body', () => {
      expect(onlyCheckInFailed(verdictBody('pass'))).toBe(false);
      expect(onlyCheckInFailed(verdictBody('pending'))).toBe(false);
      expect(onlyCheckInFailed(verdictBody('failed'))).toBe(false);
      expect(onlyCheckInFailed(verdictBody('failed', { rejections: [] }))).toBe(false);
      expect(onlyCheckInFailed('{"error":"The game server took too long to respond"}')).toBe(false);
      expect(onlyCheckInFailed('not json')).toBe(false);
    });

    it('is not a check-in problem when another check failed without a rejection of its own', () => {
      const body = verdictBody('failed', {
        checks: [
          { check: 'checked_in', outcome: 'failed', confidence: 1, reason: 'Ran out.' },
          { check: 'pose_correct', outcome: 'failed', confidence: 0.9, reason: 'Pose.' },
        ],
        rejections: [{ code: 'check_in_expired', message: 'Ran out.' }],
      });

      expect(onlyCheckInFailed(body)).toBe(false);
    });

    it.each([
      ['session_stopped', 'ended'],
      ['session_not_started', 'lobby'],
      ['hunt_finished', 'finished'],
      ['checkpoint_closed', 'clue'],
    ])('routes a refused check-in by its code: %s → %s', (code, screen) => {
      const { error } = checkpointAfterCheckIn(sending, 409, { detail: '…', code });

      expect(error?.screen).toBe(screen);
      expect(error?.reload).toBe(true);
    });

    it('stays on Review with the photo when the check-in is refused without moving on', () => {
      const plain = checkpointAfterCheckIn(sending, 409, { detail: 'not your current checkpoint' });
      expect(screenFor(app(plain.checkpoint))).toBe('review');
      expect(plain.checkpoint?.message).toContain("Couldn't check in");

      const moved = checkpointAfterCheckIn(sending, 409, { detail: '…', code: 'not_current_checkpoint' });
      expect(moved.error).toMatchObject({ screen: null, reload: true });
      expect(screenFor(app(moved.checkpoint))).toBe('review');
      expect(moved.checkpoint?.message).toBe(CHECK_IN_RAN_OUT);
    });

    it('keeps the photo with no connection, for Send to check in again', () => {
      const { checkpoint, error } = checkpointAfterCheckIn(sending, 0, null);

      expect(error?.offline).toBe(true);
      expect(checkpoint).toMatchObject({ step: 'photo', code: issued, message: CHECK_IN_RAN_OUT });
    });
  });

  describe('a 404 from POST /challenge', () => {
    it('goes back to Join and forgets the identity, like /state', () => {
      const error = challengeErrorFor(404, '{"detail":"unknown participant"}');

      expect(error).toEqual(screenForError(404, { detail: 'unknown participant' }));
      expect(error?.screen).toBe('join');
      expect(error?.forgetIdentity).toBe(true);
    });

    it('leaves verdicts and failed sends to checkpointAfterVerdict', () => {
      expect(challengeErrorFor(200, verdictBody('failed'))).toBeNull();
      expect(challengeErrorFor(202, verdictBody('pending'))).toBeNull();
      expect(challengeErrorFor(504, '{"error":"The game server took too long to respond"}')).toBeNull();
      expect(challengeErrorFor(0, '')).toBeNull();
    });
  });

  describe('code expiry', () => {
    const capture = { step: 'code' as const, sequence: 2, code: issued };
    const expires = Date.parse(issued.expiresAt);

    it('has not expired before expires-at', () => {
      expect(codeExpired(capture, expires - 1)).toBe(false);
      expect(codeTimeLeft(capture, expires - (9 * 60_000 + 41_000))).toBe('9:41 left');
    });

    it('has expired at and after expires-at', () => {
      expect(codeExpired(capture, expires)).toBe(true);
      expect(codeExpired(capture, expires + 5_000)).toBe(true);
      expect(codeTimeLeft(capture, expires + 5_000)).toBe('0:00 left');
    });

    it('never expires without a known expiry', () => {
      expect(codeExpired({ step: 'code', sequence: 2 }, expires)).toBe(false);
      expect(codeTimeLeft({ step: 'code', sequence: 2 }, expires)).toBe('');
    });
  });

  describe('clue row and polling', () => {
    it('shows the clue in the status bar once past the Clue screen', () => {
      expect(clueLineFor(app({ step: 'photo', sequence: 2 })).hidden).toBe(false);
      expect(clueLineFor(app(null)).hidden).toBe(true);
    });

    it.each([
      ['lobby', 10_000],
      ['clue', 10_000],
      ['capture', 30_000],
      ['review', 30_000],
      ['checking', 0],
      ['verdict', 0],
      ['join', 0],
    ] as const)('polls %s every %i ms', (screen, ms) => {
      expect(pollIntervalFor(screen)).toBe(ms);
    });
  });
});

describe('finished, session over and errors (issue #43)', () => {
  describe('screenForError maps every code to its screen', () => {
    it.each([
      ['session_not_started', 'lobby', "The session hasn't started yet."],
      ['session_stopped', 'ended', 'This session is over.'],
      ['hunt_finished', 'finished', ''],
      ['not_current_checkpoint', null, ''],
      ['checkpoint_closed', 'clue', "This checkpoint isn't open yet. Check back soon."],
    ])('%s → %s', (code, screen, message) => {
      const result = screenForError(409, { detail: 'whatever the server says', code });

      expect(result.screen).toBe(screen);
      expect(result.message).toBe(message);
      expect(result.reload).toBe(true);
      expect(result.forgetIdentity).toBe(false);
    });

    it('branches on code, not detail', () => {
      expect(screenForError(409, { detail: 'session has ended', code: 'not_current_checkpoint' }).screen).toBeNull();
    });

    it('says "This session is over" on Join', () => {
      expect(screenForError(409, { detail: 'session has ended', code: 'session_stopped' }).message).toBe(
        'This session is over.',
      );
    });

    it('marks a call that never came back as offline', () => {
      expect(screenForError(0, null).offline).toBe(true);
      expect(screenForError(409, { code: 'session_stopped' }).offline).toBe(false);
    });
  });

  describe('checkpointAfterArrive uses the same mapping', () => {
    it.each([
      ['session_not_started', 'lobby'],
      ['session_stopped', 'ended'],
      ['hunt_finished', 'finished'],
      ['not_current_checkpoint', null],
      ['checkpoint_closed', 'clue'],
    ])('%s → %s', (code, screen) => {
      const { error } = checkpointAfterArrive(null, 2, 409, { detail: '…', code });
      expect(error?.screen).toBe(screen);
      expect(error?.reload).toBe(true);
    });
  });

  describe('stateAfterError', () => {
    const outcomeFor = (code: string) => screenForError(409, { code });
    const app = (state: Record<string, unknown>) => ({ identity, permissions: 'granted' as const, state: state as never });

    it.each([
      ['session_not_started', 'lobby'],
      ['session_stopped', 'ended'],
      ['hunt_finished', 'finished'],
      ['checkpoint_closed', 'clue'],
    ])('moves straight to the right screen for %s', (code, screen) => {
      const state = stateAfterError(playing, outcomeFor(code));
      expect(screenFor(app(state as never))).toBe(screen);
    });

    it('disables "I\'m here" for checkpoint_closed', () => {
      expect(stateAfterError(playing, outcomeFor('checkpoint_closed'))?.current?.open).toBe(false);
    });

    it('leaves the state alone for not_current_checkpoint (the reload sorts it out)', () => {
      expect(stateAfterError(playing, outcomeFor('not_current_checkpoint'))).toBe(playing);
    });

    it('does nothing without a state', () => {
      expect(stateAfterError(null, outcomeFor('session_stopped'))).toBeNull();
    });
  });

  describe('sessionRejectionFor', () => {
    function photoVerdict(rejections: Array<{ code: string; message: string }>, verdict = 'failed') {
      return JSON.stringify({
        verdict: {
          game: 'hunt-1',
          participant: identity.participant,
          checkpoint: {
            sequence: 2,
            attempt: 1,
            time: '2026-10-03T13:05:02Z',
            verdict,
            checks: [{ check: 'session_running', outcome: 'failed', confidence: 1, reason: 'Session over.' }],
            rejections,
          },
        },
        image_id: 'img-1',
      });
    }

    it.each([
      ['session_stopped', 'The session is over. This photo was recorded but doesn\'t count.', 'ended'],
      ['session_not_started', "The session hasn't started yet.", 'lobby'],
    ])('treats a %s rejection like the 409, not as "Not quite"', (code, message, screen) => {
      // window_open usually fails too; the session code wins.
      const body = photoVerdict([
        { code: 'outside_window', message: 'Outside the window.' },
        { code, message },
      ]);

      expect(sessionRejectionFor(body)?.screen).toBe(screen);
    });

    it('is routed the same way by challengeErrorFor', () => {
      const body = photoVerdict([{ code: 'session_stopped', message: 'Over.' }]);
      expect(challengeErrorFor(200, body)).toEqual(sessionRejectionFor(body));
    });

    it('is null for an ordinary failed verdict, a pass and a non-verdict body', () => {
      expect(sessionRejectionFor(photoVerdict([{ code: 'pose_mismatch', message: 'Pose.' }]))).toBeNull();
      expect(sessionRejectionFor(photoVerdict([], 'pass'))).toBeNull();
      expect(sessionRejectionFor('{"error":"took too long"}')).toBeNull();
      expect(sessionRejectionFor('not json')).toBeNull();
    });
  });

  describe('polling', () => {
    it('polls Finished every 10 s', () => {
      expect(pollIntervalFor('finished')).toBe(10_000);
    });

    it('polls Session over only until the result is final', () => {
      expect(pollIntervalFor('ended', { status: 'ended', score: { points: 6, final: false } })).toBe(10_000);
      expect(pollIntervalFor('ended', { status: 'ended', score: { points: 6, final: true, place: 2 } })).toBe(0);
      expect(pollIntervalFor('ended', { status: 'ended' })).toBe(0);
    });
  });

  describe('finishedSummary', () => {
    it('says how many checkpoints, the points, and to wait', () => {
      const summary = finishedSummary({
        status: 'finished',
        progress: { completed: 3, total: 3 },
        current: null,
        score: { points: 6, 'in-review': 0, final: false, place: null },
      });

      expect(summary.title).toBe('All 3 checkpoints done');
      expect(summary.lines).toEqual([
        'Points so far: 6 pts. Lowest wins.',
        'Wait for the moderator to finish the session. This screen moves on by itself.',
      ]);
    });

    it('mentions a photo still in review', () => {
      const summary = finishedSummary({ status: 'finished', progress: { completed: 3, total: 3 }, score: { points: 9, 'in-review': 1 } });
      expect(summary.lines).toContain('A photo is still in review, which may lower your points once accepted.');
    });

    it('works without a score (an older game-server)', () => {
      expect(finishedSummary({ status: 'finished', progress: { completed: 3, total: 3 } }).lines).toEqual([
        'Wait for the moderator to finish the session. This screen moves on by itself.',
      ]);
    });
  });

  describe('sessionOverSummary', () => {
    const stoppedAt = '2026-10-03T11:47:00Z';

    it('says when the moderator finished, the final points and the place', () => {
      const summary = sessionOverSummary({
        status: 'ended',
        session: { phase: 'stopped', 'stopped-at': stoppedAt },
        score: { points: 6, 'in-review': 0, final: true, place: 2 },
      });

      expect(summary.title).toBe('The session is over');
      expect(summary.lines).toEqual([
        `The moderator finished the session at ${formatPlannedTime(stoppedAt)}.`,
        'Final score: 6 points.',
        'Your team came 2nd. Lowest wins.',
      ]);
    });

    it('says the result is on its way before it is final', () => {
      const summary = sessionOverSummary({ status: 'ended', score: { points: 6, final: false } });
      expect(summary.lines).toContain('Score: 6 points. The final result is on its way.');
    });

    it("works with today's game-server (no clock, no score)", () => {
      expect(sessionOverSummary({ status: 'ended' }).lines).toEqual(['The moderator finished the session.']);
    });
  });
});
