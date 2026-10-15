import { describe, expect, it } from 'vitest';
import {
  accountHref,
  clerkConfigured,
  clerkScriptUrl,
  DEFAULT_RETURN_PATH,
  readReturnPath,
  returnPath,
} from '../src/public/account-logic.js';

describe('returnPath', () => {
  it.each([
    ['/play', '/play'],
    ['/moderator?session=11111111-1111-4111-8111-111111111111', '/moderator?session=11111111-1111-4111-8111-111111111111'],
    // A hunt link with a join code has to survive the round trip.
    ['/play?code=FOX-1234', '/play?code=FOX-1234'],
    ['/play?code=FOX-1234&team=a%20b#top', '/play?code=FOX-1234&team=a%20b#top'],
    ['/a/../play', '/play'],
    ['/https://example.com', '/https://example.com'],
  ])('keeps the same-origin path %s', (value, expected) => {
    expect(returnPath(value)).toBe(expected);
  });

  it.each([
    ['a full URL', 'https://evil.example/play'],
    ['a scheme-relative URL', '//evil.example/play'],
    ['a backslash host', '/\\evil.example'],
    ['a backslash after a path', '/play\\..\\x'],
    ['a tab inside the slashes', '/\t/evil.example'],
    ['a newline', '/play\nSet-Cookie: x=1'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a relative path', 'play'],
    ['an empty string', ''],
    ['nothing', undefined],
    ['null', null],
    ['a non-string', 42],
  ])('falls back to /play for %s', (_name, value) => {
    expect(returnPath(value)).toBe(DEFAULT_RETURN_PATH);
  });

  it('reads the redirect parameter of a query string', () => {
    expect(readReturnPath('?redirect=%2Fplay%3Fcode%3DFOX-1234')).toBe('/play?code=FOX-1234');
    expect(readReturnPath('?redirect=https%3A%2F%2Fevil.example')).toBe('/play');
    expect(readReturnPath('?other=1')).toBe('/play');
    expect(readReturnPath('')).toBe('/play');
  });
});

describe('accountHref', () => {
  it('links to a page that comes back to the path, join code and all', () => {
    const href = accountHref('sign-in', '/play?code=FOX-1234');

    expect(href).toBe('/sign-in?redirect=%2Fplay%3Fcode%3DFOX-1234');
    expect(readReturnPath(href.slice(href.indexOf('?')))).toBe('/play?code=FOX-1234');
  });

  it('never links back to somewhere off-origin', () => {
    expect(accountHref('sign-up', '//evil.example')).toBe('/sign-up?redirect=%2Fplay');
  });
});

describe('clerkScriptUrl', () => {
  it('builds the clerk-js URL from the Frontend API host', () => {
    expect(clerkScriptUrl('quiet-fox-12.clerk.accounts.dev')).toBe(
      'https://quiet-fox-12.clerk.accounts.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js',
    );
  });

  it('accepts a leading https:// and trailing slashes', () => {
    expect(clerkScriptUrl('https://clerk.hunt.example/')).toBe(
      'https://clerk.hunt.example/npm/@clerk/clerk-js@5/dist/clerk.browser.js',
    );
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a bare word', 'localhost'],
    ['a host with a path', 'evil.example/x.js?'],
    ['a host with a port and credentials', 'user@evil.example'],
    ['a quote', 'a.example"><script>'],
    ['http', 'http://clerk.hunt.example'],
  ])('is undefined for %s', (_name, value) => {
    expect(clerkScriptUrl(value)).toBeUndefined();
  });
});

describe('clerkConfigured', () => {
  it('needs both values', () => {
    const both = { clerkPublishableKey: 'pk_test_abc', clerkFrontendApi: 'quiet-fox-12.clerk.accounts.dev' };

    expect(clerkConfigured(both)).toBe(true);
    expect(clerkConfigured({ ...both, clerkPublishableKey: null })).toBe(false);
    expect(clerkConfigured({ ...both, clerkFrontendApi: null })).toBe(false);
    expect(clerkConfigured({ clerkPublishableKey: null, clerkFrontendApi: null })).toBe(false);
    expect(clerkConfigured(undefined)).toBe(false);
  });
});
