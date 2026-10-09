import { describe, expect, it } from 'vitest';
import {
  acceptedLoopM,
  changedFields,
  charCount,
  CHECKPOINT_LIMITS,
  checkpointRows,
  costWords,
  counter,
  designerError,
  distanceM,
  distanceWords,
  draftFacts,
  draftListLine,
  editError,
  elapsedLine,
  FAILURE_TEXT,
  failureText,
  fieldError,
  formFromCheckpoint,
  formFromRequest,
  isDraftId,
  isRunning,
  kindWords,
  LIMITS,
  localToIso,
  loopM,
  MIN_ACCEPTED,
  newestFirst,
  osmUrl,
  problemField,
  problemLines,
  problemsByField,
  progressLines,
  publicationError,
  publicationView,
  publishedRows,
  publishError,
  publishReadiness,
  readDraftId,
  requestLine,
  REVIEW_WORDS,
  reviewCards,
  reviewCounts,
  reviewOf,
  reviewSummary,
  runLine,
  runningDraftId,
  statusLabel,
  STEP_LABELS,
  stepLabel,
  validateDesign,
  validateEdit,
  validatePublish,
  validateTeams,
  whenWords,
} from '../src/public/designer-logic.js';

const DRAFT = '5b0c7a1e-1111-4111-8111-111111111111';
const OTHER = '5b0c7a1e-2222-4222-8222-222222222222';

const request = { area: 'Chiswick, London', theme: 'The Thames and brewing history', checkpoints: 3, 'max-walk-km': 3 };

const running = {
  id: DRAFT,
  status: 'running',
  request,
  area: null,
  progress: [
    { at: '2026-10-08T09:00:04Z', step: 'find_area', summary: 'Chiswick, London, England' },
    { at: '2026-10-08T09:00:12Z', step: 'find_places', summary: '58 candidate places' },
  ],
  checkpoints: [],
  route: null,
  problems: [],
  run: { runner: 'agent', model: 'm', turns: 4, 'cost-usd': 0, 'duration-ms': null, error: null },
  attribution: '© OpenStreetMap contributors',
  published: null,
  'created-at': '2026-10-08T09:00:00Z',
  'finished-at': null,
};

const checkpoint = (position: number, name: string) => ({
  position,
  place: { osm: `node/${position}`, name, kind: 'historic=memorial', location: { lat: 51.49, long: -0.25 } },
  clue: `Clue ${position}`,
  challenge: { scene: `Scene ${position}`, pose: `Pose ${position}` },
  proximity: 40,
  rationale: 'Why',
  review: 'pending',
  edited: false,
  original: null,
});

const ready = {
  ...running,
  status: 'ready',
  checkpoints: [checkpoint(2, 'Riverside Bench'), checkpoint(1, 'Lantern Gate'), checkpoint(3, "Brewers' Arch")],
  run: { ...running.run, 'cost-usd': 0.42, 'duration-ms': 221000 },
  'finished-at': '2026-10-08T09:03:41Z',
};

const failed = (code: string | null) => ({
  ...running,
  status: 'failed',
  problems: [
    { code: 'too_close', position: 2, message: 'Checkpoints 2 and 3 are 90 m apart; keep them at least 150 m apart' },
    { code: 'route_too_long', position: null, message: 'The loop is 3.4 km; keep it to 3 km' },
  ],
  run: { ...running.run, 'cost-usd': 1, 'duration-ms': 60000, error: code === null ? null : { code } },
  'finished-at': '2026-10-08T09:01:00Z',
});

describe('readDraftId and isDraftId', () => {
  it('reads a valid draft id from the link', () => {
    expect(readDraftId(new URLSearchParams(`draft=${DRAFT}`))).toBe(DRAFT);
  });

  it.each(['', 'draft=', 'draft=not-a-uuid', `draft=${DRAFT}x`])('is null for %j', (query) => {
    expect(readDraftId(new URLSearchParams(query))).toBeNull();
  });

  it.each([[DRAFT, true], ['nope', false], [42, false], [null, false]])('isDraftId(%j) is %s', (value, expected) => {
    expect(isDraftId(value)).toBe(expected);
  });
});

describe('validateDesign', () => {
  const form = { area: 'Chiswick, London', theme: 'The Thames and brewing history', checkpoints: '3', maxWalkKm: '3' };

  it('turns a valid form into the request body the game-server expects', () => {
    expect(validateDesign(form)).toEqual({ request, errors: {} });
  });

  it('trims the area and theme, as the game-server does', () => {
    const { request: body } = validateDesign({ ...form, area: '  Kew  ', theme: '\tGardens and glasshouses ' });

    expect(body).toMatchObject({ area: 'Kew', theme: 'Gardens and glasshouses' });
  });

  it('accepts the limits themselves', () => {
    const { request: lowest } = validateDesign({ ...form, area: 'Kew', theme: 'Art', checkpoints: '3', maxWalkKm: '0.5' });
    const { request: highest } = validateDesign({
      ...form,
      area: 'a'.repeat(200),
      theme: 't'.repeat(200),
      checkpoints: '8',
      maxWalkKm: '10',
    });

    expect(lowest).toEqual({ area: 'Kew', theme: 'Art', checkpoints: 3, 'max-walk-km': 0.5 });
    expect(highest).toMatchObject({ checkpoints: 8, 'max-walk-km': 10 });
  });

  it('accepts a walk that is not a whole or half kilometre', () => {
    expect(validateDesign({ ...form, maxWalkKm: '2.3' }).request).toMatchObject({ 'max-walk-km': 2.3 });
  });

  it.each([
    ['an empty area', { area: '' }, 'area'],
    ['an area of spaces', { area: '     ' }, 'area'],
    ['an area of 2 characters after trimming', { area: ' Ab ' }, 'area'],
    ['an area of 201 characters', { area: 'a'.repeat(201) }, 'area'],
    ['an empty theme', { theme: '' }, 'theme'],
    ['a theme of 201 characters', { theme: 't'.repeat(201) }, 'theme'],
    ['2 checkpoints', { checkpoints: '2' }, 'checkpoints'],
    ['9 checkpoints', { checkpoints: '9' }, 'checkpoints'],
    ['3.5 checkpoints', { checkpoints: '3.5' }, 'checkpoints'],
    ['no checkpoints', { checkpoints: '' }, 'checkpoints'],
    ['a walk of 0.4 km', { maxWalkKm: '0.4' }, 'maxWalkKm'],
    ['a walk of 10.5 km', { maxWalkKm: '10.5' }, 'maxWalkKm'],
    ['a negative walk', { maxWalkKm: '-3' }, 'maxWalkKm'],
    ['no walk', { maxWalkKm: '' }, 'maxWalkKm'],
    ['a walk that is not a number', { maxWalkKm: 'far' }, 'maxWalkKm'],
  ])('refuses %s, with an error on that field only', (_label, change, field) => {
    const { request: body, errors } = validateDesign({ ...form, ...change });

    expect(body).toBeNull();
    expect(Object.keys(errors)).toEqual([field]);
    expect(errors[field as keyof typeof errors]).toMatch(/\w/);
  });

  it('reports every bad field at once', () => {
    const { errors } = validateDesign({ area: '', theme: '', checkpoints: '0', maxWalkKm: '0' });

    expect(Object.keys(errors).sort()).toEqual(['area', 'checkpoints', 'maxWalkKm', 'theme']);
  });

  it('says what the limits are', () => {
    const { errors } = validateDesign({ area: 'x', theme: 'y'.repeat(201), checkpoints: '9', maxWalkKm: '11' });

    expect(errors.area).toBe('Enter the area: at least 3 characters.');
    expect(errors.theme).toBe('Keep the theme to 200 characters or fewer.');
    expect(errors.checkpoints).toBe('Choose a whole number of checkpoints from 3 to 8.');
    expect(errors.maxWalkKm).toBe('Choose a walk from 0.5 to 10 km.');
  });

  it('has the contract limits and defaults', () => {
    expect(LIMITS).toEqual({
      text: { min: 3, max: 200 },
      checkpoints: { min: 3, max: 8, default: 3 },
      maxWalkKm: { min: 0.5, max: 10, default: 3 },
    });
  });
});

describe('formFromRequest (Try again)', () => {
  it('fills the form with the same request', () => {
    expect(formFromRequest({ ...request, checkpoints: 5, 'max-walk-km': 2.5 })).toEqual({
      area: 'Chiswick, London',
      theme: 'The Thames and brewing history',
      checkpoints: '5',
      maxWalkKm: '2.5',
    });
  });

  it('uses the defaults for anything missing', () => {
    expect(formFromRequest(null)).toEqual({ area: '', theme: '', checkpoints: '3', maxWalkKm: '3' });
  });

  it('round-trips through validateDesign', () => {
    expect(validateDesign(formFromRequest(request)).request).toEqual(request);
  });
});

describe('requestLine', () => {
  it('says how many checkpoints and how far', () => {
    expect(requestLine(request)).toBe('3 checkpoints, up to 3 km');
    expect(requestLine({ ...request, 'max-walk-km': 0.5 })).toBe('3 checkpoints, up to 0.5 km');
    expect(requestLine(undefined)).toBe('');
  });
});

describe('statuses', () => {
  it.each([
    ['running', 'Designing…'],
    ['ready', 'Ready'],
    ['failed', 'Failed'],
    ['published', 'Published'],
    ['something_new', 'something_new'],
  ])('labels %s as %j', (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });

  it('keeps polling only a running draft', () => {
    expect(isRunning(running)).toBe(true);
    expect(isRunning(ready)).toBe(false);
    expect(isRunning(failed('deadline'))).toBe(false);
    expect(isRunning(null)).toBe(false);
  });
});

describe('the drafts list', () => {
  const item = (id: string, status: string, createdAt: string, cost = 0.42) => ({
    id,
    status,
    area: 'Chiswick, London',
    theme: 'The Thames',
    'created-at': createdAt,
    'finished-at': null,
    checkpoints: 3,
    'cost-usd': cost,
  });

  it('puts the newest first, and leaves out anything without a draft id', () => {
    const list = newestFirst({
      drafts: [
        item(OTHER, 'ready', '2026-10-08T08:00:00Z'),
        item(DRAFT, 'running', '2026-10-08T09:00:00Z'),
        { ...item('not-a-uuid', 'ready', '2026-10-08T10:00:00Z') },
        null,
      ],
    });

    expect(list.map((draft) => draft.id)).toEqual([DRAFT, OTHER]);
  });

  it.each([null, {}, { drafts: 'nope' }, 'text'])('is empty for %j', (body) => {
    expect(newestFirst(body)).toEqual([]);
  });

  it('finds the running draft, to link to when another design is refused', () => {
    expect(runningDraftId([item(OTHER, 'ready', 'x'), item(DRAFT, 'running', 'y')])).toBe(DRAFT);
    expect(runningDraftId([item(OTHER, 'failed', 'x')])).toBeNull();
  });

  it('shows the status, area, theme, when and cost', () => {
    const line = draftListLine(item(DRAFT, 'ready', '2026-10-08T09:00:00Z'));

    expect(line).toEqual({
      status: 'Ready',
      area: 'Chiswick, London',
      theme: 'The Thames',
      when: whenWords('2026-10-08T09:00:00Z'),
      cost: '$0.42',
    });
    expect(line.when).toMatch(/\d/);
  });

  it("shows no cost while a draft is running: it isn't known yet", () => {
    expect(draftListLine(item(DRAFT, 'running', '2026-10-08T09:00:00Z', 0)).cost).toBe('');
  });

  it.each([
    [0.42, '$0.42'],
    [0, '$0.00'],
    [1, '$1.00'],
    [0.005, '$0.01'],
    [null, ''],
    [-1, ''],
  ])('costWords(%j) is %j', (cost, words) => {
    expect(costWords(cost)).toBe(words);
  });

  it('whenWords is empty for a missing time', () => {
    expect(whenWords(undefined)).toBe('');
    expect(whenWords('not a time')).toBe('');
  });
});

describe('a running draft', () => {
  it.each([
    ['find_area', 'Finding the area'],
    ['resolve_area', 'Finding the area'],
    ['find_places', 'Looking for places'],
    ['place_details', 'Reading about a place'],
    ['measure_route', 'Measuring the route'],
    ['write_clues', 'Writing clues and challenges'],
    ['submit_draft', 'Checking the draft'],
    ['check_draft', 'Checking the draft'],
  ])('labels the step %s as %j', (step, label) => {
    expect(stepLabel(step)).toBe(label);
    expect(STEP_LABELS[step as keyof typeof STEP_LABELS]).toBe(label);
  });

  it('falls back to the raw step name for a step it does not know', () => {
    expect(stepLabel('consult_oracle')).toBe('consult_oracle');
    expect(stepLabel('toString')).toBe('toString');
    expect(stepLabel(undefined)).toBe('A step');
  });

  it('shows each step with its summary, oldest first, and how far into the run it came', () => {
    expect(progressLines(running)).toEqual([
      { at: '0:04', text: 'Finding the area: Chiswick, London, England' },
      { at: '0:12', text: 'Looking for places: 58 candidate places' },
    ]);
  });

  it('shows a step without a summary by its label alone', () => {
    const draft = { ...running, progress: [{ at: 'bad', step: 'measure_route', summary: '' }] };

    expect(progressLines(draft)).toEqual([{ at: '', text: 'Measuring the route' }]);
  });

  it('has no steps before the first', () => {
    expect(progressLines({ ...running, progress: [] })).toEqual([]);
    expect(progressLines(null)).toEqual([]);
  });

  it('shows the time elapsed, by server time', () => {
    expect(elapsedLine(running, Date.parse('2026-10-08T09:01:23Z'))).toBe('Running for 1:23');
    expect(elapsedLine(running, Date.parse('2026-10-08T08:59:00Z'))).toBe('Running for 0:00');
    expect(elapsedLine({ ...running, 'created-at': 'bad' }, Date.now())).toBe('Running');
  });

  it('shows how long a finished run took, its turns and what it cost', () => {
    expect(runLine(ready)).toBe('Took 3:41 · 4 turns · cost $0.42');
    expect(runLine({ ...ready, run: { ...ready.run, 'duration-ms': null } })).toBe('Took 3:41 · 4 turns · cost $0.42');
    expect(runLine({ ...ready, run: { ...ready.run, turns: 1 } })).toBe('Took 3:41 · 1 turn · cost $0.42');
    expect(runLine(running)).toBe('');
  });

  it('shows no turns for the stub runner, which takes none', () => {
    expect(runLine({ ...ready, run: { ...ready.run, turns: 0 } })).toBe('Took 3:41 · cost $0.42');
  });
});

describe('a failed draft', () => {
  it.each([
    ['max_turns', 'The designer ran out of steps.'],
    ['max_budget', 'It reached its spending limit.'],
    ['deadline', 'It took too long.'],
    ['no_valid_draft', "It couldn't produce a hunt that meets the rules."],
    ['agent_unavailable', "The designer couldn't start."],
    ['interrupted', 'The server restarted during the run.'],
  ])('explains %s as %j', (code, text) => {
    expect(failureText(failed(code))).toBe(text);
    expect(FAILURE_TEXT[code as keyof typeof FAILURE_TEXT]).toBe(text);
  });

  it('names an error code it does not know', () => {
    expect(failureText(failed('out_of_ideas'))).toBe('The design failed (out_of_ideas).');
    expect(failureText(failed('constructor'))).toBe('The design failed (constructor).');
    expect(failureText(failed(null))).toBe('The design failed.');
  });

  it('lists the problems from its last attempt, by checkpoint', () => {
    expect(problemLines(failed('max_turns'))).toEqual([
      'Checkpoint 2: Checkpoints 2 and 3 are 90 m apart; keep them at least 150 m apart',
      'The loop is 3.4 km; keep it to 3 km',
    ]);
  });

  it('has no problems to list when the run had no draft', () => {
    expect(problemLines({ ...failed('agent_unavailable'), problems: [] })).toEqual([]);
    expect(problemLines(null)).toEqual([]);
  });

  it('falls back to the code for a problem without a message', () => {
    expect(problemLines({ ...running, problems: [{ code: 'wrong_count', position: null, message: '' }] })).toEqual([
      'wrong_count',
    ]);
  });
});

describe('a ready draft', () => {
  it('lists its checkpoints in route order: name, clue and pose', () => {
    expect(checkpointRows(ready)).toEqual([
      { position: 1, name: 'Lantern Gate', clue: 'Clue 1', pose: 'Pose 1' },
      { position: 2, name: 'Riverside Bench', clue: 'Clue 2', pose: 'Pose 2' },
      { position: 3, name: "Brewers' Arch", clue: 'Clue 3', pose: 'Pose 3' },
    ]);
  });

  it('is empty without checkpoints', () => {
    expect(checkpointRows(running)).toEqual([]);
    expect(checkpointRows(undefined)).toEqual([]);
  });
});

describe('a published draft', () => {
  it('lists the accepted checkpoints only, numbered 1… in route order as the session numbers them', () => {
    const published = {
      ...ready,
      status: 'published',
      checkpoints: [
        { ...checkpoint(3, "Brewers' Arch"), review: 'accepted' },
        { ...checkpoint(1, 'Lantern Gate'), review: 'accepted' },
        { ...checkpoint(2, 'Riverside Bench'), review: 'rejected' },
        { ...checkpoint(4, 'Old Mill'), review: 'accepted' },
      ],
    };

    expect(publishedRows(published)).toEqual([
      { position: 1, name: 'Lantern Gate', clue: 'Clue 1', pose: 'Pose 1' },
      { position: 2, name: "Brewers' Arch", clue: 'Clue 3', pose: 'Pose 3' },
      { position: 3, name: 'Old Mill', clue: 'Clue 4', pose: 'Pose 4' },
    ]);
    expect(publishedRows(undefined)).toEqual([]);
  });
});

describe("a ready draft's header", () => {
  it("names the area found and the loop's length", () => {
    const found = { ...ready, area: { name: 'Chiswick, London, England', clipped: false }, route: { 'legs-m': [], 'loop-m': 1410 } };

    expect(draftFacts(found)).toBe('Chiswick, London, England · loop 1.41 km');
    expect(draftFacts({ ...found, area: { name: 'Chiswick', clipped: true } })).toBe('Chiswick (clipped) · loop 1.41 km');
    expect(draftFacts({ ...found, route: null })).toBe('Chiswick, London, England');
    expect(draftFacts(running)).toBe('');
  });
});

// Points on the equator: 1° of longitude there is 2πR/360 = 111,195.08 m.
const DEGREE_M = (2 * Math.PI * 6_371_008.8) / 360;
const at = (long: number) => ({ lat: 0, long });

describe('reviewing a checkpoint', () => {
  const saved = checkpoint(2, 'Riverside Bench');
  const form = formFromCheckpoint(saved);

  describe('counters and limits', () => {
    it('has the limits of the contract', () => {
      expect(CHECKPOINT_LIMITS).toEqual({
        clue: { min: 1, max: 300 },
        pose: { min: 1, max: 200 },
        scene: { min: 1, max: 1000 },
        proximity: { min: 20, max: 100 },
      });
    });

    it.each([
      ['clue', 300],
      ['pose', 200],
      ['scene', 1000],
    ] as const)('counts the %s up to %s, and says when it is over', (field, max) => {
      expect(counter(field, 'Hello')).toEqual({ text: `5 / ${max}`, over: false });
      expect(counter(field, 'x'.repeat(max))).toEqual({ text: `${max} / ${max}`, over: false });
      expect(counter(field, 'x'.repeat(max + 1))).toEqual({ text: `${max + 1} / ${max}`, over: true });
    });

    it('counts characters as the game-server does, so an emoji counts once', () => {
      expect(charCount('📍')).toBe(1);
      expect('📍'.length).toBe(2);
      expect(counter('pose', '📍'.repeat(200))).toEqual({ text: '200 / 200', over: false });
    });

    it.each([
      ['clue', 300],
      ['pose', 200],
      ['scene', 1000],
    ] as const)('checks the %s: not empty, and at most %s characters', (field, max) => {
      expect(fieldError(field, 'x')).toBe('');
      expect(fieldError(field, 'x'.repeat(max))).toBe('');
      expect(fieldError(field, 'x'.repeat(max + 1))).toBe(`Keep the ${field} to ${max} characters or fewer.`);
      expect(fieldError(field, '')).toBe(`The ${field} can't be empty.`);
      expect(fieldError(field, ' \n ')).toBe(`The ${field} can't be empty.`);
    });

    it.each(['20', '100', '45', ' 40 '])('accepts a check-in radius of %j', (radius) => {
      expect(fieldError('proximity', radius)).toBe('');
    });

    it.each(['19', '101', '40.5', '-30', '', 'forty'])('rejects a check-in radius of %j', (radius) => {
      expect(fieldError('proximity', radius)).toBe('Choose a whole number of metres from 20 to 100.');
    });
  });

  describe('the changed-fields diff', () => {
    it("is the checkpoint's own values to begin with", () => {
      expect(form).toEqual({ clue: 'Clue 2', pose: 'Pose 2', scene: 'Scene 2', proximity: '40' });
      expect(changedFields(saved, form)).toEqual({});
    });

    it('has only the fields that changed', () => {
      expect(changedFields(saved, { ...form, clue: 'A new clue' })).toEqual({ clue: 'A new clue' });
      expect(changedFields(saved, { ...form, pose: 'Wave', scene: 'A bench' })).toEqual({ pose: 'Wave', scene: 'A bench' });
    });

    it('sends the radius as a number, and only when its value changed', () => {
      expect(changedFields(saved, { ...form, proximity: '45' })).toEqual({ proximity: 45 });
      expect(changedFields(saved, { ...form, proximity: ' 40 ' })).toEqual({});
      expect(changedFields(saved, { ...form, proximity: '040' })).toEqual({});
      expect(changedFields(saved, { ...form, proximity: 'forty' })).toEqual({ proximity: NaN });
    });

    it('sends text as typed, spaces and all', () => {
      expect(changedFields(saved, { ...form, clue: 'Clue 2 ' })).toEqual({ clue: 'Clue 2 ' });
    });

    it('is nothing when the text is changed back', () => {
      expect(changedFields(saved, { ...form, clue: 'Clue 2' })).toEqual({});
    });
  });

  describe('validateEdit', () => {
    it('checks the changed fields only', () => {
      expect(validateEdit(saved, { ...form, clue: 'A new clue' })).toEqual({ changes: { clue: 'A new clue' }, errors: {} });
      expect(validateEdit(saved, { ...form, clue: '', proximity: '150' })).toEqual({
        changes: { clue: '', proximity: 150 },
        errors: { clue: "The clue can't be empty.", proximity: 'Choose a whole number of metres from 20 to 100.' },
      });
    });
  });

  describe('which field a problem belongs under', () => {
    const problem = (code: string, message: string) => ({ code, position: 2, message });

    it.each([
      ['names_place', 'Checkpoint 2\'s clue gives the place away ("Riverside"); describe it without its name', 'clue'],
      ['names_place', 'Checkpoint 2\'s pose gives the place away ("Riverside"); describe it without its name', 'pose'],
      ['names_place', 'Checkpoint 2\'s pose gives the place away ("Clue Tower"); describe it without its name', 'pose'],
      ['too_long', "Checkpoint 2's scene is 1200 characters; keep it within 1000", 'scene'],
      ['too_long', "Checkpoint 2's clue is 301 characters; keep it within 300", 'clue'],
      ['empty', "Checkpoint 2's pose is empty", 'pose'],
      ['bad_proximity', "Checkpoint 2's proximity is 150 m; keep it between 20 and 100 m", 'proximity'],
    ])('puts %s %j under the %s', (code, message, field) => {
      expect(problemField(problem(code, message))).toBe(field);
    });

    it.each([
      ['too_close', 'Checkpoints 2 and 3 are 90 m apart; keep them at least 150 m apart'],
      ['unknown_place', "Checkpoint 2's place isn't one of this run's candidate places; pick one of them"],
      ['too_long', 'Something about nothing in particular'],
    ])('puts %s %j on the card', (code, message) => {
      expect(problemField(problem(code, message))).toBeNull();
    });

    it("sorts a 422's problems by field, with the rest on the card", () => {
      expect(
        problemsByField([
          problem('names_place', 'Checkpoint 2\'s clue gives the place away ("Riverside"); describe it without its name'),
          problem('too_long', "Checkpoint 2's pose is 201 characters; keep it within 200"),
          problem('too_close', 'Checkpoints 2 and 3 are 90 m apart'),
          { code: 'bad_proximity', position: 2, message: '' },
          null,
        ]),
      ).toEqual({
        clue: ['Checkpoint 2\'s clue gives the place away ("Riverside"); describe it without its name'],
        pose: ["Checkpoint 2's pose is 201 characters; keep it within 200"],
        scene: [],
        proximity: ['bad_proximity'],
        card: ['Checkpoints 2 and 3 are 90 m apart'],
      });
      expect(problemsByField(undefined)).toEqual({ clue: [], pose: [], scene: [], proximity: [], card: [] });
    });
  });

  describe('the cards', () => {
    it('has a word for each review, and treats anything else as still to review', () => {
      expect(REVIEW_WORDS).toEqual({ pending: 'To review', accepted: 'Accepted', rejected: 'Rejected' });
      expect(reviewOf({ ...saved, review: 'accepted' })).toBe('accepted');
      expect(reviewOf({ ...saved, review: 'rejected' })).toBe('rejected');
      expect(reviewOf({ ...saved, review: 'maybe' })).toBe('pending');
      expect(reviewOf(undefined)).toBe('pending');
    });

    it.each([
      ['node/123', 'https://www.openstreetmap.org/node/123'],
      ['way/45', 'https://www.openstreetmap.org/way/45'],
      ['relation/6', 'https://www.openstreetmap.org/relation/6'],
      ['node/12a', null],
      ['javascript:alert(1)', null],
      ['node/1/../../evil', null],
      ['', null],
    ])('links %j to %j on OpenStreetMap', (osm, url) => {
      expect(osmUrl(osm)).toBe(url);
    });

    it('puts a place kind in words', () => {
      expect(kindWords('historic=memorial')).toBe('historic · memorial');
      expect(kindWords('amenity=place_of_worship')).toBe('amenity · place of worship');
      expect(kindWords(undefined)).toBe('');
    });

    it('has one card per checkpoint, in route order', () => {
      const draft = {
        ...ready,
        checkpoints: [
          { ...checkpoint(2, 'Riverside Bench'), review: 'accepted', edited: true },
          { ...checkpoint(1, 'Lantern Gate'), place: { ...checkpoint(1, '').place, name: 'Lantern Gate', osm: 'way/77' } },
        ],
      };

      expect(reviewCards(draft)).toEqual([
        {
          position: 1,
          name: 'Lantern Gate',
          kind: 'historic · memorial',
          rationale: 'Why',
          osmUrl: 'https://www.openstreetmap.org/way/77',
          review: 'pending',
          edited: false,
          form: { clue: 'Clue 1', pose: 'Pose 1', scene: 'Scene 1', proximity: '40' },
        },
        {
          position: 2,
          name: 'Riverside Bench',
          kind: 'historic · memorial',
          rationale: 'Why',
          osmUrl: 'https://www.openstreetmap.org/node/2',
          review: 'accepted',
          edited: true,
          form: { clue: 'Clue 2', pose: 'Pose 2', scene: 'Scene 2', proximity: '40' },
        },
      ]);
      expect(reviewCards(running)).toEqual([]);
    });
  });
});

describe('the summary bar', () => {
  const placed = (position: number, long: number, review: string) => ({
    ...checkpoint(position, `Place ${position}`),
    place: { ...checkpoint(position, '').place, name: `Place ${position}`, location: at(long) },
    review,
  });

  it('counts accepted, rejected and pending', () => {
    expect(
      reviewCounts([placed(1, 0, 'accepted'), placed(2, 0, 'rejected'), placed(3, 0, 'pending'), placed(4, 0, 'accepted')]),
    ).toEqual({ accepted: 2, rejected: 1, pending: 1 });
    expect(reviewCounts(undefined)).toEqual({ accepted: 0, rejected: 0, pending: 0 });
  });

  it('works out distances with the same haversine as the game-server', () => {
    expect(distanceM(at(0), at(1))).toBeCloseTo(DEGREE_M, 3);
    expect(distanceM({ lat: 51.5, long: -0.25 }, { lat: 51.5, long: -0.25 })).toBe(0);
    // London to Paris, about 343.6 km.
    expect(distanceM({ lat: 51.5074, long: -0.1278 }, { lat: 48.8566, long: 2.3522 }) / 1000).toBeCloseTo(343.56, 1);
  });

  it('closes the loop back to the first place', () => {
    expect(loopM([at(0), at(1), at(3)])).toBeCloseTo(6 * DEGREE_M, 3);
    expect(loopM([at(0), at(1)])).toBeCloseTo(2 * DEGREE_M, 3);
    expect(loopM([at(0)])).toBe(0);
    expect(loopM([])).toBe(0);
  });

  it('works out the loop over the accepted checkpoints only, in route order', () => {
    const draft = {
      ...ready,
      checkpoints: [placed(3, 0.01, 'accepted'), placed(1, 0, 'accepted'), placed(2, 5, 'rejected'), placed(4, 0.02, 'pending')],
    };

    // 1 → 3 → back to 1: the rejected and pending ones are left out.
    expect(acceptedLoopM(draft)).toBeCloseTo(0.02 * DEGREE_M, 3);
    expect(acceptedLoopM({ ...draft, checkpoints: [placed(1, 0, 'accepted'), placed(2, 1, 'rejected')] })).toBeNull();
  });

  it('puts distances in words', () => {
    expect(distanceWords(849.6)).toBe('850 m');
    expect(distanceWords(1000)).toBe('1.00 km');
    expect(distanceWords(1410)).toBe('1.41 km');
  });

  it('says how long the loop of the accepted is, and when it is longer than the walk asked for', () => {
    const draft = {
      ...ready,
      request: { ...request, 'max-walk-km': 3 },
      checkpoints: [placed(1, 0, 'accepted'), placed(2, 0.01, 'accepted'), placed(3, 0.02, 'rejected')],
    };

    expect(reviewSummary(draft)).toEqual({
      accepted: 2,
      rejected: 1,
      pending: 0,
      loop: 'Loop of the accepted: 2.22 km (up to 3 km)',
      over: false,
    });
    expect(reviewSummary({ ...draft, request: { ...request, 'max-walk-km': 2 } })).toMatchObject({ over: true });
    expect(reviewSummary({ ...draft, checkpoints: [placed(1, 0, 'pending')] })).toMatchObject({
      loop: 'Accept checkpoints to see the loop',
      over: false,
    });
  });
});

describe('the "can publish" rule', () => {
  const reviewed = (...reviews: string[]) => ({
    ...ready,
    checkpoints: reviews.map((review, index) => ({ ...checkpoint(index + 1, `Place ${index + 1}`), review })),
  });

  it('needs at least 3 accepted', () => {
    expect(MIN_ACCEPTED).toBe(3);
  });

  it('is met with 3 accepted and the rest rejected', () => {
    expect(publishReadiness(reviewed('accepted', 'accepted', 'accepted'))).toEqual({ ok: true, message: '' });
    expect(publishReadiness(reviewed('accepted', 'rejected', 'accepted', 'accepted', 'rejected'))).toEqual({
      ok: true,
      message: '',
    });
  });

  it('is not met with a checkpoint still pending, and says so', () => {
    expect(publishReadiness(reviewed('accepted', 'accepted', 'accepted', 'pending'))).toEqual({
      ok: false,
      message: 'Accept or reject every checkpoint: 1 checkpoint still to review.',
    });
  });

  it('is not met with fewer than 3 accepted, and says so', () => {
    expect(publishReadiness(reviewed('accepted', 'accepted', 'rejected'))).toEqual({
      ok: false,
      message: 'At least 3 must be accepted, and 2 are: undo a rejection to accept it.',
    });
    expect(publishReadiness(reviewed('accepted', 'rejected', 'rejected'))).toMatchObject({
      message: 'At least 3 must be accepted, and 1 is: undo a rejection to accept it.',
    });
  });

  it('says everything that is missing', () => {
    expect(publishReadiness(reviewed('pending', 'pending', 'accepted'))).toEqual({
      ok: false,
      message: 'Accept or reject every checkpoint: 2 checkpoints still to review. At least 3 must be accepted (1 so far).',
    });
  });

  it('is not met while a card has unsaved changes, which publishing would lose', () => {
    expect(publishReadiness(reviewed('accepted', 'accepted', 'accepted'), [3, 1])).toEqual({
      ok: false,
      message: 'Save your changes to checkpoint 1, 3 first.',
    });
  });

  it('is not met for a draft that is not ready', () => {
    expect(publishReadiness({ ...reviewed('accepted', 'accepted', 'accepted'), status: 'published' })).toEqual({
      ok: false,
      message: 'This draft is already published.',
    });
    expect(publishReadiness(running)).toEqual({ ok: false, message: 'Only a ready draft can be published.' });
    expect(publishReadiness(null)).toMatchObject({ ok: false });
  });
});

describe('datetime-local to ISO 8601 with an offset', () => {
  it.each([
    [60, '2026-10-11T10:00:00+01:00'],
    [0, '2026-10-11T10:00:00+00:00'],
    [-300, '2026-10-11T10:00:00-05:00'],
    [330, '2026-10-11T10:00:00+05:30'],
    [-570, '2026-10-11T10:00:00-09:30'],
  ])('with an offset of %s minutes is %s', (offset, iso) => {
    expect(localToIso('2026-10-11T10:00', offset)).toBe(iso);
  });

  it('keeps the seconds when the browser sends them, and drops a fraction', () => {
    expect(localToIso('2026-10-11T10:00:30', 60)).toBe('2026-10-11T10:00:30+01:00');
    expect(localToIso('2026-10-11T10:00:30.250', 60)).toBe('2026-10-11T10:00:30+01:00');
  });

  it("uses the browser's own offset on that date by default, so summer time is right", () => {
    for (const [value, local] of [
      ['2026-01-15T10:00', new Date(2026, 0, 15, 10, 0)],
      ['2026-07-15T10:00', new Date(2026, 6, 15, 10, 0)],
    ] as const) {
      const iso = localToIso(value)!;
      expect(iso.startsWith(`${value}:00`)).toBe(true);
      expect(Date.parse(iso)).toBe(local.getTime());
    }
  });

  it.each(['', '2026-10-11', '2026-10-11 10:00', '2026-02-30T10:00', '2026-13-01T10:00', '2026-10-11T24:00', 'soon'])(
    'is null for %j',
    (value) => {
      expect(localToIso(value, 60)).toBeNull();
    },
  );
});

describe('the team list', () => {
  it('trims and keeps 1 to 10 names of 1 to 40 characters', () => {
    expect(validateTeams(['  Red Foxes ', 'Blue Herons'])).toEqual({ teams: ['Red Foxes', 'Blue Herons'], rows: ['', ''], error: '' });
    expect(validateTeams(['x'.repeat(40)])).toMatchObject({ teams: ['x'.repeat(40)] });
    const ten = Array.from({ length: 10 }, (_, index) => `Team ${index + 1}`);
    expect(validateTeams(ten)).toMatchObject({ teams: ten, error: '' });
  });

  it('needs at least one team, and at most 10', () => {
    expect(validateTeams([])).toEqual({ teams: null, rows: [], error: 'Add at least one team.' });
    const eleven = Array.from({ length: 11 }, (_, index) => `Team ${index + 1}`);
    expect(validateTeams(eleven)).toMatchObject({ teams: null, error: 'Keep it to 10 teams or fewer.' });
  });

  it('says what is wrong with each row', () => {
    expect(validateTeams(['Red Foxes', '  ', 'x'.repeat(41)])).toEqual({
      teams: null,
      rows: ['', 'Enter a team name, or remove this row.', 'Keep the name to 40 characters or fewer.'],
      error: '',
    });
  });

  it('needs every name to be different, ignoring case', () => {
    expect(validateTeams(['Red Foxes', 'Blue Herons', 'red foxes ', 'BLUE HERONS'])).toEqual({
      teams: null,
      rows: [
        '',
        '',
        'Team 1 has the same name. Each team needs its own, whatever the capitals.',
        'Team 2 has the same name. Each team needs its own, whatever the capitals.',
      ],
      error: '',
    });
  });
});

describe('validatePublish', () => {
  const form = { name: ' Chiswick river hunt ', start: '2026-10-11T10:00', end: '2026-10-11T12:00', teams: ['Red Foxes', 'Blue Herons'] };

  it('turns a valid form into the body the game-server expects', () => {
    expect(validatePublish(form, 60)).toEqual({
      request: {
        name: 'Chiswick river hunt',
        'start-time': '2026-10-11T10:00:00+01:00',
        'end-time': '2026-10-11T12:00:00+01:00',
        teams: ['Red Foxes', 'Blue Herons'],
      },
      errors: {},
      teamRows: ['', ''],
    });
  });

  it('needs a name of 1 to 100 characters', () => {
    expect(validatePublish({ ...form, name: '  ' }, 60).errors).toEqual({ name: "Enter the hunt's name." });
    expect(validatePublish({ ...form, name: 'x'.repeat(101) }, 60).errors).toEqual({
      name: 'Keep the name to 100 characters or fewer.',
    });
    expect(validatePublish({ ...form, name: 'x'.repeat(100) }, 60).request).not.toBeNull();
  });

  it('needs a start, and an end after it', () => {
    expect(validatePublish({ ...form, start: '', end: '' }, 60)).toMatchObject({
      request: null,
      errors: { start: 'Choose when it starts.', end: 'Choose when it ends.' },
    });
    expect(validatePublish({ ...form, end: '2026-10-11T10:00' }, 60).errors).toEqual({ end: 'It must end after it starts.' });
    expect(validatePublish({ ...form, end: '2026-10-11T09:00' }, 60).errors).toEqual({ end: 'It must end after it starts.' });
  });

  it('checks the teams, row by row', () => {
    expect(validatePublish({ ...form, teams: ['Red Foxes', 'RED FOXES'] }, 60)).toMatchObject({
      request: null,
      errors: {},
      teamRows: ['', 'Team 1 has the same name. Each team needs its own, whatever the capitals.'],
    });
    expect(validatePublish({ ...form, teams: [] }, 60)).toMatchObject({ request: null, errors: { teams: 'Add at least one team.' } });
  });
});

describe('a publication', () => {
  const body = {
    session: '33333333-3333-4333-8333-333333333333',
    name: 'Chiswick river hunt',
    'moderator-code': 'MOD-7Q2KX9P4H3MN',
    teams: [
      { name: 'Red Foxes', 'join-code': 'FOX-7Q2K' },
      { name: 'Blue Herons', 'join-code': 'HERON-4M8P' },
    ],
  };

  it('has the session, the moderator link and code, and each team with its join code', () => {
    expect(publicationView(body)).toEqual({
      session: body.session,
      name: 'Chiswick river hunt',
      moderatorPath: `/moderator?session=${body.session}`,
      moderatorCode: 'MOD-7Q2KX9P4H3MN',
      teams: [
        { name: 'Red Foxes', code: 'FOX-7Q2K' },
        { name: 'Blue Herons', code: 'HERON-4M8P' },
      ],
    });
  });

  it('leaves out a team without a code', () => {
    expect(publicationView({ ...body, teams: [{ name: 'Red Foxes' }, null, ...body.teams.slice(1)] })?.teams).toEqual([
      { name: 'Blue Herons', code: 'HERON-4M8P' },
    ]);
  });

  it.each([null, {}, { ...body, session: 'not-a-uuid' }, { ...body, session: `${body.session}&x=1` }])('is null for %j', (value) => {
    expect(publicationView(value)).toBeNull();
  });
});

describe('editError', () => {
  it("sorts a 422's problems under their fields", () => {
    const problems = [{ code: 'names_place', position: 1, message: 'Checkpoint 1\'s clue gives the place away ("Lantern")' }];

    expect(editError(422, { detail: 'draft problems', problems })).toMatchObject({
      message: '',
      problems: { clue: ['Checkpoint 1\'s clue gives the place away ("Lantern")'], card: [] },
      reload: false,
    });
  });

  it('says a 422 without problems was not accepted, with the reasons', () => {
    expect(editError(422, { detail: [{ loc: ['body'], msg: "Value error, can't be null: clue" }] })).toMatchObject({
      message: "The game-server didn't accept this change. can't be null: clue",
      problems: null,
    });
  });

  it('reads the draft again on a 409 or a 404', () => {
    expect(editError(409, { detail: "draft can't be edited", code: 'draft_not_editable' })).toMatchObject({
      message: "This draft can't be edited any more: it may have been published.",
      reload: true,
    });
    expect(editError(404, { detail: 'unknown checkpoint' })).toMatchObject({
      message: "This checkpoint isn't in the draft any more.",
      reload: true,
    });
    expect(editError(404, { detail: 'unknown draft' })).toMatchObject({
      message: 'No draft with this id. Check the link.',
      reload: true,
    });
  });

  it('asks for the key on a 401, and says when there is no connection', () => {
    expect(editError(401, { code: 'organiser_unauthorised' })).toMatchObject({ askForKey: true });
    expect(editError(0, null)).toMatchObject({ offline: true, message: 'No connection to the game server.' });
  });
});

describe('publishError', () => {
  it("shows a 409 with the server's detail, and reads the draft again", () => {
    expect(publishError(409, { detail: 'checkpoint(s) 2 still pending review', code: 'draft_not_ready' })).toMatchObject({
      message: "The game-server can't publish this draft yet. checkpoint(s) 2 still pending review.",
      lines: [],
      reload: true,
    });
  });

  it("shows a 422's problems, one per line", () => {
    const problems = [
      { code: 'too_close', position: 2, message: 'Checkpoints 2 and 4 are 90 m apart; keep them at least 150 m apart' },
      { code: 'route_too_long', position: null, message: 'The route is 3.4 km round; keep it within 3 km' },
    ];

    expect(publishError(422, { detail: 'draft problems', problems })).toMatchObject({
      message: 'The accepted checkpoints break a rule:',
      lines: [
        'Checkpoint 2: Checkpoints 2 and 4 are 90 m apart; keep them at least 150 m apart',
        'The route is 3.4 km round; keep it within 3 km',
      ],
    });
  });

  it("shows a 422's validation errors, one per line", () => {
    const detail = [
      { type: 'string_too_long', loc: ['body', 'teams', 1], msg: 'String should have at most 40 characters' },
      { type: 'value_error', loc: ['body'], msg: 'Value error, end-time must be after start-time' },
    ];

    expect(publishError(422, { detail })).toMatchObject({
      message: "The game-server didn't accept the form:",
      lines: ['teams 2: String should have at most 40 characters', 'end-time must be after start-time'],
    });
  });

  it('asks for the key on a 401, and says when there is no connection', () => {
    expect(publishError(401, null)).toMatchObject({ askForKey: true });
    expect(publishError(504, null)).toMatchObject({ offline: true });
  });
});

describe('publicationError', () => {
  it('says when the draft has no publication', () => {
    expect(publicationError(404, { detail: 'not published' }).message).toBe('The game-server has no publication for this draft.');
    expect(publicationError(404, { detail: 'unknown draft' }).message).toBe('No draft with this id. Check the link.');
  });

  it("says the codes can't be shown without a connection", () => {
    expect(publicationError(0, null)).toMatchObject({
      offline: true,
      message: "No connection to the game server: the codes can't be shown.",
    });
  });
});

describe('designerError', () => {
  it('asks for the key again on a 401', () => {
    expect(designerError(401, { detail: 'organiser key required', code: 'organiser_unauthorised' })).toEqual({
      message: "That organiser key isn't right.",
      askForKey: true,
      offline: false,
      busy: false,
    });
  });

  it('says a design is already running on a 409 designer_busy', () => {
    expect(designerError(409, { detail: 'a design is already running', code: 'designer_busy' })).toEqual({
      message: 'A design is already running.',
      askForKey: false,
      offline: false,
      busy: true,
    });
  });

  it("says the designer isn't switched on on a 503 designer_disabled", () => {
    expect(designerError(503, { detail: 'the hunt designer is not available', code: 'designer_disabled' })).toEqual({
      message: "The hunt designer isn't switched on on the game-server.",
      askForKey: false,
      offline: false,
      busy: false,
    });
  });

  it.each([
    [404, { detail: 'unknown draft' }, 'No draft with this id. Check the link.'],
    [400, { error: 'draft must be a valid UUID' }, 'The link has no valid draft id.'],
    [422, { detail: [] }, "The game-server didn't accept this design. Check the fields and try again."],
    [500, null, 'Something went wrong (error 500).'],
  ])('explains a %s', (status, body, message) => {
    expect(designerError(status, body)).toMatchObject({ message, askForKey: false, offline: false, busy: false });
  });

  it.each([0, 502, 503, 504])('treats %s as no connection', (status) => {
    expect(designerError(status, { error: 'Could not reach the game server: connect ECONNREFUSED' })).toEqual({
      message: 'No connection to the game server.',
      askForKey: false,
      offline: true,
      busy: false,
    });
  });

  it('never repeats what the server said, so the key can never show', () => {
    const key = 'organiser-key-that-must-never-show';
    for (const status of [0, 400, 401, 404, 409, 422, 500, 502, 503, 504]) {
      expect(designerError(status, { detail: key, error: key, code: key }).message).not.toContain(key);
    }
  });
});
