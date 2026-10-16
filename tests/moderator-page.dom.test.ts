// @vitest-environment happy-dom
//
// The moderator page (issues #44, #55 and #67), run in a DOM against a stub of
// the game-server's moderator API behind this app's relays: the page's own
// moderator.js, with fetch answered in memory. Only what #67 changed is
// covered here: signing in with an account instead of a code, the 403
// message, and adding and removing moderators by email address. The logic
// is tested in moderator-logic.test.ts and the relays in app.test.ts.
// authorised-fetch.js, which loads Clerk and adds the session token, is
// replaced by a stand-in that sends a token while the visitor is signed in.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'clerk-session-token';
const SESSION = '11111111-1111-4111-8111-111111111111';

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

const html = readFileSync(path.join(import.meta.dirname, '..', 'src', 'public', 'moderator.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');

interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

const OVERVIEW = {
  session: {
    phase: 'running',
    'planned-start': '2026-10-03T10:00:00+01:00',
    'planned-end': '2026-10-03T13:00:00+01:00',
    'started-at': '2026-10-03T09:02:11Z',
    'stopped-at': null,
    'server-time': '2026-10-03T09:02:11Z',
  },
  teams: [],
  blocked: [],
};

function response(status: number, payload?: unknown) {
  const text = payload === undefined ? '' : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(text),
    blob: () => Promise.resolve(new Blob([])),
  };
}

function stubGameServer() {
  const calls: Call[] = [];
  const state = {
    token: TOKEN,
    forbidden: false,
    /** What an add answers; null → the pid below. */
    addAnswer: null as { status: number; body: unknown } | null,
    removeStatus: 204,
    offline: false,
  };
  const fetchStub = vi.fn((url: string, init: RequestInit = {}) => {
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
      return Promise.resolve(response(401, { detail: 'unauthorised', code: 'unauthorised' }));
    }
    if (state.forbidden) {
      return Promise.resolve(response(403, { detail: 'forbidden', code: 'forbidden' }));
    }
    if (url.startsWith('/moderator/overview')) {
      return Promise.resolve(response(200, OVERVIEW));
    }
    if (url.startsWith('/moderator/review')) {
      return Promise.resolve(response(200, { 'to-review': [], recent: [] }));
    }
    if (call.method === 'POST' && url === '/moderator/moderators') {
      return Promise.resolve(state.addAnswer ? response(state.addAnswer.status, state.addAnswer.body) : response(201, { session: SESSION, pid: 'p_8f3a' }));
    }
    if (call.method === 'DELETE' && url.startsWith('/moderator/moderators')) {
      return Promise.resolve(response(state.removeStatus));
    }
    return Promise.resolve(response(404, { detail: 'not found' }));
  });
  return { calls, state, fetch: fetchStub, moderatorCalls: () => calls.filter((call) => call.url.includes('/moderator/moderators')) };
}

const listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = [];

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    for (let j = 0; j < 20; j += 1) {
      await Promise.resolve();
    }
  }
}

async function loadPage(url = `/moderator?session=${SESSION}`) {
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
  await import('../src/public/moderator.js');
  await settle();
}

const $ = (id: string) => document.getElementById(id)!;
const text = (id: string) => $(id).textContent?.trim() ?? '';
const visible = (id: string) => {
  for (let node: HTMLElement | null = $(id); node; node = node.parentElement) {
    if (node.hidden) {
      return false;
    }
  }
  return true;
};

async function addModerator(email: string) {
  ($('moderator-email') as HTMLInputElement).value = email;
  $('moderator-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

const added = () => [...$('moderator-added').querySelectorAll('li')].map((li) => li.textContent);

let server: ReturnType<typeof stubGameServer>;
let sessionStorageSet: ReturnType<typeof vi.fn>;
let logged: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-03T09:02:11Z') });
  account.status = 'signed-in';
  account.token = TOKEN;
  server = stubGameServer();
  vi.stubGlobal('fetch', server.fetch);
  sessionStorageSet = vi.fn();
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: sessionStorageSet, removeItem: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: sessionStorageSet, removeItem: vi.fn() });
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
});

describe('signing in with an account', () => {
  it('shows the dashboard to a signed-in moderator, every call carrying the token, nothing typed or kept', async () => {
    await loadPage();

    expect(visible('dashboard')).toBe(true);
    expect(visible('sign-in')).toBe(false);
    expect(server.calls.map((call) => call.url)).toEqual([
      `/moderator/overview?session=${SESSION}`,
      `/moderator/review?session=${SESSION}`,
    ]);
    expect(server.calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(document.getElementById('moderator-code')).toBeNull();
    expect(document.getElementById('sign-out')).toBeNull();
    expect(sessionStorageSet).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('asks a signed-out visitor to sign in, with a link that comes back here, and calls nothing', async () => {
    account.status = 'signed-out';
    await loadPage();

    expect(visible('sign-in')).toBe(true);
    expect(visible('dashboard')).toBe(false);
    expect(text('sign-in-text')).toBe('Sign in with your account to moderate this session.');
    expect($('sign-in-link').getAttribute('href')).toBe(
      `/sign-in?redirect=${encodeURIComponent(`/moderator?session=${SESSION}`)}`,
    );
    expect(server.calls).toHaveLength(0);
  });

  it.each([
    ['not-set-up', "Sign-in isn't set up yet."],
    ['unavailable', "Sign-in couldn't load. Check your connection and reload the page."],
  ])('says so, with no link, when sign-in is %s', async (status, message) => {
    account.status = status;
    await loadPage();

    expect(text('sign-in-error')).toBe(message);
    expect(visible('sign-in-link')).toBe(false);
    expect(server.calls).toHaveLength(0);
  });

  it("says this account isn't a moderator of this hunt on a 403, and stops polling", async () => {
    server.state.forbidden = true;
    await loadPage();

    expect(visible('sign-in')).toBe(true);
    expect(visible('dashboard')).toBe(false);
    expect(text('sign-in-error')).toBe("This account isn't a moderator of this hunt.");
    expect(visible('sign-in-link')).toBe(false);
    const before = server.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.calls).toHaveLength(before);
  });

  it('says to sign in again when the token stops being accepted, and stops polling', async () => {
    await loadPage();
    expect(visible('dashboard')).toBe(true);

    server.state.token = 'a-new-token';
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(visible('sign-in')).toBe(true);
    expect(visible('dashboard')).toBe(false);
    expect(text('sign-in-error')).toBe(
      "Your sign-in wasn't accepted. Sign out from the account menu and sign in again.",
    );
    const before = server.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.calls).toHaveLength(before);
  });

  it('still says there is no session when the link has none', async () => {
    await loadPage('/moderator');

    expect(visible('no-session')).toBe(true);
    expect(server.calls).toHaveLength(0);
  });
});

describe('Moderators', () => {
  it('adds one by email address, sends only the session and the email, and lists them with a Remove', async () => {
    await loadPage();

    await addModerator('  Bob@Example.com ');

    expect(server.moderatorCalls()).toEqual([
      {
        method: 'POST',
        url: '/moderator/moderators',
        authorization: `Bearer ${TOKEN}`,
        body: { session: SESSION, email: 'Bob@Example.com' },
      },
    ]);
    expect(added()).toEqual(['Bob@Example.comRemove']);
    expect(($('moderator-email') as HTMLInputElement).value).toBe('');
    expect(visible('moderator-error')).toBe(false);
  });

  it("says 'ask them to sign up first' when there is no account with that email address", async () => {
    server.state.addAnswer = { status: 404, body: { detail: 'no account', code: 'no_account' } };
    await loadPage();

    await addModerator('nobody@example.com');

    expect(text('moderator-error')).toBe('No account with that email address: ask them to sign up first.');
    expect(added()).toEqual([]);
    // The page itself carries on.
    expect(visible('dashboard')).toBe(true);
  });

  it.each([
    [409, "That account isn't an organiser, so it can't moderate. Ask an admin to make them one."],
    [403, "This account can't change this hunt's moderators."],
  ])('shows a %i on the form, without leaving the page', async (status, message) => {
    server.state.addAnswer = { status, body: { code: 'x' } };
    await loadPage();

    await addModerator('bob@example.com');

    expect(text('moderator-error')).toBe(message);
    expect(visible('dashboard')).toBe(true);
  });

  it.each(['', 'bob', 'bob@'])('checks %j in the page first, and sends nothing', async (email) => {
    await loadPage();

    await addModerator(email);

    expect(text('moderator-error')).toBe('Enter the email address they signed up with.');
    expect(server.moderatorCalls()).toHaveLength(0);
  });

  it('lists someone once, however often they are added', async () => {
    await loadPage();

    await addModerator('bob@example.com');
    await addModerator('bob@example.com');

    expect(added()).toEqual(['bob@example.comRemove']);
  });

  it('removes one by the pid the game-server answered with', async () => {
    await loadPage();
    await addModerator('bob@example.com');

    ($('moderator-added').querySelector('button') as HTMLButtonElement).click();
    await settle();

    expect(server.moderatorCalls()[1]).toEqual({
      method: 'DELETE',
      url: `/moderator/moderators?${new URLSearchParams({ session: SESSION, pid: 'p_8f3a' })}`,
      authorization: `Bearer ${TOKEN}`,
      body: undefined,
    });
    expect(added()).toEqual([]);
  });

  it('treats a 404 on remove as already removed', async () => {
    server.state.removeStatus = 404;
    await loadPage();
    await addModerator('bob@example.com');

    ($('moderator-added').querySelector('button') as HTMLButtonElement).click();
    await settle();

    expect(added()).toEqual([]);
    expect(visible('moderator-error')).toBe(false);
  });

  it('keeps them listed, and says so, when a remove fails', async () => {
    server.state.removeStatus = 500;
    await loadPage();
    await addModerator('bob@example.com');

    ($('moderator-added').querySelector('button') as HTMLButtonElement).click();
    await settle();

    expect(added()).toEqual(['bob@example.comRemove']);
    expect(text('moderator-error')).toBe('Something went wrong (error 500).');
  });

  it('keeps the email addresses in memory only, and clears them when the account is turned away', async () => {
    await loadPage();
    await addModerator('bob@example.com');
    expect(sessionStorageSet).not.toHaveBeenCalled();

    server.state.token = 'a-new-token';
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(visible('dashboard')).toBe(false);
    expect($('moderator-added').children).toHaveLength(0);
    expect(document.body.textContent).not.toContain('bob@example.com');
  });

  it('writes nothing about the people to the console or the URL', async () => {
    await loadPage();
    await addModerator('bob@example.com');

    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(window.location.href).not.toContain('bob');
    expect(window.location.href).not.toContain('p_8f3a');
  });
});
