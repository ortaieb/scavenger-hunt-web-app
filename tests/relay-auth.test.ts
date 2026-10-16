import { describe, expect, it, vi } from 'vitest';
import { bearerHeaders, isUnauthorisedWith, sendWithToken } from '../src/public/relay-auth.js';

function unauthorised(code: string): Response {
  return new Response(JSON.stringify({ detail: 'x', code }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

function ok(): Response {
  return new Response('{"ok":true}', { status: 200 });
}

type SendHeaders = Record<string, string>;

/** Answers with each response in turn, remembering the headers it was sent. */
function sender(...responses: Response[]) {
  const sent: SendHeaders[] = [];
  const send = vi.fn((headers: SendHeaders) => {
    sent.push(headers);
    return Promise.resolve(responses[sent.length - 1] ?? ok());
  });
  return { send, sent };
}

function tokens(...values: (string | null)[]) {
  let call = 0;
  return vi.fn((options?: { skipCache?: boolean }) => {
    void options;
    return Promise.resolve(values[Math.min(call++, values.length - 1)] ?? null);
  });
}

describe('bearerHeaders', () => {
  it('sends the token as a Bearer, or nothing for a signed-out player', () => {
    expect(bearerHeaders('abc.def.ghi')).toEqual({ authorization: 'Bearer abc.def.ghi' });
    expect(bearerHeaders(null)).toEqual({});
  });
});

describe('isUnauthorisedWith', () => {
  it('is true only for a 401 with that code, and leaves the body readable', async () => {
    const response = unauthorised('provisioning_required');

    expect(await isUnauthorisedWith(response, 'provisioning_required')).toBe(true);
    expect(await isUnauthorisedWith(response, 'sign_in_required')).toBe(false);
    expect(await response.json()).toEqual({ detail: 'x', code: 'provisioning_required' });
  });

  it.each([
    ['a 200', ok()],
    ['a 403 with that code', new Response('{"code":"provisioning_required"}', { status: 403 })],
    ['a 401 that is not JSON', new Response('nope', { status: 401 })],
    ['a 401 with no code', new Response('{"detail":"x"}', { status: 401 })],
    ['a 401 with a null body', new Response('null', { status: 401 })],
  ])('is false for %s', async (_name, response) => {
    expect(await isUnauthorisedWith(response, 'provisioning_required')).toBe(false);
  });
});

describe('sendWithToken', () => {
  it('sends the token the page has, once, and returns the answer', async () => {
    const { send, sent } = sender(ok());
    const provision = vi.fn(() => Promise.resolve(true));
    const onSignInRequired = vi.fn();

    const response = await sendWithToken({ send, getToken: tokens('tok-1'), provision, onSignInRequired });

    expect(response.status).toBe(200);
    expect(sent).toEqual([{ authorization: 'Bearer tok-1' }]);
    expect(provision).not.toHaveBeenCalled();
    expect(onSignInRequired).not.toHaveBeenCalled();
  });

  it('asks for a token before each call, not once', async () => {
    const getToken = tokens('tok-1', 'tok-2');
    const { send, sent } = sender(ok(), ok());
    const calls = { send, getToken, provision: vi.fn(), onSignInRequired: vi.fn() };

    await sendWithToken(calls);
    await sendWithToken(calls);

    expect(sent).toEqual([{ authorization: 'Bearer tok-1' }, { authorization: 'Bearer tok-2' }]);
  });

  it('sends no Authorization for a signed-out player', async () => {
    const { send, sent } = sender(ok());

    await sendWithToken({ send, getToken: tokens(null), provision: vi.fn(), onSignInRequired: vi.fn() });

    expect(sent).toEqual([{}]);
  });

  describe('provisioning_required', () => {
    it('provisions, takes a fresh token and retries, so the player notices nothing', async () => {
      const { send, sent } = sender(unauthorised('provisioning_required'), ok());
      const getToken = tokens('old', 'fresh');
      const provision = vi.fn(() => Promise.resolve(true));

      const response = await sendWithToken({ send, getToken, provision, onSignInRequired: vi.fn() });

      expect(response.status).toBe(200);
      expect(provision).toHaveBeenCalledExactlyOnceWith('old');
      expect(getToken.mock.calls).toEqual([[], [{ skipCache: true }]]);
      expect(sent).toEqual([{ authorization: 'Bearer old' }, { authorization: 'Bearer fresh' }]);
    });

    it('retries once only, however the retry is answered', async () => {
      const { send, sent } = sender(unauthorised('provisioning_required'), unauthorised('provisioning_required'));
      const provision = vi.fn(() => Promise.resolve(true));

      const response = await sendWithToken({
        send,
        getToken: tokens('old', 'fresh'),
        provision,
        onSignInRequired: vi.fn(),
      });

      expect(sent).toHaveLength(2);
      expect(provision).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(401);
    });

    it('returns the first answer, without a retry, when provisioning fails', async () => {
      const { send, sent } = sender(unauthorised('provisioning_required'), ok());
      const getToken = tokens('old', 'fresh');

      const response = await sendWithToken({
        send,
        getToken,
        provision: () => Promise.resolve(false),
        onSignInRequired: vi.fn(),
      });

      expect(sent).toHaveLength(1);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(401);
      expect(await isUnauthorisedWith(response, 'provisioning_required')).toBe(true);
    });

    it('can retry a body that was sent once (a photo)', async () => {
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array([1, 2, 3])]), 'photo.jpg');
      const bodies: FormData[] = [];
      const send = vi.fn(() => {
        bodies.push(form);
        return Promise.resolve(bodies.length === 1 ? unauthorised('provisioning_required') : ok());
      });

      const response = await sendWithToken({
        send,
        getToken: tokens('old', 'fresh'),
        provision: () => Promise.resolve(true),
        onSignInRequired: vi.fn(),
      });

      expect(response.status).toBe(200);
      expect(bodies).toHaveLength(2);
    });
  });

  describe('sign_in_required', () => {
    it('sends a signed-out player to sign in', async () => {
      const { send } = sender(unauthorised('sign_in_required'));
      const onSignInRequired = vi.fn();

      const response = await sendWithToken({ send, getToken: tokens(null), provision: vi.fn(), onSignInRequired });

      expect(onSignInRequired).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(401);
    });

    it('does not, when a token was sent: no going round in circles', async () => {
      const { send } = sender(unauthorised('sign_in_required'));
      const onSignInRequired = vi.fn();

      const response = await sendWithToken({ send, getToken: tokens('tok'), provision: vi.fn(), onSignInRequired });

      expect(onSignInRequired).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
    });
  });

  it('leaves any other answer alone', async () => {
    const { send, sent } = sender(new Response('{"code":"session_not_started"}', { status: 409 }));
    const onSignInRequired = vi.fn();
    const provision = vi.fn();

    const response = await sendWithToken({ send, getToken: tokens('tok'), provision, onSignInRequired });

    expect(response.status).toBe(409);
    expect(sent).toHaveLength(1);
    expect(provision).not.toHaveBeenCalled();
    expect(onSignInRequired).not.toHaveBeenCalled();
  });

  it('fails the call when a token cannot be got, rather than sending it without one', async () => {
    const { send } = sender(ok());
    const getToken = vi.fn(() => Promise.reject(new Error('offline')));

    await expect(
      sendWithToken({ send, getToken, provision: vi.fn(), onSignInRequired: vi.fn() }),
    ).rejects.toThrow('offline');
    expect(send).not.toHaveBeenCalled();
  });
});
