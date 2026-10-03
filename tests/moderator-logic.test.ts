import { describe, expect, it } from 'vitest';
import { formatPlannedTime } from '../src/public/game-logic.js';
import {
  actionsFor,
  agoWords,
  blockedLine,
  CONFIRM_FINISH,
  CONFIRM_START,
  lastCompletedLine,
  moderatorError,
  newestBlocked,
  overviewClockOffset,
  phaseBadge,
  phaseOf,
  readSessionId,
  teamRow,
} from '../src/public/moderator-logic.js';

const SESSION = 'aeffe667-4f9f-4108-b5e2-56ae821fe413';
const plannedStart = '2026-10-03T09:00:00Z';
const plannedEnd = '2026-10-03T12:00:00Z';
const endMs = Date.parse(plannedEnd);

const scheduled = {
  phase: 'scheduled',
  'planned-start': plannedStart,
  'planned-end': plannedEnd,
  'started-at': null,
  'stopped-at': null,
  'server-time': '2026-10-03T08:55:00Z',
};
const running = { ...scheduled, phase: 'running', 'started-at': '2026-10-03T09:03:00Z' };
const stopped = { ...running, phase: 'stopped', 'stopped-at': '2026-10-03T11:47:00Z' };

const t = (iso: string) => formatPlannedTime(iso);

describe('readSessionId', () => {
  it('reads a valid session id from the link', () => {
    expect(readSessionId(new URLSearchParams(`session=${SESSION}`))).toBe(SESSION);
  });

  it.each(['', 'session=', 'session=not-a-uuid'])('is null for %j', (query) => {
    expect(readSessionId(new URLSearchParams(query))).toBeNull();
  });
});

describe('phaseBadge and actionsFor, per phase', () => {
  it('not started: badge, times, and only Start', () => {
    expect(phaseBadge(scheduled, endMs - 4 * 3_600_000)).toEqual({
      label: 'Not started',
      tone: 'idle',
      countdown: '',
      times: `Planned ${t(plannedStart)}–${t(plannedEnd)}`,
    });
    expect(actionsFor(scheduled)).toEqual({ start: true, finish: false });
  });

  it('running: badge with the countdown to the planned end, and only Finish', () => {
    expect(phaseBadge(running, endMs - (3_600_000 + 12 * 60_000 + 40_000))).toEqual({
      label: 'Running',
      tone: 'running',
      countdown: '1:12:40 to planned end',
      times: `Planned ${t(plannedStart)}–${t(plannedEnd)}, started ${t(running['started-at'])}`,
    });
    expect(actionsFor(running)).toEqual({ start: false, finish: true });
  });

  it('running past the planned end: says so, as a reminder to finish', () => {
    const badge = phaseBadge(running, endMs + 60_000);

    expect(badge.label).toBe('Running, past planned end');
    expect(badge.tone).toBe('late');
    expect(badge.countdown).toBe('');
    expect(actionsFor(running).finish).toBe(true);
  });

  it('finished: badge with the finish time, and no buttons', () => {
    expect(phaseBadge(stopped, endMs)).toEqual({
      label: 'Finished',
      tone: 'finished',
      countdown: '',
      times: `Planned ${t(plannedStart)}–${t(plannedEnd)}, started ${t(running['started-at'])}, finished ${t(stopped['stopped-at'])}`,
    });
    expect(actionsFor(stopped)).toEqual({ start: false, finish: false });
  });

  it('an unknown or missing phase offers nothing', () => {
    expect(phaseOf(undefined)).toBe('unknown');
    expect(phaseBadge({ phase: 'paused' }, endMs).label).toBe('Unknown');
    expect(actionsFor(null)).toEqual({ start: false, finish: false });
  });

  it('has the confirmation texts from the issue', () => {
    expect(CONFIRM_START).toBe('Teams can check in and send photos from now.');
    expect(CONFIRM_FINISH).toBe("Teams can't check in or send photos after this. This can't be undone.");
  });
});

describe('agoWords', () => {
  const at = '2026-10-03T10:00:00Z';
  const atMs = Date.parse(at);

  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [60_000, '1 min ago'],
    [14 * 60_000 + 30_000, '14 min ago'],
    [59 * 60_000, '59 min ago'],
    [60 * 60_000, '1 h ago'],
    [65 * 60_000, '1 h 5 min ago'],
    [-30_000, 'just now'],
  ])('%i ms later → %s', (elapsed, words) => {
    expect(agoWords(at, atMs + elapsed)).toBe(words);
  });

  it('is empty for a missing time', () => {
    expect(agoWords(null, atMs)).toBe('');
  });
});

describe('lastCompletedLine', () => {
  const now = Date.parse('2026-10-03T10:12:10Z');
  const team = {
    team: 'Red Foxes',
    joined: true,
    completed: 1,
    total: 3,
    points: 7,
    'in-review': 0,
    place: null,
    'last-completed': { sequence: 1, name: 'Stone fountain', verdict: 'pass', at: '2026-10-03T09:58:10Z' },
    current: { sequence: 2, name: 'Boy who never grew up' },
  };

  it('says which checkpoint was approved and how long ago', () => {
    expect(lastCompletedLine(team, now)).toBe('Last #1 Stone fountain, approved 14 min ago');
  });

  it('says a pending photo is in review, with when it was sent', () => {
    const pending = { ...team, 'last-completed': { ...team['last-completed'], verdict: 'pending' } };
    expect(lastCompletedLine(pending, now)).toBe('Last #1 Stone fountain, sent 14 min ago, in review');
  });

  it('says when nothing is completed yet', () => {
    expect(lastCompletedLine({ ...team, completed: 0, 'last-completed': null }, now)).toBe('Nothing completed yet');
  });

  it('says when a team has not joined', () => {
    expect(lastCompletedLine({ ...team, joined: false, 'last-completed': null }, now)).toBe('Not joined yet');
  });
});

describe('teamRow', () => {
  const joined = {
    team: 'Red Foxes',
    joined: true,
    completed: 1,
    total: 3,
    points: 7,
    'in-review': 1,
    place: 1,
    'last-completed': null,
    current: { sequence: 2, name: 'Boy who never grew up' },
  };

  it('shows a joined team, without a place until the result is final', () => {
    expect(teamRow(joined, false)).toEqual({
      name: 'Red Foxes',
      joined: 'joined',
      progress: '1 of 3',
      points: '7 pts',
      inReview: '1 in review',
      place: '',
      current: 'On #2 Boy who never grew up',
    });
  });

  it('shows the place once final', () => {
    expect(teamRow(joined, true).place).toBe('1st');
  });

  it('shows a team that has not joined, with no score', () => {
    const notJoined = {
      ...joined,
      joined: false,
      completed: null,
      total: null,
      points: null,
      'in-review': null,
      place: null,
      current: null,
    };
    expect(teamRow(notJoined, true)).toEqual({
      name: 'Red Foxes',
      joined: 'not joined',
      progress: '',
      points: '',
      inReview: '',
      place: '',
      current: '',
    });
  });
});

describe('blocked attempts', () => {
  it.each([
    ['join', 'session_stopped', 'Blue Herons tried to join (finished)'],
    ['arrive', 'session_not_started', 'Blue Herons tried to check in (not started)'],
    ['photo', 'session_stopped', 'Blue Herons sent a photo (finished)'],
  ])('%s / %s → %s', (action, code, text) => {
    const at = '2026-10-03T13:05:02Z';
    expect(blockedLine({ at, team: 'Blue Herons', action, code })).toEqual({ time: t(at), text });
  });

  it('lists newest first, at most 50', () => {
    const attempts = Array.from({ length: 60 }, (_, i) => ({
      at: new Date(Date.parse('2026-10-03T13:00:00Z') + i * 1000).toISOString(),
      team: `Team ${i}`,
      action: 'photo',
      code: 'session_stopped',
    }));

    const listed = newestBlocked(attempts);

    expect(listed).toHaveLength(50);
    expect(listed[0]?.team).toBe('Team 59');
    expect(listed[49]?.team).toBe('Team 10');
  });

  it('is empty for a missing list', () => {
    expect(newestBlocked(undefined)).toEqual([]);
  });
});

describe('moderatorError', () => {
  it('asks for the code again on a 401', () => {
    expect(moderatorError(401, { detail: 'moderator code required', code: 'moderator_unauthorised' })).toEqual({
      message: "That code isn't right for this session.",
      askForCode: true,
      offline: false,
    });
  });

  it.each([
    [404, { detail: 'not found' }, 'No session with this id. Check the link.'],
    [409, { detail: 'session has ended', code: 'session_stopped' }, 'The session has already finished.'],
    [409, { detail: "session hasn't started", code: 'session_not_started' }, "The session hasn't been started yet."],
    [400, { error: 'session must be a valid UUID' }, 'The link has no valid session id.'],
    [500, null, 'Something went wrong (error 500).'],
  ])('%i → %s', (status, body, message) => {
    expect(moderatorError(status, body)).toEqual({ message, askForCode: false, offline: false });
  });

  it.each([0, 502, 503, 504])('treats %i as a lost connection', (status) => {
    expect(moderatorError(status, null).offline).toBe(true);
  });
});

describe('overviewClockOffset', () => {
  it("follows the overview's server time", () => {
    const receivedAt = Date.parse('2026-10-03T08:54:58Z');
    expect(overviewClockOffset({ session: scheduled, teams: [], blocked: [] }, receivedAt)).toBe(2_000);
  });
});
