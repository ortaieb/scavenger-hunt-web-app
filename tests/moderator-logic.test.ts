import { describe, expect, it } from 'vitest';
import { formatPlannedTime } from '../src/public/game-logic.js';
import {
  actionsFor,
  agoWords,
  allTeamsFinished,
  askedFor,
  blockedLine,
  checkpointLabel,
  CONFIRM_FINISH,
  CONFIRM_START,
  confirmFinishText,
  finishBanner,
  lastCompletedLine,
  moderatorError,
  newestBlocked,
  NOTE_MAX_LENGTH,
  otherChecksLine,
  overviewClockOffset,
  phaseBadge,
  phaseOf,
  photosWaiting,
  readSessionId,
  recentLine,
  recentNewestFirst,
  referencePositions,
  reviewChecks,
  reviewHeading,
  reviewItemHead,
  rulingBody,
  standingsNote,
  teamRow,
  toReviewOldestFirst,
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

// --- the review queue (issue #55) --------------------------------------------

const passed = (check: string) => ({ check, outcome: 'passed', confidence: 1, reason: '…', detail: '' });
const NON_VISUAL_CHECKS = [
  'session_running',
  'checked_in',
  'window_open',
  'capture_fresh',
  'capture_time_plausible',
  'in_range',
  'photo_unique',
].map(passed);

const reviewItem = {
  submission: 42,
  team: 'Red Foxes',
  checkpoint: { sequence: 2, name: 'Lion fountain' },
  attempt: 1,
  'received-at': '2026-10-03T10:41:05Z',
  pose: 'Arms raised as if flying, facing the camera',
  scene: "A stone fountain with a lion's head spout",
  'reference-photos': 2,
  checks: [
    ...NON_VISUAL_CHECKS,
    { check: 'scene_matches', outcome: 'passed', confidence: 0.93, reason: '…', detail: 'The lion spout is in frame.' },
    { check: 'pose_correct', outcome: 'uncertain', confidence: 0.62, reason: '…', detail: 'One arm raised, not both.' },
  ],
  referee: { status: 'ok', 'error-code': null },
};

const recentRuling = {
  submission: 40,
  team: 'Green Owls',
  checkpoint: { sequence: 1, name: 'Stone fountain' },
  ruling: 'approve',
  note: null,
  'ruled-at': '2026-10-03T10:39:12Z',
  verdict: 'pending',
};

describe('toReviewOldestFirst and recentNewestFirst', () => {
  it('lists the photos to review oldest first, so the longest wait comes first', () => {
    const review = {
      'to-review': [
        { ...reviewItem, submission: 44, 'received-at': '2026-10-03T10:45:00Z' },
        { ...reviewItem, submission: 42, 'received-at': '2026-10-03T10:41:05Z' },
        { ...reviewItem, submission: 43, 'received-at': '2026-10-03T10:41:05Z' },
      ],
      recent: [],
    };

    expect(toReviewOldestFirst(review).map((item) => item.submission)).toEqual([42, 43, 44]);
  });

  it('lists the latest rulings newest first', () => {
    const review = {
      'to-review': [],
      recent: [
        { ...recentRuling, submission: 38, 'ruled-at': '2026-10-03T10:20:00Z' },
        { ...recentRuling, submission: 40, 'ruled-at': '2026-10-03T10:39:12Z' },
      ],
    };

    expect(recentNewestFirst(review).map((item) => item.submission)).toEqual([40, 38]);
  });

  it.each([null, undefined, {}, { 'to-review': 'nope', recent: null }])('is empty for %j', (review) => {
    expect(toReviewOldestFirst(review as never)).toEqual([]);
    expect(recentNewestFirst(review as never)).toEqual([]);
  });

  it('skips entries without a submission id, which could not be ruled on', () => {
    const review = { 'to-review': [reviewItem, { ...reviewItem, submission: 'x' }, null], recent: [] };

    expect(toReviewOldestFirst(review as never)).toEqual([reviewItem]);
  });

  it('does not change the list it was given', () => {
    const list = [{ ...reviewItem, submission: 2, 'received-at': '2026-10-03T11:00:00Z' }, reviewItem];

    toReviewOldestFirst({ 'to-review': list, recent: [] });

    expect(list[0]?.submission).toBe(2);
  });
});

describe('photosWaiting and reviewHeading', () => {
  const overview = { session: running, 'to-review': 3, teams: [], blocked: [] };

  it('counts the queue on screen', () => {
    expect(photosWaiting(overview, { 'to-review': [reviewItem], recent: [] })).toBe(1);
  });

  it("falls back to the overview's count before the queue has loaded", () => {
    expect(photosWaiting(overview, null)).toBe(3);
  });

  it('is 0 with neither', () => {
    expect(photosWaiting(null, null)).toBe(0);
    expect(photosWaiting({ ...overview, 'to-review': undefined }, null)).toBe(0);
  });

  it('heads the section with the count', () => {
    expect(reviewHeading(2)).toBe('To review (2)');
  });
});

describe('a photo to review', () => {
  const now = Date.parse('2026-10-03T10:52:05Z');

  it('heads it with the team, the checkpoint, the attempt and how long ago it was sent', () => {
    expect(reviewItemHead(reviewItem, now)).toEqual({
      team: 'Red Foxes',
      checkpoint: '#2 Lion fountain',
      meta: 'Attempt 1 · sent 11 min ago',
    });
  });

  it('names a checkpoint no longer in the sessions file by its number', () => {
    expect(checkpointLabel({ sequence: 2, name: null })).toBe('#2');
    expect(checkpointLabel(null)).toBe('');
  });

  it('shows the pose asked for and the scene', () => {
    expect(askedFor(reviewItem)).toEqual({
      asked: 'Arms raised as if flying, facing the camera',
      place: "A stone fountain with a lion's head spout",
    });
  });

  it('says when no pose was issued or no scene is set', () => {
    expect(askedFor({ ...reviewItem, pose: null, scene: null })).toEqual({
      asked: 'No pose was asked for.',
      place: 'No scene is set for this checkpoint.',
    });
  });

  it.each([
    [2, [0, 1]],
    [0, []],
    [null, []],
    [25, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ])('fetches %j reference photos by position: %j', (count, positions) => {
    expect(referencePositions({ ...reviewItem, 'reference-photos': count as number })).toEqual(positions);
  });
});

describe('reviewChecks', () => {
  it("lists the referee's checks with outcome, confidence and its reasons, and counts the rest", () => {
    const { checks, otherPassed, referee } = reviewChecks(reviewItem);

    expect(checks).toEqual([
      { outcome: 'passed', text: 'Place: passed (confidence 93%)', detail: 'The lion spout is in frame.' },
      { outcome: 'uncertain', text: 'Pose: unsure (confidence 62%)', detail: 'One arm raised, not both.' },
    ]);
    expect(otherPassed).toBe(7);
    expect(otherChecksLine(otherPassed)).toBe('7 other checks passed.');
    expect(referee).toBe('');
  });

  it('lists any other check that did not pass', () => {
    const item = {
      ...reviewItem,
      checks: [{ check: 'in_range', outcome: 'uncertain', confidence: 0, reason: '…', detail: 'GPS accuracy low' }],
    };

    expect(reviewChecks(item).checks).toEqual([
      { outcome: 'uncertain', text: 'Location: unsure', detail: 'GPS accuracy low' },
    ]);
  });

  it('says why a skipped check was not checked, without a confidence', () => {
    const item = {
      ...reviewItem,
      checks: [{ check: 'pose_correct', outcome: 'skipped', confidence: 0, reason: '…', detail: 'referee disabled' }],
      referee: null,
    };

    expect(reviewChecks(item).checks).toEqual([
      { outcome: 'skipped', text: 'Pose: not checked', detail: 'referee disabled' },
    ]);
  });

  it.each([
    ['deadline', 'No reasons from the referee: it ran out of time (deadline). Judge from the photo.'],
    ['api_error', 'No reasons from the referee: the AI service failed (api_error). Judge from the photo.'],
    ['something_new', 'No reasons from the referee: it failed (something_new). Judge from the photo.'],
    [null, 'No reasons from the referee: it failed. Judge from the photo.'],
  ])('says so instead when the referee errored (%s)', (code, said) => {
    const item = {
      ...reviewItem,
      checks: [
        ...NON_VISUAL_CHECKS,
        { check: 'scene_matches', outcome: 'uncertain', confidence: 0, reason: '…', detail: 'referee error' },
        { check: 'pose_correct', outcome: 'uncertain', confidence: 0, reason: '…', detail: 'referee error' },
      ],
      referee: { status: 'error', 'error-code': code },
    };

    expect(reviewChecks(item)).toEqual({ checks: [], otherPassed: 7, referee: said });
  });

  it('copes with missing checks', () => {
    expect(reviewChecks({ ...reviewItem, checks: undefined as never })).toEqual({
      checks: [],
      otherPassed: 0,
      referee: '',
    });
    expect(otherChecksLine(0)).toBe('');
    expect(otherChecksLine(1)).toBe('1 other check passed.');
  });
});

describe('rulingBody', () => {
  it.each(['approve', 'reject'] as const)('posts the session, the submission and %s, with the note', (ruling) => {
    expect(rulingBody(SESSION, 42, ruling, '  Arm just cropped  ')).toEqual({
      session: SESSION,
      submission: 42,
      ruling,
      note: 'Arm just cropped',
    });
  });

  it('leaves an empty note out', () => {
    expect(rulingBody(SESSION, 42, 'approve', '   ')).toEqual({ session: SESSION, submission: 42, ruling: 'approve' });
  });

  it('keeps the note to what the game-server accepts', () => {
    expect(rulingBody(SESSION, 42, 'reject', 'x'.repeat(600)).note).toHaveLength(NOTE_MAX_LENGTH);
  });
});

describe('recentLine', () => {
  const now = Date.parse('2026-10-03T10:41:12Z');

  it('shows the ruling in words, the team, the checkpoint and when', () => {
    expect(recentLine(recentRuling, now)).toEqual({
      ruling: '✓ Approved',
      text: 'Green Owls · #1 Stone fountain · 2 min ago',
      note: '',
    });
  });

  it('shows a rejection with its note', () => {
    expect(recentLine({ ...recentRuling, ruling: 'reject', note: 'Wrong fountain' }, now)).toEqual({
      ruling: '✗ Rejected',
      text: 'Green Owls · #1 Stone fountain · 2 min ago',
      note: 'Note: Wrong fountain',
    });
  });

  it('says what the referee had said about a photo it passed or failed', () => {
    expect(recentLine({ ...recentRuling, ruling: 'reject', verdict: 'pass' }, now).text).toBe(
      'Green Owls · #1 Stone fountain · 2 min ago · the referee passed it',
    );
  });
});

describe('finishing with photos in review', () => {
  const team = (completed: number, joined = true) => ({
    team: `Team ${completed}`,
    joined,
    completed: joined ? completed : null,
    total: joined ? 3 : null,
    points: joined ? 5 : null,
    'in-review': joined ? 0 : null,
    place: null,
    'last-completed': null,
    current: null,
  });
  type Clock = typeof scheduled | typeof running | typeof stopped;
  const overviewWith = (clock: Clock, teams: ReturnType<typeof team>[]) => ({ session: clock, teams, blocked: [] });

  describe('the all-finished banner', () => {
    it('shows once every joined team has completed its route, ignoring teams that never joined', () => {
      const overview = overviewWith(running, [team(3), team(3), team(0, false)]);

      expect(allTeamsFinished(overview)).toBe(true);
      expect(finishBanner(overview, 0)).toBe('All teams have finished.');
    });

    it('asks to review the photos first when some are waiting', () => {
      expect(finishBanner(overviewWith(running, [team(3)]), 2)).toBe(
        'All teams have finished. Review the photos below, then finish the session.',
      );
    });

    it.each([
      ['a team is still playing', overviewWith(running, [team(3), team(2)])],
      ['no team has joined', overviewWith(running, [team(0, false)])],
      ['there are no teams', overviewWith(running, [])],
      ['the session has not started', overviewWith(scheduled, [team(3)])],
      ['the session has finished', overviewWith(stopped, [team(3)])],
      ['there is no overview', null],
    ])('does not show while %s', (_label, overview) => {
      expect(allTeamsFinished(overview)).toBe(false);
      expect(finishBanner(overview, 1)).toBe('');
    });
  });

  describe('the finish confirmation', () => {
    it('is the plain warning with nothing in review', () => {
      expect(confirmFinishText(0)).toBe(CONFIRM_FINISH);
    });

    it.each([
      [1, '1 photo is still in review.'],
      [3, '3 photos are still in review.'],
    ])('warns about %i photo(s) still in review', (waiting, words) => {
      expect(confirmFinishText(waiting)).toBe(
        `${CONFIRM_FINISH} ${words} Results won't be final until you've decided them.`,
      );
    });
  });

  describe('the standings note', () => {
    it('says nothing before the finish', () => {
      expect(standingsNote(running, 2)).toEqual({ final: false, text: '' });
      expect(standingsNote(scheduled, 0)).toEqual({ final: false, text: '' });
    });

    it.each([
      [1, 'Waiting for 1 review.'],
      [2, 'Waiting for 2 reviews.'],
    ])('after the finish with %i in review, waits for them in place of final places', (waiting, words) => {
      expect(standingsNote(stopped, waiting)).toEqual({
        final: false,
        text: `${words} The places show once you've decided them.`,
      });
    });

    it('is final after the finish with nothing in review', () => {
      expect(standingsNote(stopped, 0)).toEqual({
        final: true,
        text: 'Final standings: ready to announce the winners.',
      });
    });
  });
});
