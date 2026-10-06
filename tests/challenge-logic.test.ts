import { describe, expect, it } from 'vitest';
import {
  buildVideoConstraints,
  DEFAULT_FACING_MODE,
  describeAccuracyHint,
  describeChallenge,
  describeProximityWarning,
  describeVerdict,
  hasMultipleCameras,
  isValidUuid,
  readCheckpointFromQuery,
  readFacingMode,
} from '../src/public/challenge-logic.js';

const VALID_SESSION = '11111111-1111-4111-8111-111111111111';

describe('isValidUuid', () => {
  it('accepts a well-formed UUID', () => {
    expect(isValidUuid(VALID_SESSION)).toBe(true);
  });

  it.each(['', 'not-a-uuid', '11111111-1111-1111-1111', VALID_SESSION.toUpperCase()])(
    'handles %s',
    (value) => {
      // Case is accepted (UUIDs aren't case-sensitive); everything else isn't.
      expect(isValidUuid(value)).toBe(value === VALID_SESSION.toUpperCase());
    },
  );
});

describe('readCheckpointFromQuery', () => {
  it('parses a valid checkpoint', () => {
    expect(readCheckpointFromQuery(new URLSearchParams('checkpoint=2'))).toBe(2);
  });

  it.each([
    ['missing', ''],
    ['non-integer', 'checkpoint=1.5'],
    ['below 1', 'checkpoint=0'],
    ['non-numeric', 'checkpoint=two'],
  ])('returns null when %s', (_label, query) => {
    expect(readCheckpointFromQuery(new URLSearchParams(query))).toBeNull();
  });
});

const VALID_PARTICIPANT = '22222222-2222-4222-8222-222222222222';

/**
 * Builds a real verdict response body: `{ verdict: { checkpoint: {...} } }`,
 * matching the shape the game-server actually returns (see issue #21) —
 * not the flat `{ attempt, rejections }` shape describeVerdict used to
 * (wrongly) read from the top level.
 */
function verdictBody(checkpoint: Record<string, unknown>): string {
  return JSON.stringify({
    verdict: { game: 'hunt-1', participant: VALID_PARTICIPANT, checkpoint: { time: '2026-10-03T10:00:00Z', ...checkpoint } },
    image_id: 'img-1',
  });
}

describe('describeVerdict', () => {
  it('describes a pass, with success styling and the attempt number', () => {
    const body = verdictBody({
      sequence: 2,
      attempt: 3,
      verdict: 'pass',
      checks: [{ check: 'window_open', outcome: 'passed', confidence: 1, reason: 'On time.' }],
      rejections: [],
    });

    const result = describeVerdict(200, body);

    expect(result.message).toBe('Checkpoint passed! (Attempt 3)');
    expect(result.variant).toBe('pass');
    expect(result.hideSubmit).toBe(true);
    expect(result.hideRetake).toBe(true);
    expect(result.checklist).toEqual([{ icon: '✓', label: 'Checkpoint open', reason: 'On time.' }]);
  });

  it('describes a failed verdict, rendering every rejection message from verdict.checkpoint.rejections', () => {
    // Regression test for the shape bug: this used to read body.rejections
    // (top level, always undefined) instead of verdict.checkpoint.rejections,
    // so players always saw "Submission was rejected." with no reason.
    const body = verdictBody({
      sequence: 2,
      attempt: 2,
      verdict: 'failed',
      checks: [{ check: 'window_open', outcome: 'failed', confidence: 1, reason: 'Too late.' }],
      rejections: [
        { code: 'outside_window', message: 'Submitted after the checkpoint window closed.' },
        { code: 'too_far', message: 'You were too far from the checkpoint.' },
      ],
    });

    const result = describeVerdict(200, body);

    expect(result.message).toContain('Submitted after the checkpoint window closed.');
    expect(result.message).toContain('You were too far from the checkpoint.');
    expect(result.message).toContain('Attempt 2');
    expect(result.variant).toBe('failed');
    expect(result.hideSubmit).toBe(true);
    expect(result.hideRetake).toBe(false);
  });

  it('describes a pending verdict, with an uncertain check in the checklist', () => {
    const body = verdictBody({
      sequence: 3,
      attempt: 1,
      verdict: 'pending',
      checks: [
        { check: 'window_open', outcome: 'passed', confidence: 1, reason: 'On time.' },
        { check: 'scene_matches', outcome: 'uncertain', confidence: 0.4, reason: 'Could not confidently match the scene.' },
      ],
      rejections: [],
    });

    const result = describeVerdict(202, body);

    expect(result.message).toBe('Your photo is with the moderator for review. (Attempt 1)');
    expect(result.message.toLowerCase()).not.toContain('waiting for the referee');
    expect(result.variant).toBe('pending');
    expect(result.hideSubmit).toBe(false);
    expect(result.hideRetake).toBe(false);
    expect(result.checklist).toContainEqual({
      icon: '?',
      label: 'Right place',
      reason: 'Could not confidently match the scene.',
    });
  });

  it('handles a verdict with no checks at all (an older server)', () => {
    const body = verdictBody({
      sequence: 1,
      attempt: 1,
      verdict: 'failed',
      rejections: [{ code: 'outside_window', message: 'Too late.' }],
    });

    const result = describeVerdict(200, body);

    expect(result.message).toContain('Too late.');
    expect(result.checklist).toEqual([]);
  });

  it('never claims success for a pending verdict', () => {
    const body = verdictBody({ sequence: 1, attempt: 1, verdict: 'pending', checks: [], rejections: [] });

    const result = describeVerdict(202, body);

    expect(result.message.toLowerCase()).not.toContain('passed');
  });

  describe('checklist rendering', () => {
    it('hides skipped checks and falls back to the raw name for an unknown check', () => {
      const body = verdictBody({
        sequence: 1,
        attempt: 1,
        verdict: 'pending',
        checks: [
          { check: 'photo_unique', outcome: 'skipped', confidence: 0, reason: 'Not checked this attempt.' },
          { check: 'some_new_check', outcome: 'passed', confidence: 1, reason: 'Looks fine.' },
        ],
        rejections: [],
      });

      const result = describeVerdict(202, body);

      expect(result.checklist).toEqual([{ icon: '✓', label: 'some_new_check', reason: 'Looks fine.' }]);
    });

    it('maps every documented check name to its friendly label', () => {
      const names = [
        ['window_open', 'Checkpoint open'],
        ['capture_fresh', 'Photo is recent'],
        ['capture_time_plausible', 'Photo time'],
        ['in_range', 'Location'],
        ['photo_unique', 'New photo'],
        ['scene_matches', 'Right place'],
        ['pose_correct', 'Right pose'],
        ['session_running', 'Session running'],
        ['checked_in', 'Checked in'],
      ] as const;

      const body = verdictBody({
        sequence: 1,
        attempt: 1,
        verdict: 'pending',
        checks: names.map(([name]) => ({ check: name, outcome: 'passed', confidence: 1, reason: 'ok' })),
        rejections: [],
      });

      const result = describeVerdict(202, body);

      expect(result.checklist.map((item) => item.label)).toEqual(names.map(([, label]) => label));
    });
  });

  it('labels every check in a real POST /challenge response body', () => {
    // Verbatim shape of a game-server response: each check's name is in
    // `check`, not `name` — reading `name` labelled every row "Check".
    const body = JSON.stringify({
      verdict: {
        game: 'hunt-1',
        participant: VALID_PARTICIPANT,
        checkpoint: {
          sequence: 1,
          attempt: 1,
          time: '2026-10-03T10:00:00Z',
          verdict: 'pass',
          checks: [
            { check: 'window_open', outcome: 'passed', confidence: 1.0, reason: 'The checkpoint is open.' },
            { check: 'capture_fresh', outcome: 'passed', confidence: 1.0, reason: 'Photo taken just now.' },
            { check: 'capture_time_plausible', outcome: 'passed', confidence: 1.0, reason: 'Photo time is plausible.' },
            { check: 'in_range', outcome: 'passed', confidence: 1.0, reason: "Within the checkpoint's area." },
            { check: 'photo_unique', outcome: 'passed', confidence: 1.0, reason: 'Not seen before.' },
            { check: 'scene_matches', outcome: 'passed', confidence: 0.9, reason: 'Scene matches.' },
            { check: 'pose_correct', outcome: 'passed', confidence: 0.9, reason: 'Pose matches.' },
          ],
          rejections: [],
        },
      },
      image_id: 'img-1',
    });

    const result = describeVerdict(200, body);

    expect(result.checklist.map((item) => item.label)).toEqual([
      'Checkpoint open',
      'Photo is recent',
      'Photo time',
      'Location',
      'New photo',
      'Right place',
      'Right pose',
    ]);
    expect(result.checklist).toContainEqual({ icon: '✓', label: 'Location', reason: "Within the checkpoint's area." });
  });

  it('still reads a check named in `name` (an older body)', () => {
    const body = verdictBody({
      sequence: 1,
      attempt: 1,
      verdict: 'pass',
      checks: [{ name: 'in_range', outcome: 'passed', confidence: 1, reason: 'ok' }],
      rejections: [],
    });

    expect(describeVerdict(200, body).checklist.map((item) => item.label)).toEqual(['Location']);
  });

  it('describes a 504 with a clear "took too long" message', () => {
    const result = describeVerdict(504, JSON.stringify({ error: 'The game server took too long to respond' }));

    expect(result.message).toBe('The referee took too long. Please try again.');
    expect(result.variant).toBe('error');
  });

  it('describes a 404 with a fixed message regardless of body content', () => {
    const result = describeVerdict(404, JSON.stringify({ error: 'nope' }));

    expect(result.message).toBe('Unknown game or checkpoint, check your link');
    expect(result.variant).toBe('error');
    expect(result.hideSubmit).toBe(false);
    expect(result.hideRetake).toBe(false);
  });

  it('falls back to a generic error for other statuses', () => {
    const result = describeVerdict(500, 'boom');

    expect(result.variant).toBe('error');
    expect(result.message).toBe('Error 500: boom');
  });

  it('handles a malformed JSON body without throwing', () => {
    expect(() => describeVerdict(202, 'not json')).not.toThrow();
    expect(() => describeVerdict(200, 'not json')).not.toThrow();
  });
});

describe('describeAccuracyHint', () => {
  it('returns nothing at or below 50m', () => {
    expect(describeAccuracyHint(50)).toBe('');
    expect(describeAccuracyHint(10)).toBe('');
  });

  it('warns above 50m, rounding the value', () => {
    expect(describeAccuracyHint(51)).toBe(
      'Your location fix is imprecise (±51 m); try moving into the open.',
    );
    expect(describeAccuracyHint(123.6)).toContain('±124 m');
  });

  it('returns nothing for a non-finite accuracy', () => {
    expect(describeAccuracyHint(Number.NaN)).toBe('');
    expect(describeAccuracyHint(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('describeProximityWarning', () => {
  it('warns when in_range is false', () => {
    expect(describeProximityWarning(200, { in_range: false })).toBe(
      'You may be outside the checkpoint area. You can still submit.',
    );
  });

  it('says nothing when in_range is true', () => {
    expect(describeProximityWarning(200, { in_range: true })).toBe('');
  });

  it.each([429, 404, 500, 502])('says nothing for a %i response', (status) => {
    expect(describeProximityWarning(status, { in_range: false })).toBe('');
  });

  it('says nothing when the body is missing, null or malformed', () => {
    expect(describeProximityWarning(200, null)).toBe('');
    expect(describeProximityWarning(200, undefined)).toBe('');
    expect(describeProximityWarning(200, {})).toBe('');
    expect(describeProximityWarning(200, 'not an object')).toBe('');
  });

  it('never mentions coordinates, distance or a radius', () => {
    const result = describeProximityWarning(200, { in_range: false });

    for (const forbidden of ['lat', 'lon', 'distance', 'radius', 'meter']) {
      expect(result.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('describeChallenge', () => {
  it('returns the pose text for a 200 with a pose', () => {
    expect(describeChallenge(200, { pose: 'Stand next to the red door' })).toBe(
      'Stand next to the red door',
    );
  });

  it('returns null (hide) when pose is null', () => {
    expect(describeChallenge(200, { pose: null })).toBeNull();
  });

  it('returns null (hide) for a 404', () => {
    expect(describeChallenge(404, { pose: 'irrelevant' })).toBeNull();
  });

  it('returns null (hide) for a non-JSON body', () => {
    // The caller passes null when JSON.parse fails — see describeProximityWarning.
    expect(describeChallenge(200, null)).toBeNull();
  });

  it('returns null (hide) for a network failure', () => {
    // The caller represents "no response at all" as status 0.
    expect(describeChallenge(0, null)).toBeNull();
  });

  it('returns null (hide) when the pose field is missing, empty or the wrong type', () => {
    expect(describeChallenge(200, {})).toBeNull();
    expect(describeChallenge(200, { pose: '' })).toBeNull();
    expect(describeChallenge(200, { pose: 42 })).toBeNull();
  });

  it.each([429, 500, 502])('returns null (hide) for a %i response', (status) => {
    expect(describeChallenge(status, { pose: 'Stand next to the red door' })).toBeNull();
  });
});

describe('readFacingMode', () => {
  it('defaults to the rear camera', () => {
    expect(DEFAULT_FACING_MODE).toBe('environment');
  });

  it.each(['user', 'environment'])('keeps a valid choice (%s)', (mode) => {
    expect(readFacingMode(mode)).toBe(mode);
  });

  it.each([null, undefined, '', 'front', 'USER', 42])('falls back to the rear camera for %j', (value) => {
    expect(readFacingMode(value)).toBe('environment');
  });
});

describe('buildVideoConstraints', () => {
  it.each(['user', 'environment'] as const)('asks for the %s camera as a preference, not a requirement', (mode) => {
    expect(buildVideoConstraints(mode)).toEqual({ facingMode: { ideal: mode } });
  });
});

describe('hasMultipleCameras', () => {
  it('is true with two or more cameras', () => {
    expect(
      hasMultipleCameras([{ kind: 'videoinput' }, { kind: 'audioinput' }, { kind: 'videoinput' }]),
    ).toBe(true);
  });

  it('is false with a single camera, however many other devices', () => {
    expect(hasMultipleCameras([{ kind: 'videoinput' }, { kind: 'audioinput' }, { kind: 'audiooutput' }])).toBe(
      false,
    );
  });

  it('is false with no devices or a bad value', () => {
    expect(hasMultipleCameras([])).toBe(false);
    expect(hasMultipleCameras(null as unknown as [])).toBe(false);
  });
});
