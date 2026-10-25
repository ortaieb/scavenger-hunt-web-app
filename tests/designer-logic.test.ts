import { describe, expect, it } from 'vitest';
import {
  acceptedLoopM,
  addCheckpoint,
  blankCheckpoint,
  BUILDER_LIMITS,
  builderError,
  builderFromDraft,
  builderLoopLine,
  builderMap,
  BY_HAND_WORDS,
  areaBox,
  changedFields,
  charCount,
  CHECKPOINT_LIMITS,
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
  isManual,
  isRunning,
  kindWords,
  LIMITS,
  localToIso,
  loopLatLngs,
  locationErrorText,
  loopM,
  mapBounds,
  MARKER_STYLES,
  markerStyle,
  MIN_ACCEPTED,
  moveCheckpoint,
  newBuilder,
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
  removeCheckpoint,
  requestLine,
  REVIEW_WORDS,
  reviewCards,
  reviewCounts,
  reviewOf,
  reviewSummary,
  routeMap,
  runLine,
  runningDraftId,
  statusLabel,
  STEP_LABELS,
  stepLabel,
  toPin,
  validateBuilder,
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
      byHand: false,
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

  it('says how long the loop of the accepted is, against the walk asked for', () => {
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
    });
    expect(reviewSummary({ ...draft, checkpoints: [placed(1, 0, 'pending')] })).toMatchObject({
      loop: 'Accept checkpoints to see the loop',
    });
  });
});

describe('the route map', () => {
  const box = { south: 51.48, west: -0.27, north: 51.5, east: -0.24 };
  const placed = (position: number, name: string, lat: number, long: number, review: string) => ({
    ...checkpoint(position, name),
    place: { ...checkpoint(position, name).place, location: { lat, long } },
    review,
  });
  const reviewed = {
    ...ready,
    area: { name: 'Chiswick, London, England', bbox: box, clipped: false },
    checkpoints: [
      placed(3, "Brewers' Arch", 51.495, -0.25, 'pending'),
      placed(1, 'Lantern Gate', 51.49, -0.26, 'accepted'),
      placed(2, 'Riverside Bench', 51.485, -0.255, 'rejected'),
    ],
  };

  it('gives each review its words and style, and leaves only the rejected out of the loop', () => {
    expect(markerStyle('pending')).toEqual({ words: 'To review', className: 'route-marker route-marker--pending', inLoop: true });
    expect(markerStyle('accepted')).toEqual({
      words: 'Accepted',
      className: 'route-marker route-marker--accepted',
      inLoop: true,
    });
    expect(markerStyle('rejected')).toEqual({
      words: 'Rejected',
      className: 'route-marker route-marker--rejected',
      inLoop: false,
    });
    // Anything else is still to review.
    expect(markerStyle(undefined)).toBe(MARKER_STYLES.pending);
    expect(markerStyle('maybe')).toBe(MARKER_STYLES.pending);
  });

  it("reads the area's box, when it's a usable one", () => {
    expect(areaBox(reviewed)).toEqual(box);
    expect(areaBox({ ...reviewed, area: { name: 'x', clipped: false } })).toBeNull();
    expect(areaBox({ ...reviewed, area: null })).toBeNull();
    expect(areaBox({ ...reviewed, area: { name: 'x', bbox: { ...box, north: Number.NaN } } })).toBeNull();
    expect(areaBox({ ...reviewed, area: { name: 'x', bbox: { ...box, south: 51.6 } } })).toBeNull();
    expect(areaBox({ ...reviewed, area: { name: 'x', bbox: { ...box, west: -0.2 } } })).toBeNull();
    expect(areaBox(undefined)).toBeNull();
  });

  it('fits the view to the box and every place, even one outside it', () => {
    expect(mapBounds(box, [{ lat: 51.49, long: -0.26 }])).toEqual([
      [51.48, -0.27],
      [51.5, -0.24],
    ]);
    // A place just over the edge, within the server's margin.
    expect(mapBounds(box, [{ lat: 51.5005, long: -0.2705 }])).toEqual([
      [51.48, -0.2705],
      [51.5005, -0.24],
    ]);
    expect(
      mapBounds(null, [
        { lat: 51.49, long: -0.26 },
        { lat: 51.495, long: -0.25 },
      ]),
    ).toEqual([
      [51.49, -0.26],
      [51.495, -0.25],
    ]);
    expect(mapBounds(box, [])).toEqual([
      [51.48, -0.27],
      [51.5, -0.24],
    ]);
    expect(mapBounds(null, [{ lat: Number.NaN, long: 0 }])).toBeNull();
    expect(mapBounds(null, [])).toBeNull();
  });

  it('closes the loop back to the first place, leaving out the rejected', () => {
    const at = (lat: number, long: number, review: string) => ({ lat, long, review });

    expect(loopLatLngs([at(1, 1, 'accepted'), at(2, 2, 'rejected'), at(3, 3, 'pending'), at(4, 4, 'accepted')])).toEqual([
      [1, 1],
      [3, 3],
      [4, 4],
      [1, 1],
    ]);
    // Two places make a there-and-back, as the server measures it.
    expect(loopLatLngs([at(1, 1, 'pending'), at(2, 2, 'accepted')])).toEqual([
      [1, 1],
      [2, 2],
      [1, 1],
    ]);
    expect(loopLatLngs([at(1, 1, 'accepted'), at(2, 2, 'rejected')])).toEqual([]);
    expect(loopLatLngs([])).toEqual([]);
  });

  it("draws a ready draft's box, its checkpoints in route order styled by review, and the loop without the rejected", () => {
    expect(routeMap(reviewed)).toEqual({
      box,
      markers: [
        {
          position: 1,
          name: 'Lantern Gate',
          review: 'accepted',
          title: '1. Lantern Gate: Accepted',
          className: 'route-marker route-marker--accepted',
          lat: 51.49,
          long: -0.26,
        },
        {
          position: 2,
          name: 'Riverside Bench',
          review: 'rejected',
          title: '2. Riverside Bench: Rejected',
          className: 'route-marker route-marker--rejected',
          lat: 51.485,
          long: -0.255,
        },
        {
          position: 3,
          name: "Brewers' Arch",
          review: 'pending',
          title: "3. Brewers' Arch: To review",
          className: 'route-marker route-marker--pending',
          lat: 51.495,
          long: -0.25,
        },
      ],
      loop: [
        [51.49, -0.26],
        [51.495, -0.25],
        [51.49, -0.26],
      ],
      bounds: [
        [51.48, -0.27],
        [51.5, -0.24],
      ],
    });
  });

  it('leaves out a checkpoint with no place to draw', () => {
    const view = routeMap({
      ...reviewed,
      checkpoints: [...reviewed.checkpoints, { ...checkpoint(4, 'Nowhere'), place: { osm: 'node/4', name: 'Nowhere' } }],
    });

    expect(view?.markers.map((marker) => marker.position)).toEqual([1, 2, 3]);
  });

  it("draws a published draft's accepted checkpoints only, numbered 1… as the session numbers them", () => {
    const published = {
      ...reviewed,
      status: 'published',
      checkpoints: [
        placed(1, 'Lantern Gate', 51.49, -0.26, 'accepted'),
        placed(2, 'Riverside Bench', 51.485, -0.255, 'rejected'),
        placed(3, "Brewers' Arch", 51.495, -0.25, 'accepted'),
        placed(4, 'Old Mill', 51.497, -0.245, 'accepted'),
      ],
    };
    const view = routeMap(published);

    expect(view?.markers.map(({ position, title, review }) => ({ position, title, review }))).toEqual([
      { position: 1, title: '1. Lantern Gate', review: 'accepted' },
      { position: 2, title: "2. Brewers' Arch", review: 'accepted' },
      { position: 3, title: '3. Old Mill', review: 'accepted' },
    ]);
    expect(view?.loop).toHaveLength(4);
  });

  it('draws nothing for a draft that is running or failed', () => {
    expect(routeMap(running)).toBeNull();
    expect(routeMap(failed('deadline'))).toBeNull();
    expect(routeMap(undefined)).toBeNull();
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

  it('has the session, the moderator link, and each team with its join code, and not the moderator code', () => {
    expect(publicationView(body)).toEqual({
      session: body.session,
      name: 'Chiswick river hunt',
      moderatorPath: `/moderator?session=${body.session}`,
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
    expect(editError(401, { code: 'organiser_unauthorised' })).toMatchObject({ signInAgain: true });
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
    expect(publishError(401, null)).toMatchObject({ signInAgain: true });
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
  it('asks to sign in again on a 401', () => {
    expect(designerError(401, { detail: 'unauthorised', code: 'unauthorised' })).toEqual({
      message: "Your sign-in wasn't accepted. Sign out from the account menu and sign in again.",
      signInAgain: true,
      forbidden: false,
      offline: false,
      busy: false,
    });
  });

  it("says the account isn't an organiser on a 403", () => {
    expect(designerError(403, { detail: 'forbidden', code: 'forbidden' })).toEqual({
      message: "This account isn't an organiser.",
      signInAgain: false,
      forbidden: true,
      offline: false,
      busy: false,
    });
  });

  it('says a design is already running on a 409 designer_busy', () => {
    expect(designerError(409, { detail: 'a design is already running', code: 'designer_busy' })).toEqual({
      message: 'A design is already running.',
      signInAgain: false,
      forbidden: false,
      offline: false,
      busy: true,
    });
  });

  it("says the designer isn't switched on on a 503 designer_disabled", () => {
    expect(designerError(503, { detail: 'the hunt designer is not available', code: 'designer_disabled' })).toEqual({
      message: "The hunt designer isn't switched on on the game-server.",
      signInAgain: false,
      forbidden: false,
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
    expect(designerError(status, body)).toMatchObject({ message, signInAgain: false, offline: false, busy: false });
  });

  it.each([0, 502, 503, 504])('treats %s as no connection', (status) => {
    expect(designerError(status, { error: 'Could not reach the game server: connect ECONNREFUSED' })).toEqual({
      message: 'No connection to the game server.',
      signInAgain: false,
      forbidden: false,
      offline: true,
      busy: false,
    });
  });

  it('never repeats what the server said, so a token can never show', () => {
    const key = 'organiser-key-that-must-never-show';
    for (const status of [0, 400, 401, 403, 404, 409, 422, 500, 502, 503, 504]) {
      expect(designerError(status, { detail: key, error: key, code: key }).message).not.toContain(key);
    }
  });
});

describe('a hunt placed by hand', () => {
  const manual = {
    ...ready,
    run: { runner: 'manual', model: null, turns: 0, 'cost-usd': 0, 'duration-ms': null, error: null },
    checkpoints: [1, 2, 3].map((position) => ({
      ...checkpoint(position, `Pin ${position}`),
      place: { osm: `manual/${position}`, name: `Pin ${position}`, kind: 'manual', location: { lat: 51.48 + position / 1000, long: -0.25 } },
      rationale: '',
    })),
  };

  it('is told apart by its runner', () => {
    expect(isManual(manual)).toBe(true);
    expect(isManual(ready)).toBe(false);
    expect(isManual(null)).toBe(false);
  });

  it('says it was placed by hand in place of the run, and not what it cost', () => {
    expect(runLine(manual)).toBe(BY_HAND_WORDS);
    expect(BY_HAND_WORDS).toBe('Placed by hand');
    expect(runLine({ ...manual, run: { ...manual.run, 'cost-usd': 0.42 } })).toBe('Placed by hand');
  });

  it('says so in the drafts list, from the list own runner field, with no cost', () => {
    const item = { id: DRAFT, status: 'ready', area: 'A', theme: 'T', 'created-at': '2026-10-08T09:00:00Z', 'cost-usd': 0, runner: 'manual' };

    expect(draftListLine(item)).toMatchObject({ byHand: true, cost: '' });
    expect(draftListLine({ ...item, runner: 'agent', 'cost-usd': 0.42 })).toMatchObject({ byHand: false, cost: '$0.42' });
    expect(draftListLine({ ...item, runner: undefined })).toMatchObject({ byHand: false });
  });

  it('has cards with no rationale, no OpenStreetMap link and no kind', () => {
    for (const card of reviewCards(manual)) {
      expect(card).toMatchObject({ rationale: '', osmUrl: null, kind: '' });
    }
    expect(reviewCards(manual).map((card) => card.name)).toEqual(['Pin 1', 'Pin 2', 'Pin 3']);
  });
});

describe('the hunt builder', () => {
  const pinned = (name: string, lat: number, long: number): ReturnType<typeof blankCheckpoint> => ({
    ...blankCheckpoint(),
    name,
    clue: `Clue for ${name}`,
    scene: `Scene for ${name}`,
    pose: `Pose for ${name}`,
    location: { lat, long },
  });
  /** A builder that's ready to send: three pins about 560 m apart. */
  const complete = () => ({
    area: ' Chiswick, London ',
    theme: 'Riverside pubs',
    maxWalkKm: '10',
    checkpoints: [pinned(' The boathouse ', 51.48, -0.25), pinned('The bridge', 51.485, -0.25), pinned('The pier', 51.485, -0.243)],
  });

  describe('a new builder', () => {
    it('starts with the fewest checkpoints, the longest walk and a 30 m radius', () => {
      const builder = newBuilder();

      expect(builder).toMatchObject({ area: '', theme: '', maxWalkKm: '10' });
      expect(builder.checkpoints).toHaveLength(3);
      expect(builder.checkpoints[0]).toEqual({ name: '', clue: '', scene: '', pose: '', proximity: '30', location: null });
    });

    it('gives every checkpoint of its own, not one shared object', () => {
      const [first, second] = newBuilder().checkpoints;

      expect(first).not.toBe(second);
    });
  });

  describe('adding, removing and moving checkpoints', () => {
    const list = ['a', 'b', 'c'].map((name) => ({ ...blankCheckpoint(), name }));
    const names = (checkpoints: { name: string }[]) => checkpoints.map((checkpoint) => checkpoint.name);

    it('adds a blank one at the end, up to 8', () => {
      const added = addCheckpoint(list);

      expect(added).toHaveLength(4);
      expect(added[3]).toEqual(blankCheckpoint());
      expect(names(list)).toEqual(['a', 'b', 'c']);
      const full = Array.from({ length: BUILDER_LIMITS.checkpoints.max }, blankCheckpoint);
      expect(addCheckpoint(full)).toBe(full);
    });

    it('removes one, down to 3', () => {
      const four = [...list, { ...blankCheckpoint(), name: 'd' }];

      expect(names(removeCheckpoint(four, 1))).toEqual(['a', 'c', 'd']);
      expect(removeCheckpoint(list, 1)).toBe(list);
      expect(removeCheckpoint(four, 9)).toBe(four);
      expect(removeCheckpoint(four, -1)).toBe(four);
    });

    it('moves one up or down the route, and leaves it at either end', () => {
      expect(names(moveCheckpoint(list, 1, -1))).toEqual(['b', 'a', 'c']);
      expect(names(moveCheckpoint(list, 1, 1))).toEqual(['a', 'c', 'b']);
      expect(moveCheckpoint(list, 0, -1)).toBe(list);
      expect(moveCheckpoint(list, 2, 1)).toBe(list);
      expect(names(list)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('a pin', () => {
    it('is rounded to about 10 cm', () => {
      expect(toPin(51.4800004999, -0.2500004999)).toEqual({ lat: 51.48, long: -0.25 });
      expect(toPin(51.12345678, -0.98765432)).toEqual({ lat: 51.123457, long: -0.987654 });
    });

    it.each([
      [190, -170],
      [-190, 170],
      [540, -180],
      [-181, 179],
    ])('brings a longitude of %s back to %s, as a map panned round the world reports it', (long, expected) => {
      expect(toPin(10, long)?.long).toBe(expected);
    });

    it.each([
      [Number.NaN, 0],
      [0, Number.NaN],
      [91, 0],
      [-90.5, 0],
      [Number.POSITIVE_INFINITY, 0],
    ])('is not a place on Earth: %s, %s', (lat, long) => {
      expect(toPin(lat, long)).toBeNull();
    });
  });

  describe('validateBuilder', () => {
    it("builds the request: trimmed, in route order, the radius as a number and the walk's own key", () => {
      const { request: built, errors } = validateBuilder(complete());

      expect(errors.cards.every((card) => Object.keys(card).length === 0)).toBe(true);
      expect(built).toEqual({
        area: 'Chiswick, London',
        theme: 'Riverside pubs',
        'max-walk-km': 10,
        checkpoints: [
          { name: 'The boathouse', location: { lat: 51.48, long: -0.25 }, clue: 'Clue for  The boathouse', scene: 'Scene for  The boathouse', pose: 'Pose for  The boathouse', proximity: 30 },
          { name: 'The bridge', location: { lat: 51.485, long: -0.25 }, clue: 'Clue for The bridge', scene: 'Scene for The bridge', pose: 'Pose for The bridge', proximity: 30 },
          { name: 'The pier', location: { lat: 51.485, long: -0.243 }, clue: 'Clue for The pier', scene: 'Scene for The pier', pose: 'Pose for The pier', proximity: 30 },
        ],
      });
    });

    it('holds area and theme to the same limits as a designed hunt', () => {
      const { request: built, errors } = validateBuilder({ ...complete(), area: 'ab', theme: 'x'.repeat(201) });

      expect(built).toBeNull();
      expect(errors.area).toBe('Enter the area: at least 3 characters.');
      expect(errors.theme).toBe('Keep the theme to 200 characters or fewer.');
    });

    it.each(['0.4', '10.5', '', 'abc', '-1'])('refuses a longest walk of %j', (maxWalkKm) => {
      const { request: built, errors } = validateBuilder({ ...complete(), maxWalkKm });

      expect(built).toBeNull();
      expect(errors.maxWalkKm).toBe('Choose a walk from 0.5 to 10 km.');
    });

    it.each(['0.5', '3', '10'])('accepts a longest walk of %s', (maxWalkKm) => {
      expect(validateBuilder({ ...complete(), maxWalkKm }).request).not.toBeNull();
    });

    it.each([2, 9])('refuses %s checkpoints', (count) => {
      const base = complete().checkpoints;
      const checkpoints = Array.from({ length: count }, (_, index) => base[index % 3]!);

      const { request: built, errors } = validateBuilder({ ...complete(), checkpoints });

      expect(built).toBeNull();
      expect(errors.checkpoints).toBe('A hunt has 3 to 8 checkpoints.');
    });

    it("holds each checkpoint's text and radius to the review limits, each error under its own field", () => {
      const builder = complete();
      builder.checkpoints[0] = {
        ...builder.checkpoints[0]!,
        name: ' ',
        clue: 'x'.repeat(CHECKPOINT_LIMITS.clue.max + 1),
        scene: '   ',
        pose: '',
        proximity: '19',
        location: null,
      };
      builder.checkpoints[1] = { ...builder.checkpoints[1]!, name: 'n'.repeat(101), proximity: '100.5' };

      const { request: built, errors } = validateBuilder(builder);

      expect(built).toBeNull();
      expect(errors.cards[0]).toEqual({
        name: "Enter the place's name.",
        clue: 'Keep the clue to 300 characters or fewer.',
        scene: "The scene can't be empty.",
        pose: "The pose can't be empty.",
        proximity: 'Choose a whole number of metres from 20 to 100.',
        location: 'Place its pin on the map.',
      });
      expect(errors.cards[1]).toEqual({
        name: 'Keep the name to 100 characters or fewer.',
        proximity: 'Choose a whole number of metres from 20 to 100.',
      });
      expect(errors.cards[2]).toEqual({});
    });

    it.each([
      ['20', true],
      ['100', true],
      ['19', false],
      ['101', false],
    ])('takes a radius of %s: %s', (proximity, ok) => {
      const builder = complete();
      builder.checkpoints[2] = { ...builder.checkpoints[2]!, proximity };

      expect(validateBuilder(builder).request !== null).toBe(ok);
    });

    it('counts an emoji once, as the game-server does', () => {
      const builder = complete();
      builder.checkpoints[0] = { ...builder.checkpoints[0]!, pose: '🧭'.repeat(CHECKPOINT_LIMITS.pose.max) };

      expect(validateBuilder(builder).request).not.toBeNull();
    });

    it('does not send a pin the page made up: the pin must be a real position', () => {
      const builder = complete();
      builder.checkpoints[0] = { ...builder.checkpoints[0]!, location: { lat: Number.NaN, long: 0 } };

      expect(validateBuilder(builder).errors.cards[0]).toEqual({ location: 'Place its pin on the map.' });
    });
  });

  describe('the loop, live', () => {
    it('waits for two pins', () => {
      const builder = newBuilder();
      expect(builderLoopLine(builder)).toEqual({ text: 'Place two pins to see the loop.', over: false });
      builder.checkpoints[0] = pinned('a', 51.48, -0.25);
      expect(builderLoopLine(builder).over).toBe(false);
      expect(builderLoopLine(builder).text).toBe('Place two pins to see the loop.');
    });

    it('is the closed loop through the pins placed so far, against the longest walk', () => {
      const builder = complete();
      const metres = loopM(builder.checkpoints.map((checkpoint) => checkpoint.location!));

      expect(builderLoopLine(builder)).toEqual({ text: `Loop: ${distanceWords(metres)} (longest walk 10 km)`, over: false });
      builder.checkpoints[2] = { ...builder.checkpoints[2]!, location: null };
      const partial = loopM([builder.checkpoints[0]!.location!, builder.checkpoints[1]!.location!]);
      expect(builderLoopLine(builder).text).toBe(`Loop so far: ${distanceWords(partial)} (longest walk 10 km)`);
    });

    it('says in words when it is over the longest walk', () => {
      const line = builderLoopLine({ ...complete(), maxWalkKm: '1' });

      expect(line.over).toBe(true);
      expect(line.text).toMatch(/\(longest walk 1 km\): too long$/);
    });

    it('does not guess a limit from a walk that is not a number', () => {
      const line = builderLoopLine({ ...complete(), maxWalkKm: '' });

      expect(line.over).toBe(false);
      expect(line.text).not.toContain('longest walk');
    });
  });

  describe('what the map draws', () => {
    it('is a numbered marker for each pin placed, with the number of its card, and the loop through them', () => {
      const builder = complete();
      builder.checkpoints[1] = { ...builder.checkpoints[1]!, location: null };

      const view = builderMap(builder, 2);

      expect(view.markers.map((marker) => [marker.index, marker.position, marker.title])).toEqual([
        [0, 1, '1. The boathouse'],
        [2, 3, '3. The pier (selected)'],
      ]);
      expect(view.loop).toEqual([
        [51.48, -0.25],
        [51.485, -0.243],
        [51.48, -0.25],
      ]);
      expect(view.bounds).toEqual([
        [51.48, -0.25],
        [51.485, -0.243],
      ]);
    });

    it('marks the selected pin, and names one with no name yet', () => {
      const builder = complete();
      builder.checkpoints[0] = { ...builder.checkpoints[0]!, name: '' };

      const [first, second] = builderMap(builder, 0).markers;

      expect(first).toMatchObject({ title: '1. Unnamed place (selected)', className: 'route-marker route-marker--pending route-marker--selected' });
      expect(second!.className).toBe('route-marker route-marker--pending');
    });

    it('has nothing to fit with no pins', () => {
      expect(builderMap(newBuilder(), 0)).toEqual({ markers: [], loop: [], bounds: null });
    });
  });

  describe('Edit in builder', () => {
    const manual = {
      ...ready,
      request: { area: 'Chiswick, London', theme: 'Riverside pubs', checkpoints: 3, 'max-walk-km': 4 },
      run: { runner: 'manual' },
      checkpoints: [
        { ...checkpoint(2, 'The bridge'), proximity: 55, place: { ...checkpoint(2, '').place, name: 'The bridge', location: { lat: 51.485, long: -0.25 } } },
        { ...checkpoint(1, 'The boathouse'), place: { ...checkpoint(1, '').place, name: 'The boathouse', location: { lat: 51.48, long: -0.25 } } },
        checkpoint(3, 'The pier'),
      ],
    };

    it('fills a builder from the draft, in route order, with its pins and the radius it has', () => {
      const builder = builderFromDraft(manual);

      expect(builder).toMatchObject({ area: 'Chiswick, London', theme: 'Riverside pubs', maxWalkKm: '4' });
      expect(builder.checkpoints.map((c) => c.name)).toEqual(['The boathouse', 'The bridge', 'The pier']);
      expect(builder.checkpoints[0]).toEqual({
        name: 'The boathouse',
        clue: 'Clue 1',
        scene: 'Scene 1',
        pose: 'Pose 1',
        proximity: '40',
        location: { lat: 51.48, long: -0.25 },
      });
      expect(builder.checkpoints[1]!.proximity).toBe('55');
    });

    it('passes validation as it stands, so it can be sent as a new draft', () => {
      expect(validateBuilder(builderFromDraft(manual)).request).not.toBeNull();
    });

    it('falls back to a blank builder for anything missing', () => {
      expect(builderFromDraft(null)).toEqual(newBuilder());
      expect(builderFromDraft({ ...manual, request: undefined as never, checkpoints: [] }).maxWalkKm).toBe('10');
    });
  });

  describe('why the position could not be had', () => {
    it.each([
      [0, /can't share its location/],
      [1, /refused/],
      [2, /isn't available/],
      [3, /too long/],
      [99, /Couldn't get your location/],
    ])('says what to do for code %s', (code, words) => {
      expect(locationErrorText(code)).toMatch(words);
      expect(locationErrorText(code)).toMatch(/map/);
    });
  });

  describe('builderError', () => {
    it('puts a 422\'s problems on their checkpoint, under the field each is about, and the rest on the hunt', () => {
      const error = builderError(
        422,
        {
          detail: 'draft problems',
          problems: [
            { code: 'names_place', position: 2, message: 'Checkpoint 2\'s clue gives the place away ("bridge"); describe it without its name' },
            { code: 'too_close', position: 3, message: 'Checkpoints 2 and 3 are 90 m apart; keep them at least 150 m apart' },
            { code: 'route_too_long', position: null, message: 'The loop is 12 km; keep it to 10 km' },
            { code: 'bad_proximity', position: 9, message: 'Checkpoint 9 is not one of yours' },
          ],
        },
        3,
      );

      expect(error.lines).toEqual(['The loop is 12 km; keep it to 10 km', 'Checkpoint 9: Checkpoint 9 is not one of yours']);
      expect(error.message).toBe("The game-server didn't accept this hunt:");
      expect(error.cards[0]).toEqual({ clue: [], pose: [], scene: [], proximity: [], card: [] });
      expect(error.cards[1]!.clue).toEqual(['Checkpoint 2\'s clue gives the place away ("bridge"); describe it without its name']);
      expect(error.cards[2]!.card).toEqual(['Checkpoints 2 and 3 are 90 m apart; keep them at least 150 m apart']);
    });

    it('points at the cards when every problem is on one', () => {
      const error = builderError(422, { detail: 'draft problems', problems: [{ code: 'bad_proximity', position: 1, message: 'x' }] }, 3);

      expect(error.lines).toEqual([]);
      expect(error.message).toMatch(/see the notes on each/);
      expect(error.cards[0]!.proximity).toEqual(['x']);
    });

    it("lists a validation error's place and message, when the body has no problems", () => {
      const error = builderError(
        422,
        { detail: [{ type: 'missing', loc: ['body', 'checkpoints', 0, 'name'], msg: 'Field required' }] },
        3,
      );

      expect(error.lines).toEqual(['checkpoints 1 name: Field required']);
    });

    it.each([
      [401, { signInAgain: true }],
      [403, { forbidden: true }],
      [0, { offline: true }],
      [502, { offline: true }],
    ])('is a %s: the same answer as everywhere else on the page', (status, flags) => {
      expect(builderError(status, null, 3)).toMatchObject({ ...flags, lines: [] });
    });

    it('says what went wrong for an error it does not know', () => {
      expect(builderError(500, null, 3).message).toBe('Something went wrong (error 500).');
    });
  });
});
