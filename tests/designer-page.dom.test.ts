// @vitest-environment happy-dom
//
// The hunt designer page (issues #59, #60, #61 and #78), run in a DOM against a
// stub of the game-server's designer API behind this app's relays: the
// page's own designer.js, with fetch answered in memory, and its map drawn by
// the same Leaflet build /vendor/leaflet/ serves. The relays themselves are
// tested in app.test.ts. Type-checked with the DOM's types by
// tsconfig.dom.json.
//
// The page signs in with an account (issue #67): authorised-fetch.js, which
// loads Clerk and adds the session token, is replaced by a stand-in that
// sends a token while the test's visitor is signed in. Its own logic is
// tested in relay-auth.test.ts.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const TOKEN = 'clerk-session-token';
const DRAFT = '5b0c7a1e-1111-4111-8111-111111111111';
const FAILED = '5b0c7a1e-2222-4222-8222-222222222222';
const RUNNING = '5b0c7a1e-3333-4333-8333-333333333333';
const SECOND = '5b0c7a1e-4444-4444-8444-444444444444';
const SESSION = '33333333-3333-4333-8333-333333333333';
const MODERATOR_CODE = 'MOD-7Q2KX9P4H3MN';

// What the stand-in for authorised-fetch.js says about the visitor.
const account = vi.hoisted(() => {
  const state: { status: string; token: string } = { status: 'signed-in', token: 'clerk-session-token' };
  return state;
});

vi.mock('../src/public/authorised-fetch.js', () => ({
  accountStatus: () => Promise.resolve(account.status),
  authorisedFetch: (url: string, init: RequestInit = {}) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${account.token}` },
    }),
}));

/** The parts of Leaflet the tests watch. */
interface Leaflet {
  rectangle: (...args: unknown[]) => unknown;
  polyline: (...args: unknown[]) => unknown;
  map: (...args: unknown[]) => unknown;
  marker: (...args: unknown[]) => unknown;
  latLng: (lat: number, lng: number) => unknown;
  Map: { prototype: { fitBounds: (...args: unknown[]) => unknown; panTo: (...args: unknown[]) => unknown } };
}

// The file the page's <script defer src="/vendor/leaflet/leaflet.js"> loads.
// Like that script, it sets window.L.
const leaflet = createRequire(import.meta.url)('leaflet/dist/leaflet.js') as Leaflet;
const setLeaflet = (value: Leaflet | undefined) => {
  (window as unknown as { L?: Leaflet }).L = value;
};

const html = readFileSync(path.join(import.meta.dirname, '..', 'src', 'public', 'designer.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');

type Json = Record<string, unknown>;
interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

const STUB_PROGRESS = [
  { step: 'resolve_area', summary: 'Stub area around a fixed point' },
  { step: 'find_places', summary: '3 candidate places' },
  { step: 'write_clues', summary: '3 clues and challenges written' },
  { step: 'check_draft', summary: 'No problems' },
];

const STUB_CHECKPOINTS = [
  ['Stub Lantern Gate', 'Where old lamps once lit the way in.', 'Point at the lantern'],
  ['Stub Riverside Bench', 'A seat with a view of the water.', 'Sit as if waiting for a boat'],
  ["Stub Brewers' Arch", 'Pass under the curve where barrels once rolled.', 'Roll an invisible barrel'],
].map(([name, clue, pose], index) => ({
  position: index + 1,
  place: {
    osm: `node/900000000${index + 1}`,
    name,
    kind: 'historic=memorial',
    location: { lat: 51.49, long: -0.26 + index * 0.005 },
  },
  clue,
  challenge: { scene: `The ${name} seen from the path.`, pose },
  proximity: 30,
  rationale: 'A fixed stub checkpoint.',
  review: 'pending',
  edited: false,
  original: null,
}));

/** A team's join code, as the game-server draws them: fresh for each publish. */
const joinCode = (name: string) => `${name.split(' ')[0]!.toUpperCase()}-7Q2K`;

/** What this app's relays answer, as far as the page reads it. */
function fakeResponse(status: number, payload: unknown) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'date' ? new Date().toUTCString() : null) },
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

/**
 * The game-server's designer API, as its `stub` runner answers it: a new
 * draft runs, gains one progress step each time it's read, and is then
 * ready with three fixed checkpoints.
 */
function stubGameServer() {
  const calls: Call[] = [];
  const drafts = new Map<string, Json>();
  const publications = new Map<string, Json>();
  const state = {
    token: TOKEN,
    forbidden: false,
    busy: false,
    disabled: false,
    offline: false,
    nextId: DRAFT,
    manualAnswer: null as { status: number; body: unknown } | null,
    publishAnswer: null as { status: number; body: unknown } | null,
    publicationOffline: false,
  };

  const json = fakeResponse;

  const fetch = vi.fn((url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      authorization: headers.authorization,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    if (state.offline) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (call.authorization !== `Bearer ${state.token}`) {
      return Promise.resolve(json(401, { detail: 'unauthorised', code: 'unauthorised' }));
    }
    if (state.forbidden) {
      return Promise.resolve(json(403, { detail: 'forbidden', code: 'forbidden' }));
    }
    if (call.method === 'POST' && url === '/designer/drafts') {
      if (state.disabled) {
        return Promise.resolve(json(503, { detail: 'the hunt designer is not available', code: 'designer_disabled' }));
      }
      if (state.busy || [...drafts.values()].some((draft) => draft.status === 'running')) {
        return Promise.resolve(json(409, { detail: 'a design is already running', code: 'designer_busy' }));
      }
      const id = state.nextId;
      drafts.set(id, {
        id,
        status: 'running',
        request: call.body,
        area: null,
        progress: [],
        checkpoints: [],
        route: null,
        problems: [],
        run: { runner: 'stub', model: null, turns: 0, 'cost-usd': 0, 'duration-ms': null, error: null },
        attribution: '© OpenStreetMap contributors',
        published: null,
        'created-at': new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        'finished-at': null,
      });
      return Promise.resolve(json(202, { id, status: 'running' }));
    }
    if (call.method === 'POST' && url === '/designer/drafts/manual') {
      return Promise.resolve(createManualDraft(call.body as Json));
    }
    if (call.method === 'GET' && url === '/designer/drafts') {
      const list = [...drafts.values()].reverse().map((draft) => ({
        id: draft.id,
        runner: (draft.run as Json).runner,
        status: draft.status,
        area: (draft.request as Json).area,
        theme: (draft.request as Json).theme,
        'created-at': draft['created-at'],
        'finished-at': draft['finished-at'],
        checkpoints: (draft.checkpoints as unknown[]).length,
        'cost-usd': 0,
      }));
      return Promise.resolve(json(200, { drafts: list }));
    }
    const edit = /^\/designer\/drafts\/([^/]+)\/checkpoints\/(\d+)$/.exec(url);
    if (call.method === 'PATCH' && edit) {
      return Promise.resolve(editCheckpoint(decodeURIComponent(edit[1]!), Number(edit[2]), call.body as Json));
    }
    const publish = /^\/designer\/drafts\/([^/]+)\/publish$/.exec(url);
    if (call.method === 'POST' && publish) {
      return Promise.resolve(publishDraft(decodeURIComponent(publish[1]!), call.body as Json));
    }
    const publication = /^\/designer\/drafts\/([^/]+)\/publication$/.exec(url);
    if (call.method === 'GET' && publication) {
      if (state.publicationOffline) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      const draft = drafts.get(decodeURIComponent(publication[1]!));
      const published = draft && publications.get(draft.id as string);
      if (!draft) {
        return Promise.resolve(json(404, { detail: 'unknown draft' }));
      }
      return Promise.resolve(published ? json(200, published) : json(404, { detail: 'not published' }));
    }
    const match = /^\/designer\/drafts\/([^/]+)$/.exec(url);
    if (call.method === 'GET' && match) {
      const draft = drafts.get(decodeURIComponent(match[1]!));
      if (!draft) {
        return Promise.resolve(json(404, { detail: 'unknown draft' }));
      }
      if (draft.status === 'running') {
        const progress = draft.progress as Json[];
        if (progress.length < STUB_PROGRESS.length) {
          progress.push({ at: new Date().toISOString(), ...STUB_PROGRESS[progress.length] });
        } else {
          Object.assign(draft, {
            status: 'ready',
            checkpoints: STUB_CHECKPOINTS.map((checkpoint) => ({ ...checkpoint })),
            route: { 'legs-m': [420, 610, 380], 'loop-m': 1410 },
            run: { runner: 'stub', model: null, turns: 0, 'cost-usd': 0, 'duration-ms': 5000, error: null },
            'finished-at': new Date().toISOString(),
          });
        }
      }
      return Promise.resolve(json(200, draft));
    }
    return Promise.resolve(json(404, { detail: 'Not Found' }));
  });

  /**
   * POST …/manual: a hunt laid out by hand is stored at once as a ready
   * draft, each checkpoint pending, with no rationale and no run.
   */
  function createManualDraft(body: Json) {
    if (state.manualAnswer) {
      return json(state.manualAnswer.status, state.manualAnswer.body);
    }
    const id = state.nextId;
    const sent = body.checkpoints as Json[];
    const lats = sent.map((checkpoint) => (checkpoint.location as Json).lat as number);
    const longs = sent.map((checkpoint) => (checkpoint.location as Json).long as number);
    const draft = {
      id,
      status: 'ready',
      request: { area: body.area, theme: body.theme, checkpoints: sent.length, 'max-walk-km': body['max-walk-km'] },
      area: {
        name: body.area,
        bbox: { south: Math.min(...lats), west: Math.min(...longs), north: Math.max(...lats), east: Math.max(...longs) },
        clipped: false,
      },
      progress: [],
      checkpoints: sent.map((checkpoint, index) => ({
        position: index + 1,
        place: { osm: `manual/${index + 1}`, name: checkpoint.name, kind: 'manual', location: checkpoint.location },
        clue: checkpoint.clue,
        challenge: { scene: checkpoint.scene, pose: checkpoint.pose },
        proximity: checkpoint.proximity,
        rationale: '',
        review: 'pending',
        edited: false,
        original: null,
      })),
      route: { 'legs-m': [], 'loop-m': 1000 },
      problems: [],
      run: { runner: 'manual', model: null, turns: 0, 'cost-usd': 0, 'duration-ms': null, error: null },
      attribution: '',
      published: null,
      'created-at': new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      'finished-at': new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    };
    drafts.set(id, draft);
    return json(201, draft);
  }

  /**
   * PATCH a checkpoint: text edits are held to the naming rule (a word of 5
   * or more letters from the place's name gives it away), and the first
   * edit keeps the agent's text in `original`.
   */
  function editCheckpoint(id: string, position: number, body: Json) {
    const draft = drafts.get(id);
    if (!draft) {
      return json(404, { detail: 'unknown draft' });
    }
    if (draft.status !== 'ready') {
      return json(409, { detail: "draft can't be edited", code: 'draft_not_editable' });
    }
    const checkpoints = draft.checkpoints as Json[];
    const index = checkpoints.findIndex((checkpoint) => checkpoint.position === position);
    if (index < 0) {
      return json(404, { detail: 'unknown checkpoint' });
    }
    const current = checkpoints[index]!;
    const place = current.place as Json;
    const words = (place.name as string).toLowerCase().match(/[a-z]{5,}/g) ?? [];
    const problems = (['clue', 'pose'] as const).flatMap((field) => {
      const text = typeof body[field] === 'string' ? body[field].toLowerCase() : '';
      const found = words.find((word) => text.includes(word));
      return found
        ? [{ code: 'names_place', position, message: `Checkpoint ${position}'s ${field} gives the place away ("${found}"); describe it without its name` }]
        : [];
    });
    if (problems.length > 0) {
      return json(422, { detail: 'draft problems', problems });
    }
    const challenge = current.challenge as Json;
    const values = { clue: current.clue, scene: challenge.scene, pose: challenge.pose, proximity: current.proximity };
    const changed = Object.keys(values).filter((field) => field in body && body[field] !== values[field as keyof typeof values]);
    const updated: Json = {
      ...current,
      clue: body.clue ?? current.clue,
      challenge: { scene: body.scene ?? challenge.scene, pose: body.pose ?? challenge.pose },
      proximity: body.proximity ?? current.proximity,
      review: body.review ?? current.review,
      edited: current.edited === true || changed.length > 0,
      original: changed.length > 0 ? (current.original ?? values) : current.original,
    };
    checkpoints[index] = updated;
    return json(200, updated);
  }

  /** POST …/publish: needs nothing pending and at least 3 accepted. */
  function publishDraft(id: string, body: Json) {
    const draft = drafts.get(id);
    if (!draft) {
      return json(404, { detail: 'unknown draft' });
    }
    if (state.publishAnswer) {
      return json(state.publishAnswer.status, state.publishAnswer.body);
    }
    const checkpoints = draft.checkpoints as Json[];
    const pending = checkpoints.filter((checkpoint) => checkpoint.review === 'pending');
    const accepted = checkpoints.filter((checkpoint) => checkpoint.review === 'accepted');
    const notReady =
      draft.status === 'published'
        ? 'draft is already published'
        : pending.length > 0
          ? `checkpoint(s) ${pending.map((checkpoint) => checkpoint.position as number).join(', ')} still pending review`
          : accepted.length < 3
            ? `${accepted.length} checkpoint(s) accepted; at least 3 are needed`
            : null;
    if (notReady) {
      return json(409, { detail: notReady, code: 'draft_not_ready' });
    }
    const published = {
      session: SESSION,
      name: body.name,
      'moderator-code': MODERATOR_CODE,
      teams: (body.teams as string[]).map((name) => ({ name, 'join-code': joinCode(name) })),
    };
    publications.set(id, published);
    Object.assign(draft, { status: 'published', published: { session: SESSION, at: new Date().toISOString() } });
    return json(201, published);
  }

  const draftReads = () =>
    calls.filter((call) => call.method === 'GET' && /^\/designer\/drafts\/[^/]+$/.test(call.url));
  const posts = () => calls.filter((call) => call.method === 'POST');
  const patches = () => calls.filter((call) => call.method === 'PATCH');

  return { fetch, calls, drafts, publications, state, draftReads, posts, patches };
}

/**
 * A Storage in memory, standing in for the browser's: every write to it can
 * be seen.
 */
class MemoryStorage {
  readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
  }
}

const $ = (id: string) => document.getElementById(id)!;
const text = (id: string) => $(id).textContent?.trim() ?? '';
const input = (id: string) => $(id) as HTMLInputElement;
const visible = (id: string) => {
  for (let node: HTMLElement | null = $(id); node; node = node.parentElement) {
    if (node.hidden) {
      return false;
    }
  }
  return true;
};
/** Each list item's text, its parts joined by spaces. */
const items = (id: string) =>
  [...$(id).querySelectorAll('li')].map((li) =>
    [...li.querySelectorAll('*'), li]
      .filter((node) => node.children.length === 0)
      .map((node) => node.textContent?.trim())
      .join(' '),
  );

/** Lets the page's promise chains (fetch, then the body) run to the end. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    for (let j = 0; j < 20; j += 1) {
      await Promise.resolve();
    }
  }
}

/** The page's listeners on document and window, removed after each test. */
const listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
/** The spies that record them. */
const listenerSpies: { mockRestore(): void }[] = [];

async function loadPage(url = '/designer') {
  window.history.replaceState(null, '', url);
  document.body.innerHTML = body;
  for (const target of [document, window] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    const spy = vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) {
        listeners.push([target, type, listener]);
      }
      add(type, listener, options);
    });
    listenerSpies.push(spy);
  }
  vi.resetModules();
  await import('../src/public/designer.js');
  await settle();
}

/** Types into a field as the organiser would: its value, then an input event. */
function type(id: string, value: string) {
  const field = $(id) as HTMLInputElement | HTMLTextAreaElement;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

const card = (position: number) => $('cards').querySelector(`li.card[data-position="${position}"]`) as HTMLElement;
const cardButton = (position: number, action: string) =>
  card(position).querySelector(`button[data-action="${action}"]`) as HTMLButtonElement;
const cardText = (position: number, selector: string) => card(position).querySelector(selector)?.textContent?.trim() ?? '';
/** The buttons a card offers, in order. */
const cardActions = (position: number) =>
  [...card(position).querySelectorAll<HTMLButtonElement>('.card-actions button')].filter((button) => !button.hidden).map((b) => b.textContent);

async function clickCard(position: number, action: string) {
  cardButton(position, action).click();
  await settle();
}

/** A ready draft on the stub game-server, as the stub runner leaves it. */
function addReadyDraft(id = DRAFT, checkpoints = STUB_CHECKPOINTS) {
  server.drafts.set(id, {
    id,
    status: 'ready',
    request: { area: 'Chiswick, London', theme: 'The Thames and brewing history', checkpoints: checkpoints.length, 'max-walk-km': 3 },
    area: { name: 'Stub area', bbox: { south: 51.48, west: -0.27, north: 51.5, east: -0.24 }, clipped: false },
    progress: [],
    checkpoints: checkpoints.map((checkpoint) => ({ ...checkpoint })),
    route: { 'legs-m': [346, 346, 692], 'loop-m': 1384 },
    problems: [],
    run: { runner: 'stub', model: null, turns: 0, 'cost-usd': 0, 'duration-ms': 5000, error: null },
    attribution: '© OpenStreetMap contributors',
    published: null,
    'created-at': '2026-10-08T08:00:00Z',
    'finished-at': '2026-10-08T08:00:05Z',
  });
}

async function openReadyDraft(checkpoints = STUB_CHECKPOINTS) {
  addReadyDraft(DRAFT, checkpoints);
  await loadPage(`/designer?draft=${DRAFT}`);
}

/** Loads the page again, as a reload would: the old page's listeners go. */
async function reloadPage(url: string) {
  for (const [target, type, listener] of listeners.splice(0)) {
    target.removeEventListener(type, listener);
  }
  for (const spy of listenerSpies.splice(0)) {
    spy.mockRestore();
  }
  await loadPage(url);
}

function fillDesign(values: { area?: string; theme?: string; checkpoints?: string; maxWalkKm?: string }) {
  if (values.area !== undefined) input('area').value = values.area;
  if (values.theme !== undefined) input('theme').value = values.theme;
  if (values.checkpoints !== undefined) input('checkpoints-count').value = values.checkpoints;
  if (values.maxWalkKm !== undefined) input('max-walk-km').value = values.maxWalkKm;
}

async function submit(formId: string) {
  $(formId).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

let server: ReturnType<typeof stubGameServer>;
let sessionStorage: MemoryStorage;
let localStorage: MemoryStorage;
let localSetItem: ReturnType<typeof vi.spyOn>;
let logged: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  setLeaflet(leaflet);
  vi.useFakeTimers({ now: Date.parse('2026-10-08T09:00:00Z') });
  account.status = 'signed-in';
  account.token = TOKEN;
  server = stubGameServer();
  vi.stubGlobal('fetch', server.fetch);
  sessionStorage = new MemoryStorage();
  localStorage = new MemoryStorage();
  vi.stubGlobal('sessionStorage', sessionStorage);
  vi.stubGlobal('localStorage', localStorage);
  localSetItem = vi.spyOn(localStorage, 'setItem');
  logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const [target, type, listener] of listeners.splice(0)) {
    target.removeEventListener(type, listener);
  }
  listenerSpies.splice(0);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('a design runs to the end', () => {
  it('posts the right body, then polls the draft, shows the progress steps and stops polling at ready', async () => {
    await loadPage();

    expect(visible('workspace')).toBe(true);
    expect(visible('draft-panel')).toBe(false);
    expect(visible('drafts-empty')).toBe(true);

    fillDesign({ area: '  Chiswick, London ', theme: 'The Thames and brewing history', maxWalkKm: '2.5' });
    await submit('design-form');

    // The right body, with the key, through this app's relay.
    expect(server.posts()).toEqual([
      {
        method: 'POST',
        url: '/designer/drafts',
        authorization: `Bearer ${TOKEN}`,
        body: { area: 'Chiswick, London', theme: 'The Thames and brewing history', checkpoints: 3, 'max-walk-km': 2.5 },
      },
    ]);
    // The new draft is open, and its id is all the URL holds.
    expect(window.location.pathname).toBe('/designer');
    expect(window.location.search).toBe(`?draft=${DRAFT}`);
    expect(visible('draft-panel')).toBe(true);
    expect(text('draft-title')).toBe('Chiswick, London');
    expect(text('draft-status')).toBe('Designing…');
    expect(text('draft-request')).toBe('3 checkpoints, up to 2.5 km');
    expect(items('drafts')).toHaveLength(1);

    // It polls every 2 s, and the steps grow.
    const readsAtStart = server.draftReads().length;
    expect(readsAtStart).toBe(1);
    expect(items('steps')).toEqual(['0:00 Finding the area: Stub area around a fixed point']);

    await vi.advanceTimersByTimeAsync(1999);
    expect(server.draftReads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(server.draftReads()).toHaveLength(2);
    expect(items('steps')).toEqual([
      '0:00 Finding the area: Stub area around a fixed point',
      '0:02 Looking for places: 3 candidate places',
    ]);
    expect(text('draft-elapsed')).toBe('Running for 0:02');

    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(items('steps')).toEqual([
      '0:00 Finding the area: Stub area around a fixed point',
      '0:02 Looking for places: 3 candidate places',
      '0:04 Writing clues and challenges: 3 clues and challenges written',
      '0:06 Checking the draft: No problems',
    ]);
    expect(visible('draft-ready')).toBe(false);

    // Ready: a card for each checkpoint to review, and no more polling.
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(text('draft-status')).toBe('Ready');
    expect(visible('draft-ready')).toBe(true);
    expect(visible('draft-review')).toBe(true);
    expect([...$('cards').querySelectorAll('.card-name')].map((name) => name.textContent)).toEqual([
      '1. Stub Lantern Gate',
      '2. Stub Riverside Bench',
      "3. Stub Brewers' Arch",
    ]);
    expect(input('card-1-clue').value).toBe('Where old lamps once lit the way in.');
    expect(input('card-3-pose').value).toBe('Roll an invisible barrel');
    expect(text('attribution')).toBe('Map data © OpenStreetMap contributors');
    expect(text('draft-elapsed')).toBe('Took 0:05 · cost $0.00');
    // The list was refreshed when it finished.
    expect($('drafts').textContent).toContain('Ready');

    const readsAtReady = server.draftReads().length;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(server.draftReads()).toHaveLength(readsAtReady);
  });

  it('polls only while the page is visible', async () => {
    await loadPage();
    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');
    expect(server.draftReads()).toHaveLength(1);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(server.draftReads()).toHaveLength(1);

    setVisibility('visible');
    await settle();
    expect(server.draftReads()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(server.draftReads()).toHaveLength(3);
  });

  it('opens a draft from the list, and follows the link back to all drafts', async () => {
    await loadPage();
    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');
    $('draft-close').click();
    await settle();

    expect(window.location.search).toBe('');
    expect(visible('draft-panel')).toBe(false);
    const link = $('drafts').querySelector('a.draft-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/designer?draft=${DRAFT}`);
    expect(link.textContent).toContain('Designing…');

    link.click();
    await settle();
    expect(window.location.search).toBe(`?draft=${DRAFT}`);
    expect(visible('draft-panel')).toBe(true);
    expect(link.getAttribute('aria-current')).toBe('page');
  });
});

describe('the form', () => {
  it('is checked in the page against the limits, and nothing is sent until it passes', async () => {
    await loadPage();

    fillDesign({ area: 'Ab', theme: '', checkpoints: '9', maxWalkKm: '0.4' });
    await submit('design-form');

    expect(server.posts()).toHaveLength(0);
    expect(text('area-error')).toBe('Enter the area: at least 3 characters.');
    expect(text('theme-error')).toBe('Enter the theme: at least 3 characters.');
    expect(text('checkpoints-error')).toBe('Choose a whole number of checkpoints from 3 to 8.');
    expect(text('max-walk-km-error')).toBe('Choose a walk from 0.5 to 10 km.');
    expect(input('area').getAttribute('aria-invalid')).toBe('true');

    fillDesign({ area: 'Kew', theme: 'Glasshouses', checkpoints: '8', maxWalkKm: '10' });
    await submit('design-form');
    expect(server.posts()).toHaveLength(1);
    expect(visible('area-error')).toBe(false);
    expect(input('area').hasAttribute('aria-invalid')).toBe(false);
  });

  it('disables the button while sending, and sends only once', async () => {
    await loadPage();
    let answer = () => undefined as void;
    server.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(fakeResponse(503, { detail: 'the hunt designer is not available', code: 'designer_disabled' }));
        }),
    );

    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    $('design-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    $('design-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    const button = $('design-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Starting…');
    expect(server.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);

    answer();
    await settle();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Start design');
  });
});

describe('busy and disabled', () => {
  it('says a design is already running, links to it, and keeps the form usable', async () => {
    await loadPage();
    server.state.nextId = RUNNING;
    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');
    $('draft-close').click();
    await settle();

    fillDesign({ area: 'Kew', theme: 'Glasshouses' });
    await submit('design-form');

    expect(visible('design-error')).toBe(true);
    expect(text('design-error-text')).toBe('A design is already running.');
    const link = $('design-error-link') as HTMLAnchorElement;
    expect(visible('design-error-link')).toBe(true);
    expect(link.getAttribute('href')).toBe(`/designer?draft=${RUNNING}`);
    const button = $('design-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(input('area').value).toBe('Kew');

    link.click();
    await settle();
    expect(window.location.search).toBe(`?draft=${RUNNING}`);
    expect(text('draft-title')).toBe('Chiswick');
  });

  it('stops saying so once the running design has finished', async () => {
    await loadPage();
    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');
    await submit('design-form');
    expect(text('design-error-text')).toBe('A design is already running.');

    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
    }

    expect(text('draft-status')).toBe('Ready');
    expect(visible('design-error')).toBe(false);
  });

  it("says the designer isn't switched on, and keeps the form usable", async () => {
    server.state.disabled = true;
    await loadPage();

    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');

    expect(text('design-error-text')).toBe("The hunt designer isn't switched on on the game-server.");
    expect(visible('design-error-link')).toBe(false);
    expect(($('design-button') as HTMLButtonElement).disabled).toBe(false);
    expect(input('theme').value).toBe('Brewing');

    server.state.disabled = false;
    await submit('design-form');
    expect(visible('design-error')).toBe(false);
    expect(window.location.search).toBe(`?draft=${DRAFT}`);
  });

  it('says when the game server cannot be reached, and keeps the form usable', async () => {
    await loadPage();
    server.state.offline = true;

    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');

    expect(text('design-error-text')).toBe('No connection to the game server. Try again.');
    expect(($('design-button') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('signing in', () => {
  it('uses the account: nothing is asked for, and every call carries its token', async () => {
    await loadPage();

    expect(visible('workspace')).toBe(true);
    expect(visible('sign-in')).toBe(false);
    expect(server.calls[0]).toMatchObject({ url: '/designer/drafts', authorization: `Bearer ${TOKEN}` });
    // The old key form and its Forget key button are gone.
    expect(document.getElementById('organiser-key')).toBeNull();
    expect(document.getElementById('sign-in-form')).toBeNull();
    expect(document.getElementById('sign-out')).toBeNull();
    expect(sessionStorage).toHaveLength(0);
    expect(localSetItem).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('asks a signed-out visitor to sign in, with a link that comes back here, and calls nothing', async () => {
    account.status = 'signed-out';
    await loadPage(`/designer?draft=${DRAFT}`);

    expect(visible('sign-in')).toBe(true);
    expect(visible('workspace')).toBe(false);
    expect(text('sign-in-text')).toBe('Sign in with your account to design hunts.');
    expect(visible('sign-in-link')).toBe(true);
    expect($('sign-in-link').getAttribute('href')).toBe(
      `/sign-in?redirect=${encodeURIComponent(`/designer?draft=${DRAFT}`)}`,
    );
    expect(server.calls).toHaveLength(0);
  });

  it.each([
    ['not-set-up', "Sign-in isn't set up yet."],
    ['unavailable', "Sign-in couldn't load. Check your connection and reload the page."],
  ])('says so, with no link, when sign-in is %s', async (status, message) => {
    account.status = status;
    await loadPage();

    expect(visible('sign-in')).toBe(true);
    expect(text('sign-in-error')).toBe(message);
    expect(visible('sign-in-link')).toBe(false);
    expect(server.calls).toHaveLength(0);
  });

  it("says this account isn't an organiser on a 403, shows nothing else, and stops polling", async () => {
    server.state.forbidden = true;
    await loadPage();

    expect(visible('sign-in')).toBe(true);
    expect(visible('workspace')).toBe(false);
    expect(text('sign-in-error')).toBe("This account isn't an organiser.");
    expect(visible('sign-in-link')).toBe(false);
    const before = server.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.calls).toHaveLength(before);
  });

  it.each(['the drafts list', 'the draft'])('a 401 from %s says to sign in again and stops', async (which) => {
    await loadPage();
    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');
    expect(visible('draft-panel')).toBe(true);

    // The game-server stops accepting the token.
    server.state.token = 'a-new-token';
    if (which === 'the drafts list') {
      setVisibility('hidden');
      setVisibility('visible');
    } else {
      await vi.advanceTimersByTimeAsync(2000);
    }
    await settle();

    expect(visible('sign-in')).toBe(true);
    expect(text('sign-in-error')).toBe(
      "Your sign-in wasn't accepted. Sign out from the account menu and sign in again.",
    );
    // Nothing from the draft is left on the page.
    expect($('steps').children).toHaveLength(0);
    expect($('drafts').children).toHaveLength(0);
    // And the polling has stopped.
    const before = server.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.calls).toHaveLength(before);
  });

  it('a 401 when starting a design stops too', async () => {
    await loadPage();
    server.state.token = 'a-new-token';

    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');

    expect(visible('sign-in')).toBe(true);
    expect(visible('workspace')).toBe(false);
  });
});

describe('a failed draft', () => {
  beforeEach(() => {
    server.drafts.set(FAILED, {
      id: FAILED,
      status: 'failed',
      request: { area: 'Chiswick, London', theme: 'Brewing history', checkpoints: 5, 'max-walk-km': 2 },
      area: { name: 'Chiswick, London, England', clipped: false },
      progress: [{ at: '2026-10-08T08:00:05Z', step: 'submit_draft', summary: '1 problem: too_close' }],
      checkpoints: [],
      route: null,
      problems: [{ code: 'too_close', position: 2, message: 'Checkpoints 2 and 3 are 90 m apart' }],
      run: { runner: 'agent', model: 'm', turns: 30, 'cost-usd': 0.61, 'duration-ms': 125000, error: { code: 'max_turns' } },
      attribution: '© OpenStreetMap contributors',
      published: null,
      'created-at': '2026-10-08T08:00:00Z',
      'finished-at': '2026-10-08T08:02:05Z',
    });
  });

  it('says why in plain words, lists the problems, and is not polled', async () => {
    await loadPage(`/designer?draft=${FAILED}`);

    expect(text('draft-status')).toBe('Failed');
    expect(text('failure-text')).toBe('The designer ran out of steps.');
    expect(items('problems')).toEqual(['Checkpoint 2: Checkpoints 2 and 3 are 90 m apart']);
    expect(text('draft-elapsed')).toBe('Took 2:05 · 30 turns · cost $0.61');
    expect(items('steps')).toEqual(['0:05 Checking the draft: 1 problem: too_close']);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.draftReads()).toHaveLength(1);
  });

  it('shows no Progress heading when the run had no steps', async () => {
    Object.assign(server.drafts.get(FAILED)!, { progress: [], problems: [], run: { error: { code: 'interrupted' } } });
    await loadPage(`/designer?draft=${FAILED}`);

    expect(text('failure-text')).toBe('The server restarted during the run.');
    expect(visible('problems-block')).toBe(false);
    expect(visible('steps-block')).toBe(false);
  });

  it('Try again fills in the form with the same request', async () => {
    await loadPage(`/designer?draft=${FAILED}`);

    $('try-again').click();

    expect(input('area').value).toBe('Chiswick, London');
    expect(input('theme').value).toBe('Brewing history');
    expect(input('checkpoints-count').value).toBe('5');
    expect(input('max-walk-km').value).toBe('2');
    expect(visible('design-note')).toBe(true);
    expect(document.activeElement).toBe($('design-button'));

    await submit('design-form');
    expect(server.posts()[0]?.body).toEqual({
      area: 'Chiswick, London',
      theme: 'Brewing history',
      checkpoints: 5,
      'max-walk-km': 2,
    });
  });
});

describe('a link to a draft that does not exist', () => {
  it('says so, and stops', async () => {
    await loadPage(`/designer?draft=${RUNNING}`);

    expect(text('draft-error')).toBe('No draft with this id. Check the link.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.draftReads()).toHaveLength(1);
  });
});

describe('reviewing a ready draft', () => {
  it("shows the header: area, theme, the loop's length, and the run", async () => {
    await openReadyDraft();

    expect(text('draft-title')).toBe('Chiswick, London');
    expect(text('draft-theme')).toBe('The Thames and brewing history');
    expect(text('draft-facts')).toBe('Stub area · loop 1.38 km');
    expect(text('draft-elapsed')).toBe('Took 0:05 · cost $0.00');
  });

  it("shows one card per checkpoint, with the place, the agent's reasons and a link to OpenStreetMap", async () => {
    await openReadyDraft();

    expect($('cards').querySelectorAll('li.card')).toHaveLength(3);
    expect(cardText(1, '.card-name')).toBe('1. Stub Lantern Gate');
    expect(cardText(1, '.review-badge')).toBe('To review');
    expect(cardText(1, '.card-kind')).toBe('historic · memorial');
    expect(cardText(1, '.card-rationale')).toBe('Why this place: A fixed stub checkpoint.');
    const link = card(1).querySelector('a.osm-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.openstreetmap.org/node/9000000001');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(input('card-1-clue').value).toBe('Where old lamps once lit the way in.');
    expect(input('card-1-pose').value).toBe('Point at the lantern');
    expect(input('card-1-scene').value).toBe('The Stub Lantern Gate seen from the path.');
    expect(input('card-1-proximity').value).toBe('30');
    expect(text('card-1-scene-hint')).toBe('For the referee only: never shown to players.');
    expect(text('card-1-pose-hint')).toBe('Shown to players at check-in: what to do in the photo.');
    expect(cardActions(1)).toEqual(['Save changes', 'Accept', 'Reject']);
    expect(cardButton(1, 'save').disabled).toBe(true);
    expect(visible('publish-button')).toBe(true);
  });

  it('counts the characters at the limits as they are typed', async () => {
    await openReadyDraft();

    expect(text('card-1-clue-count')).toBe('36 / 300');
    expect(text('card-1-pose-count')).toBe('20 / 200');
    expect(text('card-1-scene-count')).toBe('41 / 1000');

    type('card-1-clue', 'x'.repeat(301));
    expect(text('card-1-clue-count')).toBe('301 / 300');
    expect($('card-1-clue-count').classList.contains('counter--over')).toBe(true);
  });

  it('sends the right PATCH bodies to accept, reject and undo, and shows each review', async () => {
    await openReadyDraft();

    await clickCard(1, 'accepted');
    expect(server.patches().at(-1)).toEqual({
      method: 'PATCH',
      url: `/designer/drafts/${DRAFT}/checkpoints/1`,
      authorization: `Bearer ${TOKEN}`,
      body: { review: 'accepted' },
    });
    expect(cardText(1, '.review-badge')).toBe('Accepted');
    expect(card(1).classList.contains('card--accepted')).toBe(true);
    expect(cardActions(1)).toEqual(['Save changes', 'Reject', 'Undo']);

    await clickCard(2, 'rejected');
    expect(server.patches().at(-1)).toMatchObject({ url: `/designer/drafts/${DRAFT}/checkpoints/2`, body: { review: 'rejected' } });
    expect(cardText(2, '.review-badge')).toBe('Rejected');
    expect(cardActions(2)).toEqual(['Save changes', 'Accept', 'Undo']);

    await clickCard(2, 'pending');
    expect(server.patches().at(-1)).toMatchObject({ url: `/designer/drafts/${DRAFT}/checkpoints/2`, body: { review: 'pending' } });
    expect(cardText(2, '.review-badge')).toBe('To review');
    expect(cardActions(2)).toEqual(['Save changes', 'Accept', 'Reject']);
    expect(server.patches()).toHaveLength(3);
  });

  it('saves only the fields that changed, and marks the card edited', async () => {
    await openReadyDraft();

    type('card-2-clue', 'A seat that looks over the water.');
    expect(cardButton(2, 'save').disabled).toBe(false);
    expect(visible('publish-reason')).toBe(true);
    expect(text('publish-reason')).toContain('Save your changes to checkpoint 2 first.');
    await clickCard(2, 'save');

    expect(server.patches()).toEqual([
      {
        method: 'PATCH',
        url: `/designer/drafts/${DRAFT}/checkpoints/2`,
        authorization: `Bearer ${TOKEN}`,
        body: { clue: 'A seat that looks over the water.' },
      },
    ]);
    expect(input('card-2-clue').value).toBe('A seat that looks over the water.');
    expect(cardButton(2, 'save').disabled).toBe(true);
    expect((card(2).querySelector('.edited-mark') as HTMLElement).hidden).toBe(false);
    expect((card(1).querySelector('.edited-mark') as HTMLElement).hidden).toBe(true);
    expect(text('publish-reason')).not.toContain('Save your changes');

    // The radius goes as a number, alone.
    type('card-2-proximity', '45');
    await clickCard(2, 'save');
    expect(server.patches().at(-1)?.body).toEqual({ proximity: 45 });
  });

  it("keeps what's typed in one card while another is saved", async () => {
    await openReadyDraft();

    type('card-1-pose', 'Wave at the lamp');
    await clickCard(2, 'accepted');

    expect(input('card-1-pose').value).toBe('Wave at the lamp');
    expect(cardButton(1, 'save').disabled).toBe(false);
  });

  it('shows a 422 names_place under the clue, and saves nothing', async () => {
    await openReadyDraft();

    type('card-1-clue', 'Find the lantern by the gate.');
    await clickCard(1, 'save');

    expect(server.patches()).toHaveLength(1);
    expect(visible('card-1-clue-error')).toBe(true);
    expect(text('card-1-clue-error')).toBe('Checkpoint 1\'s clue gives the place away ("lantern"); describe it without its name');
    expect(input('card-1-clue').getAttribute('aria-invalid')).toBe('true');
    expect(visible('card-1-pose-error')).toBe(false);
    expect((card(1).querySelector('.card-error') as HTMLElement).hidden).toBe(true);
    // Nothing was saved: the text is still unsaved, and not marked edited.
    expect(cardButton(1, 'save').disabled).toBe(false);
    expect((card(1).querySelector('.edited-mark') as HTMLElement).hidden).toBe(true);

    // Fixing it clears the problem once it's saved.
    type('card-1-clue', 'Where old lamps once lit the way, by the gate.');
    await clickCard(1, 'save');
    expect(visible('card-1-clue-error')).toBe(false);
  });

  it('shows a 422 names_place under the pose when the pose names the place', async () => {
    await openReadyDraft();

    type('card-2-pose', 'Sit on the riverside seat');
    await clickCard(2, 'save');

    expect(text('card-2-pose-error')).toBe('Checkpoint 2\'s pose gives the place away ("riverside"); describe it without its name');
    expect(visible('card-2-clue-error')).toBe(false);
  });

  it('checks the limits in the page first, and sends nothing until they pass', async () => {
    await openReadyDraft();

    type('card-1-clue', '   ');
    type('card-1-proximity', '150');
    await clickCard(1, 'save');

    expect(server.patches()).toHaveLength(0);
    expect(text('card-1-clue-error')).toBe("The clue can't be empty.");
    expect(text('card-1-proximity-error')).toBe('Choose a whole number of metres from 20 to 100.');
    expect(document.activeElement).toBe($('card-1-clue'));

    // Fixing a field clears its error as it's typed.
    type('card-1-proximity', '60');
    expect(visible('card-1-proximity-error')).toBe(false);
  });

  it("disables the card's buttons and fields while saving", async () => {
    await openReadyDraft();
    let answer = () => undefined as void;
    server.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(fakeResponse(200, { ...STUB_CHECKPOINTS[0], review: 'accepted' }));
        }),
    );

    cardButton(1, 'accepted').click();
    await settle();

    expect(cardButton(1, 'accepted').disabled).toBe(true);
    expect(cardButton(1, 'rejected').disabled).toBe(true);
    expect(cardButton(1, 'save').disabled).toBe(true);
    expect(input('card-1-clue').readOnly).toBe(true);
    expect(card(1).getAttribute('aria-busy')).toBe('true');
    // Another card can still be reviewed.
    expect(cardButton(2, 'accepted').disabled).toBe(false);
    cardButton(1, 'rejected').click();
    await settle();
    expect(server.fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);

    answer();
    await settle();
    expect(cardText(1, '.review-badge')).toBe('Accepted');
    expect(cardButton(1, 'rejected').disabled).toBe(false);
    expect(input('card-1-clue').readOnly).toBe(false);
  });

  it('says on the card when the draft can no longer be edited, and reads it again', async () => {
    await openReadyDraft();
    server.drafts.get(DRAFT)!.status = 'published';
    const reads = server.draftReads().length;

    await clickCard(1, 'accepted');

    expect(server.draftReads()).toHaveLength(reads + 1);
    expect(text('draft-status')).toBe('Published');
  });

  it('says on the card when there is no connection, and keeps the edit', async () => {
    await openReadyDraft();
    type('card-1-pose', 'Wave at the lamp');
    server.state.offline = true;

    await clickCard(1, 'save');

    expect(cardText(1, '.card-error')).toBe('No connection to the game server.');
    expect(input('card-1-pose').value).toBe('Wave at the lamp');
    expect(cardButton(1, 'save').disabled).toBe(false);
  });

  it('a 401 stops and takes the cards off the screen', async () => {
    await openReadyDraft();
    server.state.token = 'a-new-token';

    await clickCard(1, 'accepted');

    expect(visible('sign-in')).toBe(true);
    expect($('cards').children).toHaveLength(0);
  });

  it('counts accepted, rejected and to review, and works out the loop over the accepted only', async () => {
    await openReadyDraft();

    expect(text('count-accepted')).toBe('0 accepted');
    expect(text('count-rejected')).toBe('0 rejected');
    expect(text('count-pending')).toBe('3 to review');
    expect(text('review-loop')).toBe('Accept checkpoints to see the loop');

    await clickCard(1, 'accepted');
    await clickCard(3, 'accepted');
    expect(text('count-accepted')).toBe('2 accepted');
    expect(text('count-pending')).toBe('1 to review');
    // 1 → 3 and back: checkpoint 2, between them, is left out.
    expect(text('review-loop')).toBe('Loop of the accepted: 1.38 km (up to 3 km)');

    await clickCard(2, 'rejected');
    expect(text('count-rejected')).toBe('1 rejected');
    expect(text('count-pending')).toBe('0 to review');
  });
});

describe('the Publish hunt button', () => {
  const FOUR = [
    ...STUB_CHECKPOINTS,
    { ...STUB_CHECKPOINTS[0]!, position: 4, place: { ...STUB_CHECKPOINTS[0]!.place, osm: 'node/9000000004', name: 'Stub Old Mill' } },
  ];
  const publishButton = () => $('publish-button') as HTMLButtonElement;

  it('is disabled with a checkpoint pending, and says so', async () => {
    await openReadyDraft();
    await clickCard(1, 'accepted');
    await clickCard(2, 'accepted');

    expect(publishButton().disabled).toBe(true);
    expect(text('publish-reason')).toBe(
      'Accept or reject every checkpoint: 1 checkpoint still to review. At least 3 must be accepted (2 so far).',
    );

    await clickCard(3, 'accepted');
    expect(publishButton().disabled).toBe(false);
    expect(visible('publish-reason')).toBe(false);
  });

  it('is disabled with fewer than 3 accepted, and says so', async () => {
    await openReadyDraft(FOUR);
    await clickCard(1, 'accepted');
    await clickCard(2, 'accepted');
    await clickCard(3, 'rejected');
    await clickCard(4, 'rejected');

    expect(publishButton().disabled).toBe(true);
    expect(text('publish-reason')).toBe('At least 3 must be accepted, and 2 are: undo a rejection to accept it.');
  });

  it('is enabled with 3 accepted and the rest rejected', async () => {
    await openReadyDraft(FOUR);
    await clickCard(1, 'accepted');
    await clickCard(2, 'rejected');
    await clickCard(3, 'accepted');
    await clickCard(4, 'accepted');

    expect(publishButton().disabled).toBe(false);
    expect(visible('publish-reason')).toBe(false);
  });
});

describe('publishing', () => {
  async function readyToPublish() {
    await openReadyDraft();
    for (const position of [1, 2, 3]) {
      await clickCard(position, 'accepted');
    }
  }

  function fillPublish(values: { name?: string; start?: string; end?: string; teams?: string[] }) {
    if (values.name !== undefined) input('hunt-name').value = values.name;
    if (values.start !== undefined) input('start-time').value = values.start;
    if (values.end !== undefined) input('end-time').value = values.end;
    for (const [index, name] of (values.teams ?? []).entries()) {
      if (!document.getElementById(`team-${index + 1}`)) {
        $('add-team').click();
      }
      type(`team-${index + 1}`, name);
    }
  }

  /** What the browser sends for a datetime-local value: its own offset on that date. */
  function iso(local: string) {
    const [date, time] = local.split('T') as [string, string];
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    const [hour, minute] = time.split(':').map(Number) as [number, number];
    const offset = -new Date(year, month - 1, day, hour, minute).getTimezoneOffset();
    const abs = Math.abs(offset);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${local}:00${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }

  async function confirm(answer: 'ok' | 'cancel') {
    expect(($('publish-confirm') as HTMLDialogElement).open).toBe(true);
    $(answer === 'ok' ? 'publish-ok' : 'publish-cancel').click();
    await settle();
  }

  const form = {
    name: '  Chiswick river hunt ',
    start: '2026-10-11T10:00',
    end: '2026-10-11T12:00',
    teams: ['Red Foxes', ' Blue Herons', 'Green Owls'],
  };

  it('asks first, then posts the right body and shows the session, the moderator link and code, and the join codes', async () => {
    await readyToPublish();
    fillPublish(form);

    await submit('publish-form');
    expect(text('publish-confirm')).toContain("Publishing makes this hunt playable at once. You can't edit it afterwards.");
    expect(server.posts()).toHaveLength(0);
    await confirm('ok');

    expect(server.posts()).toEqual([
      {
        method: 'POST',
        url: `/designer/drafts/${DRAFT}/publish`,
        authorization: `Bearer ${TOKEN}`,
        body: {
          name: 'Chiswick river hunt',
          'start-time': iso('2026-10-11T10:00'),
          'end-time': iso('2026-10-11T12:00'),
          teams: ['Red Foxes', 'Blue Herons', 'Green Owls'],
        },
      },
    ]);
    expect(text('draft-status')).toBe('Published');
    expect(visible('draft-review')).toBe(false);
    expect(visible('publication')).toBe(true);
    expect(text('publication-session')).toBe(SESSION);
    const link = $('moderator-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/moderator?session=${SESSION}`);
    expect(link.textContent).toBe(`http://localhost:3000/moderator?session=${SESSION}`);
    // The game-server still sends the moderator code until it retires them;
    // the publisher is the hunt's moderator, so it isn't shown (issue #67).
    expect(document.getElementById('moderator-code')).toBeNull();
    expect(document.body.textContent).not.toContain(MODERATOR_CODE);
    expect(items('team-codes')).toEqual(['Red Foxes RED-7Q2K Copy', 'Blue Herons BLUE-7Q2K Copy', 'Green Owls GREEN-7Q2K Copy']);
    expect($('publication').textContent).toContain('Send each team only its own code');
    // Only the accepted checkpoints are in the hunt.
    expect(items('checkpoints')).toHaveLength(3);
    // The list says it's published too.
    expect($('drafts').textContent).toContain('Published');
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    await readyToPublish();
    fillPublish(form);

    await submit('publish-form');
    await confirm('cancel');

    expect(server.posts()).toHaveLength(0);
    expect(visible('draft-review')).toBe(true);
  });

  it('checks the form in the page, and sends nothing until it passes', async () => {
    await readyToPublish();
    fillPublish({ name: ' ', start: '2026-10-11T12:00', end: '2026-10-11T10:00', teams: ['Red Foxes', 'red foxes'] });

    await submit('publish-form');

    expect(($('publish-confirm') as HTMLDialogElement).open).toBe(false);
    expect(server.posts()).toHaveLength(0);
    expect(text('hunt-name-error')).toBe("Enter the hunt's name.");
    expect(text('end-time-error')).toBe('It must end after it starts.');
    expect(visible('start-time-error')).toBe(false);
    expect(text('team-2-error')).toBe('Team 1 has the same name. Each team needs its own, whatever the capitals.');
    expect(document.activeElement).toBe($('hunt-name'));
  });

  it('adds and removes team rows, from 1 to 10', async () => {
    await readyToPublish();

    expect($('teams').querySelectorAll('input')).toHaveLength(2);
    for (let i = 0; i < 8; i += 1) {
      $('add-team').click();
    }
    expect($('teams').querySelectorAll('input')).toHaveLength(10);
    expect(($('add-team') as HTMLButtonElement).disabled).toBe(true);

    type('team-1', 'Red Foxes');
    type('team-3', 'Green Owls');
    ($('teams').querySelector('button[aria-label="Remove team 2"]') as HTMLButtonElement).click();
    expect($('teams').querySelectorAll('input')).toHaveLength(9);
    expect(input('team-1').value).toBe('Red Foxes');
    expect(input('team-2').value).toBe('Green Owls');
    expect(($('add-team') as HTMLButtonElement).disabled).toBe(false);

    while ($('teams').querySelectorAll('input').length > 1) {
      ($('teams').querySelector('button.remove-team') as HTMLButtonElement).click();
    }
    expect(($('teams').querySelector('button.remove-team') as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a 409 with the server's detail", async () => {
    await readyToPublish();
    server.state.publishAnswer = { status: 409, body: { detail: 'checkpoint(s) 2 still pending review', code: 'draft_not_ready' } };
    fillPublish(form);

    await submit('publish-form');
    await confirm('ok');

    expect(text('publish-error-text')).toBe("The game-server can't publish this draft yet. checkpoint(s) 2 still pending review.");
    expect(visible('draft-review')).toBe(true);
    expect(input('hunt-name').value).toBe(form.name);
  });

  it("shows a 422's problems", async () => {
    await readyToPublish();
    server.state.publishAnswer = {
      status: 422,
      body: {
        detail: 'draft problems',
        problems: [{ code: 'route_too_long', position: null, message: 'The route is 3.4 km round; keep it within 3 km' }],
      },
    };
    fillPublish(form);

    await submit('publish-form');
    await confirm('ok');

    expect(text('publish-error-text')).toBe('The accepted checkpoints break a rule:');
    expect(items('publish-error-lines')).toEqual(['The route is 3.4 km round; keep it within 3 km']);
    expect(($('publish-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('copies a join code', async () => {
    await readyToPublish();
    fillPublish(form);
    await submit('publish-form');
    await confirm('ok');
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    const copy = $('team-codes').querySelector('button[aria-label="Copy Blue Herons\'s join code"]') as HTMLButtonElement;
    copy.click();
    await settle();

    expect(writeText).toHaveBeenCalledWith('BLUE-7Q2K');
    expect(copy.textContent).toBe('Copied');
    expect(text('copy-status')).toBe("Copied Blue Herons's join code.");
    await vi.advanceTimersByTimeAsync(2000);
    expect(copy.textContent).toBe('Copy');

    $('copy-moderator-link').click();
    await settle();
    expect(writeText).toHaveBeenLastCalledWith(`http://localhost:3000/moderator?session=${SESSION}`);
  });

  it("shows the codes again from …/publication when a published draft is reopened, and doesn't keep them", async () => {
    await readyToPublish();
    fillPublish(form);
    await submit('publish-form');
    await confirm('ok');
    const publicationReads = () => server.calls.filter((call) => call.url.endsWith('/publication'));
    expect(publicationReads()).toHaveLength(0);

    await reloadPage(`/designer?draft=${DRAFT}`);

    expect(publicationReads()).toEqual([
      { method: 'GET', url: `/designer/drafts/${DRAFT}/publication`, authorization: `Bearer ${TOKEN}`, body: undefined },
    ]);
    expect(text('draft-status')).toBe('Published');
    expect(text('publication-session')).toBe(SESSION);
    expect(document.body.textContent).not.toContain(MODERATOR_CODE);
    expect(items('team-codes')).toEqual(['Red Foxes RED-7Q2K Copy', 'Blue Herons BLUE-7Q2K Copy', 'Green Owls GREEN-7Q2K Copy']);

    // Closing the draft takes the codes off the page.
    $('draft-close').click();
    await settle();
    expect($('team-codes').children).toHaveLength(0);
  });

  it("says when a published draft's codes can't be had, and tries again", async () => {
    addReadyDraft();
    server.drafts.get(DRAFT)!.status = 'published';
    server.publications.set(DRAFT, {
      session: SESSION,
      name: 'Chiswick river hunt',
      'moderator-code': MODERATOR_CODE,
      teams: [{ name: 'Red Foxes', 'join-code': 'RED-7Q2K' }],
    });
    server.state.publicationOffline = true;
    await loadPage(`/designer?draft=${DRAFT}`);

    expect(text('draft-status')).toBe('Published');
    expect(visible('publication')).toBe(false);
    expect(text('publication-error')).toBe("No connection to the game server: the codes can't be shown.");

    server.state.publicationOffline = false;
    $('publication-retry').click();
    await settle();

    expect(visible('publication-error')).toBe(false);
    expect(visible('publication-retry')).toBe(false);
    expect(items('team-codes')).toEqual(['Red Foxes RED-7Q2K Copy']);
  });
});

/** The markers on the map, in the order they were drawn. */
const mapMarkers = () => [...document.querySelectorAll<HTMLElement>('#route-map .route-marker')];
const mapMarker = (position: number) => mapMarkers().find((marker) => marker.textContent === String(position))!;
/** A stub checkpoint's place, as Leaflet takes it. */
const latLng = (position: number) => {
  const { lat, long } = STUB_CHECKPOINTS[position - 1]!.place.location;
  return [lat, long];
};
const placeButton = (li: Element) => li.querySelector('button.place-button') as HTMLButtonElement;

describe('the route map', () => {
  it("shows a ready draft's area, a numbered marker per checkpoint and the closed loop, with the attribution", async () => {
    const fitBounds = vi.spyOn(leaflet.Map.prototype, 'fitBounds');
    const rectangle = vi.spyOn(leaflet, 'rectangle');
    const polyline = vi.spyOn(leaflet, 'polyline');
    await openReadyDraft();

    expect(visible('map-block')).toBe(true);
    expect(visible('route-map')).toBe(true);
    expect(visible('map-note')).toBe(false);
    // The area's box, outlined.
    expect(rectangle).toHaveBeenLastCalledWith(
      [
        [51.48, -0.27],
        [51.5, -0.24],
      ],
      expect.objectContaining({ fill: false }),
    );
    expect(document.querySelector('#route-map path.route-area')).not.toBeNull();
    // A numbered marker per checkpoint, in route order, named for its place.
    expect(mapMarkers().map((marker) => marker.textContent)).toEqual(['1', '2', '3']);
    expect(mapMarkers().map((marker) => marker.getAttribute('aria-label'))).toEqual([
      '1. Stub Lantern Gate: To review',
      '2. Stub Riverside Bench: To review',
      "3. Stub Brewers' Arch: To review",
    ]);
    expect(mapMarker(1).classList.contains('route-marker--pending')).toBe(true);
    // The loop through them, back to the first.
    expect(polyline).toHaveBeenLastCalledWith([latLng(1), latLng(2), latLng(3), latLng(1)], expect.anything());
    expect(document.querySelector('#route-map path.route-loop')).not.toBeNull();
    // The view fits the box and the markers.
    expect(fitBounds).toHaveBeenCalledTimes(1);
    expect(fitBounds).toHaveBeenCalledWith(
      [
        [51.48, -0.27],
        [51.5, -0.24],
      ],
      expect.anything(),
    );
    expect(document.querySelector('#route-map .leaflet-control-attribution')?.textContent).toContain(
      '© OpenStreetMap contributors',
    );
  });

  it('is not shown while a draft is running, nor for a failed one', async () => {
    server.drafts.set(RUNNING, {
      id: RUNNING,
      status: 'running',
      request: { area: 'Chiswick, London', theme: 'The Thames', checkpoints: 3, 'max-walk-km': 3 },
      area: null,
      progress: [],
      checkpoints: [],
      route: null,
      problems: [],
      run: { runner: 'stub', model: null, turns: 0, 'cost-usd': 0, 'duration-ms': null, error: null },
      published: null,
      'created-at': '2026-10-08T08:59:00Z',
      'finished-at': null,
    });
    await loadPage(`/designer?draft=${RUNNING}`);

    expect(text('draft-status')).toBe('Designing…');
    expect(visible('map-block')).toBe(false);
    expect(mapMarkers()).toHaveLength(0);
  });

  it("fades a rejected checkpoint's marker and redraws the loop without it, keeping the view", async () => {
    const fitBounds = vi.spyOn(leaflet.Map.prototype, 'fitBounds');
    const polyline = vi.spyOn(leaflet, 'polyline');
    await openReadyDraft();

    await clickCard(2, 'rejected');
    expect(mapMarker(2).classList.contains('route-marker--rejected')).toBe(true);
    expect(mapMarker(2).getAttribute('aria-label')).toBe('2. Stub Riverside Bench: Rejected');
    expect(polyline).toHaveBeenLastCalledWith([latLng(1), latLng(3), latLng(1)], expect.anything());

    await clickCard(1, 'accepted');
    expect(mapMarker(1).classList.contains('route-marker--accepted')).toBe(true);
    expect(mapMarker(1).getAttribute('aria-label')).toBe('1. Stub Lantern Gate: Accepted');
    expect(polyline).toHaveBeenLastCalledWith([latLng(1), latLng(3), latLng(1)], expect.anything());

    // Undo puts it back in the loop.
    await clickCard(2, 'pending');
    expect(mapMarker(2).classList.contains('route-marker--pending')).toBe(true);
    expect(polyline).toHaveBeenLastCalledWith([latLng(1), latLng(2), latLng(3), latLng(1)], expect.anything());
    // Fitted once, when it was first shown: a review doesn't undo a pan or zoom.
    expect(fitBounds).toHaveBeenCalledTimes(1);
  });

  it('goes to the card of a tapped marker, and highlights it for a moment', async () => {
    await openReadyDraft();

    mapMarker(2).click();
    expect(card(2).hasAttribute('data-highlighted')).toBe(true);
    expect(document.activeElement).toBe(card(2));

    mapMarker(3).click();
    expect(card(2).hasAttribute('data-highlighted')).toBe(false);
    expect(card(3).hasAttribute('data-highlighted')).toBe(true);
    expect(document.activeElement).toBe(card(3));

    await vi.advanceTimersByTimeAsync(2500);
    expect(card(3).hasAttribute('data-highlighted')).toBe(false);
    // Tapping a marker sends nothing.
    expect(server.patches()).toHaveLength(0);
  });

  it("centres the map on a checkpoint's marker when its name is tapped", async () => {
    const panTo = vi.spyOn(leaflet.Map.prototype, 'panTo');
    await openReadyDraft();

    expect(placeButton(card(3)).textContent).toBe("3. Stub Brewers' Arch");
    expect(placeButton(card(3)).getAttribute('aria-describedby')).toBe('locate-hint');
    placeButton(card(3)).click();
    await settle();

    expect(panTo).toHaveBeenCalledTimes(1);
    const [lat, lng] = latLng(3);
    expect(panTo.mock.calls[0]![0]).toMatchObject({ lat, lng });
    expect(document.querySelector('#route-map .leaflet-tooltip')?.textContent).toBe("3. Stub Brewers' Arch: To review");
    // It's not a review action: nothing is sent.
    expect(server.patches()).toHaveLength(0);
    expect(cardText(3, '.review-badge')).toBe('To review');
  });

  it('says when the tiles fail, and the markers and the cards still work', async () => {
    await openReadyDraft();

    const tile = document.querySelector('#route-map img.leaflet-tile')!;
    // OpenStreetMap is told this app's origin, never the page's address.
    expect(tile.getAttribute('referrerpolicy')).toBe('strict-origin');
    expect(tile.getAttribute('src')).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    tile.dispatchEvent(new Event('error'));
    await settle();

    expect(visible('map-note')).toBe(true);
    expect(text('map-note')).toBe("The map couldn't load. The numbered places and the loop are still shown.");
    expect(mapMarkers()).toHaveLength(3);
    mapMarker(1).click();
    expect(card(1).hasAttribute('data-highlighted')).toBe(true);
    await clickCard(1, 'accepted');
    expect(cardText(1, '.review-badge')).toBe('Accepted');
    expect(mapMarker(1).classList.contains('route-marker--accepted')).toBe(true);
  });

  it("says when Leaflet couldn't load, and the cards still work without it", async () => {
    setLeaflet(undefined);
    await openReadyDraft();

    expect(visible('map-block')).toBe(true);
    expect(visible('route-map')).toBe(false);
    expect(text('map-note')).toBe("The map couldn't load. The checkpoints below still work.");
    // The names are plain headings, with no map to find them on.
    expect(placeButton(card(1))).toBeNull();
    expect(cardText(1, '.card-name')).toBe('1. Stub Lantern Gate');

    await clickCard(1, 'accepted');
    expect(cardText(1, '.review-badge')).toBe('Accepted');
    expect(text('count-accepted')).toBe('1 accepted');
  });

  it("shows a published hunt's checkpoints only, numbered as the session numbers them, linked to its rows", async () => {
    await openReadyDraft();
    await clickCard(1, 'accepted');
    await clickCard(2, 'rejected');
    await clickCard(3, 'accepted');
    // Published as it stands (the stub's three can't make 3 accepted with
    // one rejected), and opened again.
    server.drafts.get(DRAFT)!.status = 'published';
    await reloadPage(`/designer?draft=${DRAFT}`);

    expect(text('draft-status')).toBe('Published');
    expect(visible('map-block')).toBe(true);
    expect(mapMarkers().map((marker) => marker.getAttribute('aria-label'))).toEqual([
      '1. Stub Lantern Gate',
      "2. Stub Brewers' Arch",
    ]);
    expect(items('checkpoints')[1]).toMatch(/^2\. Stub Brewers' Arch/);

    mapMarker(2).click();
    const row = $('checkpoints').querySelector('li[data-position="2"]')!;
    expect(row.hasAttribute('data-highlighted')).toBe(true);
    expect(document.activeElement).toBe(row);

    const panTo = vi.spyOn(leaflet.Map.prototype, 'panTo');
    placeButton(row).click();
    const [lat, lng] = latLng(3);
    expect(panTo.mock.calls[0]![0]).toMatchObject({ lat, lng });
  });

  it('takes the places off the map when the draft is closed, and when the account is turned away', async () => {
    await openReadyDraft();
    expect(mapMarkers()).toHaveLength(3);

    $('draft-close').click();
    await settle();
    expect(visible('map-block')).toBe(false);
    expect(mapMarkers()).toHaveLength(0);

    ($('drafts').querySelector('a.draft-link') as HTMLAnchorElement).click();
    await settle();
    expect(mapMarkers()).toHaveLength(3);

    // The account is turned away: nothing stays on the map.
    server.state.forbidden = true;
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(mapMarkers()).toHaveLength(0);
    expect(document.querySelector('#route-map .leaflet-tooltip')).toBeNull();
  });
});

describe('the hunt builder', () => {
  type Marker = { _map: unknown; options: { title: string }; setLatLng: (latLng: number[]) => unknown; fire: (type: string) => unknown };
  type LeafletMap = { fire: (type: string, event: unknown) => unknown; getContainer: () => HTMLElement };
  let mapSpy: MockInstance<(...args: unknown[]) => unknown>;
  let markerSpy: MockInstance<(...args: unknown[]) => unknown>;
  let fitBounds: MockInstance<(...args: unknown[]) => unknown>;
  let geolocation: { getCurrentPosition: ReturnType<typeof vi.fn> };

  const PINS = [
    [51.48, -0.25],
    [51.485, -0.25],
    [51.485, -0.243],
  ] as const;
  const NAMES = ['The boathouse', 'The bridge', 'The pier'];

  beforeEach(() => {
    mapSpy = vi.spyOn(leaflet, 'map');
    markerSpy = vi.spyOn(leaflet, 'marker');
    fitBounds = vi.spyOn(leaflet.Map.prototype, 'fitBounds');
    geolocation = { getCurrentPosition: vi.fn() };
    Object.defineProperty(navigator, 'geolocation', { value: geolocation, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
  });

  const builderMapOf = () =>
    mapSpy.mock.results.map((result) => result.value as LeafletMap).reverse().find((map) => map.getContainer().id === 'builder-map')!;
  /** The marker on the builder's map with this number. */
  const markerOf = (position: number) =>
    markerSpy.mock.results
      .map((result) => result.value as Marker)
      .reverse()
      .find((marker) => marker._map && marker.options.title.startsWith(`${position}.`))!;
  const builderMarkers = () => [...document.querySelectorAll<HTMLElement>('#builder-map .route-marker')];
  const tap = (lat: number, long: number) => builderMapOf().fire('click', { latlng: leaflet.latLng(lat, long) });
  const bCard = (index: number) => $('builder-cards').children[index] as HTMLElement;
  const bField = (index: number, field: string) => input(`builder-${index}-${field}`);
  const bText = (index: number, selector: string) => bCard(index).querySelector(selector)?.textContent?.trim() ?? '';
  const bButton = (index: number, action: string) => bCard(index).querySelector(`button[data-action="${action}"]`) as HTMLButtonElement;
  const names = () => [...$('builder-cards').children].map((_, index) => bField(index, 'name').value);
  const selectedCards = () => [...$('builder-cards').children].flatMap((li, index) => (li.classList.contains('builder-card--selected') ? [index] : []));
  /** Focusing a card is how it's selected. */
  const select = (index: number) => bField(index, 'name').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  const chooseMode = async (mode: 'agent' | 'manual') => {
    const radio = document.querySelector<HTMLInputElement>(`input[name="design-mode"][value="${mode}"]`)!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  };
  const click = async (element: HTMLElement) => {
    element.click();
    await settle();
  };

  async function openBuilder(url = '/designer') {
    await loadPage(url);
    await chooseMode('manual');
  }

  /** Types in a checkpoint's fields and pins it. */
  function placeCheckpoint(index: number, name: string, pin: readonly [number, number]) {
    select(index);
    type(`builder-${index}-name`, name);
    type(`builder-${index}-clue`, `Clue for ${name}`);
    type(`builder-${index}-scene`, `Scene for ${name}`);
    type(`builder-${index}-pose`, `Pose for ${name}`);
    tap(...pin);
  }

  /** A whole hunt, ready to send. */
  async function fillHunt() {
    await openBuilder();
    type('builder-area', '  Chiswick, London ');
    type('builder-theme', 'Riverside pubs');
    NAMES.forEach((name, index) => placeCheckpoint(index, name, PINS[index]!));
    await settle();
  }

  const huntRequest = {
    area: 'Chiswick, London',
    theme: 'Riverside pubs',
    'max-walk-km': 10,
    checkpoints: NAMES.map((name, index) => ({
      name,
      location: { lat: PINS[index]![0], long: PINS[index]![1] },
      clue: `Clue for ${name}`,
      scene: `Scene for ${name}`,
      pose: `Pose for ${name}`,
      proximity: 30,
    })),
  };

  describe('choosing how to design', () => {
    it('offers the designer first, and swaps the form for the builder when the organiser places them', async () => {
      await loadPage();

      expect(visible('design-form')).toBe(true);
      expect(visible('builder-form')).toBe(false);
      expect(document.querySelector<HTMLInputElement>('input[name="design-mode"]:checked')!.value).toBe('agent');
      expect([...document.querySelectorAll('.mode-option')].map((label) => label.textContent?.trim())).toEqual([
        'Let the designer choose',
        'Place them myself',
      ]);

      fillDesign({ area: 'Chiswick, London' });
      await chooseMode('manual');
      expect(visible('design-form')).toBe(false);
      expect(visible('builder-form')).toBe(true);

      // Nothing typed in either is lost by swapping.
      await chooseMode('agent');
      expect(visible('builder-form')).toBe(false);
      expect(input('area').value).toBe('Chiswick, London');
    });

    it('starts the builder with 3 checkpoints, a walk of 10 km and a 30 m radius, with no map pin yet', async () => {
      await openBuilder();

      expect($('builder-cards').children).toHaveLength(3);
      expect(input('builder-max-walk-km').value).toBe('10');
      expect(bField(0, 'proximity').value).toBe('30');
      expect(bText(0, '.builder-pin-status')).toBe('No pin yet');
      expect(text('builder-loop')).toBe('Place two pins to see the loop.');
      expect(builderMarkers()).toHaveLength(0);
      expect(visible('builder-map')).toBe(true);
    });

    it('goes back to the designer form for Try again on a failed draft', async () => {
      server.drafts.set(FAILED, {
        id: FAILED,
        status: 'failed',
        request: { area: 'Chiswick, London', theme: 'The Thames', checkpoints: 3, 'max-walk-km': 3 },
        area: null,
        progress: [],
        checkpoints: [],
        route: null,
        problems: [],
        run: { runner: 'agent', model: null, turns: 0, 'cost-usd': 0, 'duration-ms': 1000, error: { code: 'max_turns' } },
        published: null,
        'created-at': '2026-10-08T08:00:00Z',
        'finished-at': '2026-10-08T08:01:00Z',
      });
      await loadPage(`/designer?draft=${FAILED}`);
      await chooseMode('manual');

      await click($('try-again'));

      expect(visible('design-form')).toBe(true);
      expect(visible('builder-form')).toBe(false);
      expect(input('area').value).toBe('Chiswick, London');
    });
  });

  describe('placing the pins', () => {
    it("drops the selected checkpoint's pin where the map is tapped, numbered as its card", async () => {
      await openBuilder();
      expect(selectedCards()).toEqual([0]);

      tap(...PINS[0]);
      select(2);
      tap(...PINS[2]);

      expect(builderMarkers().map((marker) => marker.getAttribute('aria-label'))).toEqual(['1. Unnamed place', '3. Unnamed place (selected)']);
      expect(bText(0, '.builder-pin-status')).toBe('Pin placed at 51.48000, -0.25000');
      expect(bText(1, '.builder-pin-status')).toBe('No pin yet');
      expect(bText(2, '.builder-pin-hint')).toBe('Tap the map to move this pin, or drag it.');
      expect(bText(1, '.builder-pin-hint')).toBe('Select this checkpoint to place its pin.');
      expect(document.querySelector('#builder-map path.route-loop')).not.toBeNull();
    });

    it("rounds a pin to about 10 cm and wraps a longitude from a map panned round the world", async () => {
      await openBuilder();

      tap(51.48000049, -0.25000049 + 360);

      expect(bText(0, '.builder-pin-status')).toBe('Pin placed at 51.48000, -0.25000');
    });

    it("selects the checkpoint whose card is touched, or whose marker is tapped, and scrolls to the card", async () => {
      await openBuilder();
      placeCheckpoint(0, 'a place', PINS[0]);
      placeCheckpoint(1, 'b place', PINS[1]);
      expect(selectedCards()).toEqual([1]);

      markerOf(1).fire('click');
      await settle();

      expect(selectedCards()).toEqual([0]);
      expect(document.activeElement).toBe(bCard(0));
      expect(builderMarkers().map((marker) => marker.classList.contains('route-marker--selected'))).toEqual([true, false]);
    });

    it('moves a pin that is dragged, and the loop with it', async () => {
      await fillHunt();
      const loopBefore = text('builder-loop');

      markerOf(2).setLatLng([51.49, -0.25]);
      markerOf(2).fire('dragend');
      await settle();

      expect(bText(1, '.builder-pin-status')).toBe('Pin placed at 51.49000, -0.25000');
      expect(text('builder-loop')).not.toBe(loopBefore);
    });

    it('shows the loop live against the longest walk, and says in words when it is too long', async () => {
      await fillHunt();
      expect(text('builder-loop')).toMatch(/^Loop: 1\.\d\d km \(longest walk 10 km\)$/);
      expect($('builder-loop').classList.contains('builder-loop--over')).toBe(false);

      type('builder-max-walk-km', '1');

      expect(text('builder-loop')).toMatch(/\(longest walk 1 km\): too long$/);
      expect($('builder-loop').classList.contains('builder-loop--over')).toBe(true);
    });

    it('says it is a loop so far while a pin is missing', async () => {
      await openBuilder();
      tap(...PINS[0]);
      select(1);
      tap(...PINS[1]);

      expect(text('builder-loop')).toMatch(/^Loop so far: /);
    });

    it('does not refit the map to a pin that is tapped: that would undo the organiser\'s pan and zoom', async () => {
      await openBuilder();
      tap(...PINS[0]);
      select(1);
      tap(...PINS[1]);

      expect(fitBounds).not.toHaveBeenCalled();
    });

    it("says when the map couldn't load, and the builder still works", async () => {
      setLeaflet(undefined);
      await openBuilder();

      expect(visible('builder-map')).toBe(false);
      expect(text('builder-map-note')).toMatch(/^The map couldn't load/);
      type('builder-0-name', 'The boathouse');
      expect(bField(0, 'name').value).toBe('The boathouse');
    });
  });

  describe('Use my location', () => {
    it('pins the checkpoint where the organiser stands, and brings the map there', async () => {
      geolocation.getCurrentPosition.mockImplementation((success: (position: unknown) => void) =>
        success({ coords: { latitude: 51.4812345678, longitude: -0.2512345678 } }),
      );
      await openBuilder();
      select(1);

      await click(bButton(1, 'locate'));

      expect(bText(1, '.builder-pin-status')).toBe('Pin placed at 51.48123, -0.25123');
      expect(geolocation.getCurrentPosition.mock.calls[0]![2]).toMatchObject({ enableHighAccuracy: true });
      expect(builderMarkers().map((marker) => marker.textContent)).toEqual(['2']);
      expect(fitBounds).toHaveBeenCalled();
      expect(selectedCards()).toEqual([1]);
    });

    it.each([
      [1, /refused/],
      [2, /isn't available/],
      [3, /too long/],
    ])('says what to do when the position fails with code %s, and places no pin', async (code, words) => {
      geolocation.getCurrentPosition.mockImplementation((_success: unknown, failure: (error: unknown) => void) => failure({ code }));
      await openBuilder();

      await click(bButton(0, 'locate'));

      expect(bText(0, '.builder-locate-error')).toMatch(words);
      expect(visible('builder-form')).toBe(true);
      expect(bText(0, '.builder-pin-status')).toBe('No pin yet');
      expect(builderMarkers()).toHaveLength(0);
    });

    it('clears the message once a pin is placed some other way', async () => {
      geolocation.getCurrentPosition.mockImplementation((_success: unknown, failure: (error: unknown) => void) => failure({ code: 1 }));
      await openBuilder();
      await click(bButton(0, 'locate'));

      tap(...PINS[0]);

      expect(bCard(0).querySelector<HTMLElement>('.builder-locate-error')!.hidden).toBe(true);
    });

    it('says so in a browser with no geolocation', async () => {
      Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
      await openBuilder();

      await click(bButton(0, 'locate'));

      expect(bText(0, '.builder-locate-error')).toMatch(/can't share its location/);
    });

    it("pins the checkpoint that asked, even if it moved while the position was found", async () => {
      let answer: (position: unknown) => void = () => undefined;
      geolocation.getCurrentPosition.mockImplementation((success: (position: unknown) => void) => {
        answer = success;
      });
      await openBuilder();
      type('builder-0-name', 'The boathouse');
      await click(bButton(0, 'locate'));

      await click(bButton(0, 'down'));
      answer({ coords: { latitude: 51.48, longitude: -0.25 } });
      await settle();

      expect(names()).toEqual(['', 'The boathouse', '']);
      expect(bText(0, '.builder-pin-status')).toBe('No pin yet');
      expect(bText(1, '.builder-pin-status')).toBe('Pin placed at 51.48000, -0.25000');
    });
  });

  describe('adding, removing and moving checkpoints', () => {
    it('adds up to 8 and removes down to 3', async () => {
      await openBuilder();

      for (let count = 3; count < 8; count += 1) {
        await click($('builder-add'));
      }
      expect($('builder-cards').children).toHaveLength(8);
      expect(input('builder-add').disabled).toBe(true);
      expect(selectedCards()).toEqual([7]);
      expect(document.activeElement).toBe(bField(7, 'name'));

      for (let count = 8; count > 3; count -= 1) {
        await click(bButton(0, 'remove'));
      }
      expect($('builder-cards').children).toHaveLength(3);
      expect(bButton(0, 'remove').disabled).toBe(true);
      expect(input('builder-add').disabled).toBe(false);
    });

    it('moves a checkpoint with everything typed and pinned in it, and the selection stays with it', async () => {
      await fillHunt();
      select(0);

      await click(bButton(0, 'down'));

      expect(names()).toEqual(['The bridge', 'The boathouse', 'The pier']);
      expect(bField(1, 'clue').value).toBe('Clue for The boathouse');
      expect(bText(1, '.builder-pin-status')).toBe('Pin placed at 51.48000, -0.25000');
      expect(selectedCards()).toEqual([1]);
      // The markers are numbered by the new order.
      expect(markerOf(2).options.title).toBe('2. The boathouse (selected)');
      expect(document.activeElement).toBe(bButton(1, 'down'));

      await click(bButton(1, 'up'));
      expect(names()).toEqual(NAMES);
    });

    it("can't move the first one up, the last one down, or remove below 3", async () => {
      await openBuilder();

      expect(bButton(0, 'up').disabled).toBe(true);
      expect(bButton(2, 'down').disabled).toBe(true);
      expect(bButton(1, 'up').disabled).toBe(false);
    });

    it('takes a removed checkpoint, and its pin, off the map and selects the card that takes its place', async () => {
      await fillHunt();
      await click($('builder-add'));
      type('builder-3-name', 'The last');

      await click(bButton(0, 'remove'));

      expect(names()).toEqual(['The bridge', 'The pier', 'The last']);
      expect(builderMarkers().map((marker) => marker.getAttribute('aria-label'))).toEqual(['1. The bridge (selected)', '2. The pier']);
      expect(selectedCards()).toEqual([0]);
      // Down to 3, Remove is disabled: focus stays with the card.
      expect(document.activeElement).toBe(bCard(0));
    });

    it('selects the one before when the last checkpoint is removed', async () => {
      await openBuilder();
      await click($('builder-add'));
      select(3);

      await click(bButton(3, 'remove'));

      expect(selectedCards()).toEqual([2]);
    });
  });

  describe('checking the form before it is sent', () => {
    it('sends nothing, and says what is wrong under each field, with the first one focused', async () => {
      await openBuilder();
      type('builder-0-name', 'The boathouse');
      type('builder-0-proximity', '19');

      await submit('builder-form');

      expect(server.posts()).toHaveLength(0);
      expect(text('builder-area-error')).toBe('Enter the area: at least 3 characters.');
      expect(text('builder-theme-error')).toBe('Enter the theme: at least 3 characters.');
      expect(text('builder-0-clue-error')).toBe("The clue can't be empty.");
      expect(text('builder-0-proximity-error')).toBe('Choose a whole number of metres from 20 to 100.');
      expect(text('builder-1-name-error')).toBe("Enter the place's name.");
      expect(bCard(0).querySelector('.builder-pin-error')!.textContent).toBe('Place its pin on the map.');
      expect(bField(0, 'proximity').getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(input('builder-area'));
    });

    it('focuses the first card with a problem once the top fields are right', async () => {
      await fillHunt();
      type('builder-1-scene', '');

      await submit('builder-form');

      expect(server.posts()).toHaveLength(0);
      expect(document.activeElement).toBe(bField(1, 'scene'));
    });

    it('clears a message as soon as its field is typed in', async () => {
      await openBuilder();
      await submit('builder-form');
      expect(visible('builder-area-error')).toBe(true);

      type('builder-area', 'Chiswick');

      expect(visible('builder-area-error')).toBe(false);
      expect(visible('builder-theme-error')).toBe(true);
      type('builder-0-name', 'x');
      expect(visible('builder-0-name-error')).toBe(false);
    });

    it("counts a text field's characters against its limit", async () => {
      await openBuilder();

      type('builder-0-clue', 'x'.repeat(301));

      expect(text('builder-0-clue-count')).toBe('301 / 300');
      expect($('builder-0-clue-count').classList.contains('counter--over')).toBe(true);
    });
  });

  describe('sending the hunt', () => {
    it('posts the hunt to the manual relay with the token, then opens the new draft for review', async () => {
      await fillHunt();

      await submit('builder-form');

      expect(server.posts()).toEqual([
        { method: 'POST', url: '/designer/drafts/manual', authorization: `Bearer ${TOKEN}`, body: huntRequest },
      ]);
      expect(window.location.search).toBe(`?draft=${DRAFT}`);
      expect(text('draft-status')).toBe('Ready');
      expect(visible('draft-review')).toBe(true);
      expect(text('draft-title')).toBe('Chiswick, London');
      expect($('cards').children).toHaveLength(3);
      expect([0, 1, 2].map((index) => cardText(index + 1, '.review-badge'))).toEqual(['To review', 'To review', 'To review']);
      // Reviewed with the same fields as any draft, with the pins on the route map.
      expect(input('card-1-clue').value).toBe('Clue for The boathouse');
      expect(input('card-1-proximity').value).toBe('30');
      expect(mapMarkers()).toHaveLength(3);
      // Unlike a designed hunt, a placed one has no polling to do.
      expect(server.draftReads()).toHaveLength(1);
    });

    it('says it was placed by hand, with no run, rationale, kind or OpenStreetMap link', async () => {
      await fillHunt();
      await submit('builder-form');

      expect(text('draft-elapsed')).toBe('Placed by hand');
      expect(text('draft-elapsed')).not.toMatch(/turn|\$|Took/);
      for (const position of [1, 2, 3]) {
        expect(card(position).querySelector('.card-rationale')).toBeNull();
        expect(card(position).querySelector('.osm-link')).toBeNull();
        expect(card(position).querySelector('.card-kind')).toBeNull();
      }
      expect(cardText(1, '.card-name')).toBe('1. The boathouse');
    });

    it('lists the draft as placed by hand', async () => {
      await fillHunt();
      await submit('builder-form');

      expect(items('drafts')[0]).toContain('Placed by hand');
      expect(items('drafts')[0]).not.toContain('$');
    });

    it('starts the builder again, empty, once the draft is made', async () => {
      await fillHunt();
      await submit('builder-form');

      expect(input('builder-area').value).toBe('');
      expect(names()).toEqual(['', '', '']);
      expect(builderMarkers()).toHaveLength(0);
      expect(text('builder-loop')).toBe('Place two pins to see the loop.');
    });

    it('sends only once while it is on its way', async () => {
      await fillHunt();

      const first = submit('builder-form');
      await submit('builder-form');
      await first;

      expect(server.posts()).toHaveLength(1);
    });

    it('goes on through review and publish like any draft', async () => {
      await fillHunt();
      await submit('builder-form');
      for (const position of [1, 2, 3]) {
        await clickCard(position, 'accepted');
      }
      expect(input('publish-button').disabled).toBe(false);
    });
  });

  describe('when the game-server turns the hunt down', () => {
    const problems = {
      status: 422,
      body: {
        detail: 'draft problems',
        problems: [
          { code: 'names_place', position: 2, message: 'Checkpoint 2\'s clue gives the place away ("bridge"); describe it without its name' },
          { code: 'too_close', position: 3, message: 'Checkpoints 2 and 3 are 90 m apart; keep them at least 150 m apart' },
          { code: 'route_too_long', position: null, message: 'The loop is 12 km; keep it to 10 km' },
        ],
      },
    };

    it("shows each problem on its checkpoint's card and field, and the rest above the button, and keeps what was typed", async () => {
      await fillHunt();
      server.state.manualAnswer = problems;

      await submit('builder-form');

      expect(window.location.search).toBe('');
      expect(visible('builder-error')).toBe(true);
      expect(text('builder-error-text')).toBe("The game-server didn't accept this hunt:");
      expect(items('builder-error-lines')).toEqual(['The loop is 12 km; keep it to 10 km']);
      expect(text('builder-1-clue-error')).toBe('Checkpoint 2\'s clue gives the place away ("bridge"); describe it without its name');
      expect(bField(1, 'clue').getAttribute('aria-invalid')).toBe('true');
      expect(bCard(2).querySelector('.builder-pin-error')!.textContent).toBe('Checkpoints 2 and 3 are 90 m apart; keep them at least 150 m apart');
      expect(visible('builder-0-clue-error')).toBe(false);
      expect(names()).toEqual(NAMES);
      expect(builderMarkers()).toHaveLength(3);
      expect(input('builder-button').disabled).toBe(false);
    });

    it('lets it be fixed and sent again', async () => {
      await fillHunt();
      server.state.manualAnswer = problems;
      await submit('builder-form');

      type('builder-1-clue', 'Where the road crosses the water');
      expect(visible('builder-1-clue-error')).toBe(false);
      server.state.manualAnswer = null;
      await submit('builder-form');

      expect(server.posts()).toHaveLength(2);
      expect(window.location.search).toBe(`?draft=${DRAFT}`);
      expect(visible('builder-error')).toBe(false);
    });

    it('forgets the positions of problems when the checkpoints change order', async () => {
      await fillHunt();
      server.state.manualAnswer = problems;
      await submit('builder-form');

      await click(bButton(1, 'up'));

      expect(visible('builder-1-clue-error')).toBe(false);
      expect(visible('builder-error')).toBe(false);
    });

    it('says when the game-server cannot be reached, and keeps the hunt', async () => {
      await fillHunt();
      server.state.offline = true;

      await submit('builder-form');

      expect(text('builder-error-text')).toBe('No connection to the game server.');
      expect(names()).toEqual(NAMES);
    });

    it('turns away an account that is not an organiser, with nothing left on screen', async () => {
      await fillHunt();
      server.state.forbidden = true;

      await submit('builder-form');

      expect(visible('workspace')).toBe(false);
      expect(text('sign-in-error')).toBe("This account isn't an organiser.");
      expect(input('builder-area').value).toBe('');
      expect(names()).toEqual(['', '', '']);
      expect(builderMarkers()).toHaveLength(0);
    });
  });

  describe('Edit in builder', () => {
    it('is offered on a ready draft placed by hand', async () => {
      await fillHunt();
      await submit('builder-form');

      expect(visible('edit-in-builder')).toBe(true);
    });

    it('is not offered on a designed one', async () => {
      await openReadyDraft();

      expect(visible('edit-in-builder')).toBe(false);
    });

    it('is not offered on a published one', async () => {
      await fillHunt();
      await submit('builder-form');
      server.drafts.get(DRAFT)!.status = 'published';
      await reloadPage(`/designer?draft=${DRAFT}`);

      expect(visible('edit-in-builder')).toBe(false);
    });

    it('opens the builder filled in from the draft, with its pins, and sending it makes a new draft', async () => {
      await fillHunt();
      await submit('builder-form');
      await clickCard(2, 'rejected');
      server.state.nextId = SECOND;

      await click($('edit-in-builder'));

      expect(visible('builder-form')).toBe(true);
      expect(visible('design-form')).toBe(false);
      expect(input('builder-area').value).toBe('Chiswick, London');
      expect(input('builder-theme').value).toBe('Riverside pubs');
      expect(input('builder-max-walk-km').value).toBe('10');
      expect(names()).toEqual(NAMES);
      expect(bField(2, 'pose').value).toBe('Pose for The pier');
      expect(builderMarkers()).toHaveLength(3);
      expect(fitBounds).toHaveBeenCalled();
      expect(document.activeElement).toBe(input('builder-area'));

      select(1);
      type('builder-1-name', 'The footbridge');
      tap(51.486, -0.25);
      await submit('builder-form');

      expect(server.posts()).toHaveLength(2);
      expect(server.posts()[1]!.body).toEqual({
        ...huntRequest,
        checkpoints: [
          huntRequest.checkpoints[0],
          { ...huntRequest.checkpoints[1], name: 'The footbridge', location: { lat: 51.486, long: -0.25 } },
          huntRequest.checkpoints[2],
        ],
      });
      expect(window.location.search).toBe(`?draft=${SECOND}`);
      // The first draft is as it was, review and all.
      expect(server.drafts.get(DRAFT)!.status).toBe('ready');
      expect(items('drafts')).toHaveLength(2);
      // The new draft starts again: every checkpoint pending.
      expect([1, 2, 3].map((position) => cardText(position, '.review-badge'))).toEqual(['To review', 'To review', 'To review']);
    });
  });

  describe('privacy', () => {
    it('writes nothing of the hunt to storage, the URL or the console, and a reload starts again', async () => {
      geolocation.getCurrentPosition.mockImplementation((success: (position: unknown) => void) =>
        success({ coords: { latitude: 51.4812345678, longitude: -0.2512345678 } }),
      );
      await fillHunt();
      await click(bButton(0, 'locate'));
      await submit('builder-form');
      await click($('edit-in-builder'));

      expect(localSetItem).not.toHaveBeenCalled();
      expect(localStorage).toHaveLength(0);
      expect(sessionStorage).toHaveLength(0);
      expect(window.location.search).toBe(`?draft=${DRAFT}`);
      for (const secret of ['Clue for The boathouse', 'Scene for The boathouse', '51.48', '-0.25']) {
        expect(window.location.href).not.toContain(secret);
      }
      for (const spy of logged) {
        expect(spy).not.toHaveBeenCalled();
      }

      await reloadPage('/designer');
      await chooseMode('manual');
      expect(input('builder-area').value).toBe('');
      expect(names()).toEqual(['', '', '']);
    });
  });
});

describe('privacy', () => {
  it('writes nothing from a draft, and never the token, to localStorage, the URL or the console', async () => {
    await loadPage();
    fillDesign({ area: 'Chiswick, London', theme: 'The Thames and brewing history' });
    await submit('design-form');
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
    }
    expect(text('draft-status')).toBe('Ready');
    expect(input('card-1-clue').value).toBe('Where old lamps once lit the way in.');

    expect(localSetItem).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
    // Nothing is kept in sessionStorage either: the account holds the sign-in.
    expect(sessionStorage).toHaveLength(0);
    // The URL holds the draft's id and nothing else.
    expect(window.location.search).toBe(`?draft=${DRAFT}`);
    expect(window.location.hash).toBe('');
    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('writes no code, clue, scene or coordinate to storage, the URL or the console while reviewing and publishing', async () => {
    await openReadyDraft();
    // The map, both ways: a marker to its card, and a card's name to its marker.
    mapMarker(2).click();
    placeButton(card(3)).click();
    await settle();
    type('card-1-scene', 'A lamp on a stone gatepost, ivy behind.');
    await clickCard(1, 'save');
    for (const position of [1, 2, 3]) {
      await clickCard(position, 'accepted');
    }
    input('hunt-name').value = 'Chiswick river hunt';
    input('start-time').value = '2026-10-11T10:00';
    input('end-time').value = '2026-10-11T12:00';
    type('team-1', 'Red Foxes');
    type('team-2', 'Blue Herons');
    await submit('publish-form');
    $('publish-ok').click();
    await settle();
    await reloadPage(`/designer?draft=${DRAFT}`);
    expect(items('team-codes')).toHaveLength(2);

    const secrets = [
      MODERATOR_CODE,
      'RED-7Q2K',
      'BLUE-7Q2K',
      'Where old lamps once lit the way in.',
      'A lamp on a stone gatepost, ivy behind.',
      '51.49',
      '-0.26',
    ];
    expect(localSetItem).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
    // Nothing is kept in sessionStorage either: the account holds the sign-in.
    expect(sessionStorage).toHaveLength(0);
    for (const secret of secrets) {
      expect(window.location.href).not.toContain(secret);
    }
    expect(window.location.search).toBe(`?draft=${DRAFT}`);
    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
