import { describe, expect, it } from 'vitest';
import {
  checkpointRows,
  costWords,
  designerError,
  draftListLine,
  elapsedLine,
  FAILURE_TEXT,
  failureText,
  formFromRequest,
  isDraftId,
  isRunning,
  LIMITS,
  newestFirst,
  problemLines,
  progressLines,
  readDraftId,
  requestLine,
  runLine,
  runningDraftId,
  statusLabel,
  STEP_LABELS,
  stepLabel,
  validateDesign,
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

  it('shows how long a finished run took and what it cost', () => {
    expect(runLine(ready)).toBe('Took 3:41 · cost $0.42');
    expect(runLine({ ...ready, run: { ...ready.run, 'duration-ms': null } })).toBe('Took 3:41 · cost $0.42');
    expect(runLine(running)).toBe('');
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
