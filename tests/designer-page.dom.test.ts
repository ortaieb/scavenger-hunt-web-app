// @vitest-environment happy-dom
//
// The hunt designer page (issue #59), run in a DOM against a stub of the
// game-server's designer API behind this app's relays: the page's own
// designer.js, with fetch answered in memory. The relays themselves are
// tested in app.test.ts. Type-checked with the DOM's types by
// tsconfig.dom.json.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'organiser-key-of-at-least-24-chars';
const KEY_STORAGE_KEY = 'scavenger-hunt.organiserKey';
const DRAFT = '5b0c7a1e-1111-4111-8111-111111111111';
const FAILED = '5b0c7a1e-2222-4222-8222-222222222222';
const RUNNING = '5b0c7a1e-3333-4333-8333-333333333333';

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
  place: { osm: `node/900000000${index + 1}`, name, kind: 'historic=memorial', location: { lat: 51.49, long: -0.26 } },
  clue,
  challenge: { scene: `The ${name} seen from the path.`, pose },
  proximity: 30,
  rationale: 'A fixed stub checkpoint.',
  review: 'pending',
  edited: false,
  original: null,
}));

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
  const state = {
    key: KEY,
    busy: false,
    disabled: false,
    offline: false,
    nextId: DRAFT,
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
    if (call.authorization !== `Bearer ${state.key}`) {
      return Promise.resolve(json(401, { detail: 'organiser key required', code: 'organiser_unauthorised' }));
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
    if (call.method === 'GET' && url === '/designer/drafts') {
      const list = [...drafts.values()].reverse().map((draft) => ({
        id: draft.id,
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
            checkpoints: STUB_CHECKPOINTS,
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

  const draftReads = () => calls.filter((call) => call.method === 'GET' && call.url.startsWith('/designer/drafts/'));
  const posts = () => calls.filter((call) => call.method === 'POST');

  return { fetch, calls, drafts, state, draftReads, posts };
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

async function loadPage(url = '/designer') {
  window.history.replaceState(null, '', url);
  document.body.innerHTML = body;
  for (const target of [document, window] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) {
        listeners.push([target, type, listener]);
      }
      add(type, listener, options);
    });
  }
  vi.resetModules();
  await import('../src/public/designer.js');
  await settle();
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
  vi.useFakeTimers({ now: Date.parse('2026-10-08T09:00:00Z') });
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('a design runs to the end', () => {
  it('posts the right body, then polls the draft, shows the progress steps and stops polling at ready', async () => {
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
        authorization: `Bearer ${KEY}`,
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

    // Ready: its checkpoints, read-only, and no more polling.
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(text('draft-status')).toBe('Ready');
    expect(visible('draft-ready')).toBe(true);
    expect(items('checkpoints')).toEqual([
      '1. Stub Lantern Gate Clue Where old lamps once lit the way in. Pose Point at the lantern',
      '2. Stub Riverside Bench Clue A seat with a view of the water. Pose Sit as if waiting for a boat',
      "3. Stub Brewers' Arch Clue Pass under the curve where barrels once rolled. Pose Roll an invisible barrel",
    ]);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
    await loadPage();
    server.state.offline = true;

    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');

    expect(text('design-error-text')).toBe('No connection to the game server. Try again.');
    expect(($('design-button') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the key', () => {
  it('is asked for, checked, and kept in sessionStorage only', async () => {
    await loadPage();

    expect(visible('sign-in')).toBe(true);
    expect(visible('workspace')).toBe(false);
    expect(server.calls).toHaveLength(0);

    input('organiser-key').value = `  ${KEY} `;
    await submit('sign-in-form');

    expect(server.calls[0]).toMatchObject({ url: '/designer/drafts', authorization: `Bearer ${KEY}` });
    expect(visible('workspace')).toBe(true);
    expect(visible('sign-out')).toBe(true);
    expect(input('organiser-key').value).toBe('');
    expect(sessionStorage.getItem(KEY_STORAGE_KEY)).toBe(KEY);
    expect(localSetItem).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(KEY);
  });

  it('asks again after a wrong key, without keeping it', async () => {
    await loadPage();

    input('organiser-key').value = 'not-the-key';
    await submit('sign-in-form');

    expect(visible('sign-in')).toBe(true);
    expect(text('sign-in-error')).toBe("That organiser key isn't right.");
    expect(sessionStorage.getItem(KEY_STORAGE_KEY)).toBeNull();
    expect(text('sign-in-error')).not.toContain('not-the-key');
  });

  it.each(['the drafts list', 'the draft'])('a 401 from %s clears the key and asks again', async (which) => {
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
    await loadPage();
    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');
    expect(visible('draft-panel')).toBe(true);

    // The key is changed on the game-server.
    server.state.key = 'a-new-key-of-at-least-24-chars';
    if (which === 'the drafts list') {
      setVisibility('hidden');
      setVisibility('visible');
    } else {
      await vi.advanceTimersByTimeAsync(2000);
    }
    await settle();

    expect(visible('sign-in')).toBe(true);
    expect(text('sign-in-error')).toBe("That organiser key isn't right.");
    expect(sessionStorage.getItem(KEY_STORAGE_KEY)).toBeNull();
    // Nothing from the draft is left on the page.
    expect($('steps').children).toHaveLength(0);
    expect($('drafts').children).toHaveLength(0);
    // And the polling has stopped.
    const before = server.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.calls).toHaveLength(before);
  });

  it('a 401 when starting a design clears the key and asks again', async () => {
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
    await loadPage();
    server.state.key = 'a-new-key-of-at-least-24-chars';

    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');

    expect(visible('sign-in')).toBe(true);
    expect(sessionStorage.getItem(KEY_STORAGE_KEY)).toBeNull();
  });

  it('is forgotten with Forget key', async () => {
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
    await loadPage();

    $('sign-out').click();

    expect(sessionStorage.getItem(KEY_STORAGE_KEY)).toBeNull();
    expect(visible('sign-in')).toBe(true);
    expect(visible('sign-out')).toBe(false);
  });

  it('lives in memory when sessionStorage throws, and still never in localStorage', async () => {
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    await loadPage();

    input('organiser-key').value = KEY;
    await submit('sign-in-form');
    fillDesign({ area: 'Chiswick', theme: 'Brewing' });
    await submit('design-form');

    expect(visible('workspace')).toBe(true);
    expect(server.posts()[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(localSetItem).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
    Object.assign(server.drafts.get(FAILED)!, { progress: [], problems: [], run: { error: { code: 'interrupted' } } });
    await loadPage(`/designer?draft=${FAILED}`);

    expect(text('failure-text')).toBe('The server restarted during the run.');
    expect(visible('problems-block')).toBe(false);
    expect(visible('steps-block')).toBe(false);
  });

  it('Try again fills in the form with the same request', async () => {
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
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
    sessionStorage.setItem(KEY_STORAGE_KEY, KEY);
    await loadPage(`/designer?draft=${RUNNING}`);

    expect(text('draft-error')).toBe('No draft with this id. Check the link.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.draftReads()).toHaveLength(1);
  });
});

describe('privacy', () => {
  it('writes nothing from a draft, and never the key, to localStorage, the URL or the console', async () => {
    await loadPage();
    input('organiser-key').value = KEY;
    await submit('sign-in-form');
    fillDesign({ area: 'Chiswick, London', theme: 'The Thames and brewing history' });
    await submit('design-form');
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(2000);
      await settle();
    }
    expect(text('draft-status')).toBe('Ready');
    expect($('checkpoints').textContent).toContain('Where old lamps once lit the way in.');

    expect(localSetItem).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
    // sessionStorage holds the key and nothing else.
    expect([...sessionStorage.items]).toEqual([[KEY_STORAGE_KEY, KEY]]);
    // The URL holds the draft's id and nothing else.
    expect(window.location.search).toBe(`?draft=${DRAFT}`);
    expect(window.location.hash).toBe('');
    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
