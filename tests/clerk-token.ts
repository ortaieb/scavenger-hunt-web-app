import { generateKeyPairSync, sign } from 'node:crypto';

// A real RS256 key pair and session tokens in Clerk's shape, so the tests
// run @clerk/express's own checks (signature, expiry, authorized party)
// against the public key, as production does with CLERK_JWT_KEY.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const FRONTEND_API = 'quiet-fox-12.clerk.accounts.dev';
export const PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${FRONTEND_API}$`).toString('base64')}`;
export const JWT_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
export const APP_ORIGIN = 'https://hunt.example';

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** A session token signed by the test key; `claims` override the defaults. */
export function sessionToken(claims: Record<string, unknown> = {}, signingKey = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: 'ins_test' };
  const payload = {
    sub: 'user_test123',
    sid: 'sess_test123',
    azp: APP_ORIGIN,
    iss: `https://${FRONTEND_API}`,
    iat: now - 5,
    nbf: now - 5,
    exp: now + 60,
    ...claims,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  return `${signingInput}.${base64url(sign('RSA-SHA256', Buffer.from(signingInput), signingKey))}`;
}

/** A token signed by some other key: it must never be accepted. */
export function forgedToken(claims: Record<string, unknown> = {}): string {
  return sessionToken(claims, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
}
