import { describe, expect, it } from 'vitest';
import {
  describeAccuracyHint,
  describeProximityWarning,
  describeVerdict,
  readIdentityFromQuery,
} from '../src/public/challenge-logic.js';

const VALID_SESSION = '11111111-1111-4111-8111-111111111111';
const VALID_PARTICIPANT = '22222222-2222-4222-8222-222222222222';

describe('readIdentityFromQuery', () => {
  it('parses a valid session/participant/checkpoint', () => {
    const params = new URLSearchParams(
      `session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}&checkpoint=2`,
    );

    expect(readIdentityFromQuery(params)).toEqual({
      session: VALID_SESSION,
      participant: VALID_PARTICIPANT,
      checkpoint: 2,
    });
  });

  it.each([
    ['missing session', `participant=${VALID_PARTICIPANT}&checkpoint=2`],
    ['invalid session', `session=nope&participant=${VALID_PARTICIPANT}&checkpoint=2`],
    ['missing participant', `session=${VALID_SESSION}&checkpoint=2`],
    ['invalid participant', `session=${VALID_SESSION}&participant=nope&checkpoint=2`],
    ['missing checkpoint', `session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}`],
    [
      'non-integer checkpoint',
      `session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}&checkpoint=1.5`,
    ],
    ['checkpoint below 1', `session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}&checkpoint=0`],
    [
      'non-numeric checkpoint',
      `session=${VALID_SESSION}&participant=${VALID_PARTICIPANT}&checkpoint=two`,
    ],
  ])('returns null for %s', (_label, query) => {
    expect(readIdentityFromQuery(new URLSearchParams(query))).toBeNull();
  });
});

describe('describeVerdict', () => {
  it('describes a 202 pending verdict with an attempt number', () => {
    const result = describeVerdict(202, JSON.stringify({ attempt: 3 }));

    expect(result.forceRetake).toBe(false);
    expect(result.message).toBe('Checks passed, waiting for the referee. (Attempt 3)');
  });

  it('describes a 202 pending verdict with no attempt field', () => {
    const result = describeVerdict(202, JSON.stringify({}));

    expect(result).toEqual({
      message: 'Checks passed, waiting for the referee.',
      forceRetake: false,
    });
  });

  it('never claims success for a 202 — it only reports "pending"', () => {
    const result = describeVerdict(202, JSON.stringify({ attempt: 1 }));

    expect(result.message.toLowerCase()).not.toContain('passed the challenge');
    expect(result.message.toLowerCase()).not.toContain('you passed');
  });

  it('describes a 200 failed verdict, rendering every rejection message', () => {
    const body = JSON.stringify({
      attempt: 2,
      rejections: [{ message: 'Too far from the checkpoint' }, { message: 'Submitted too late' }],
    });

    const result = describeVerdict(200, body);

    expect(result.forceRetake).toBe(true);
    expect(result.message).toContain('Too far from the checkpoint');
    expect(result.message).toContain('Submitted too late');
    expect(result.message).toContain('Attempt 2');
  });

  it('falls back to a generic message when a 200 has no rejections', () => {
    const result = describeVerdict(200, JSON.stringify({}));

    expect(result).toEqual({ message: 'Submission was rejected.', forceRetake: true });
  });

  it('ignores malformed rejection entries rather than throwing', () => {
    const body = JSON.stringify({ rejections: [null, { message: 42 }, { message: 'ok' }] });

    const result = describeVerdict(200, body);

    expect(result.message).toBe('ok');
  });

  it('describes a 404 with a fixed message regardless of body content', () => {
    const result = describeVerdict(404, JSON.stringify({ error: 'nope' }));

    expect(result).toEqual({
      message: 'Unknown game or checkpoint, check your link',
      forceRetake: false,
    });
  });

  it('falls back to a generic error for other statuses', () => {
    const result = describeVerdict(500, 'boom');

    expect(result.forceRetake).toBe(false);
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
