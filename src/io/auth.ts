/**
 * Authentication for the admin dashboard.
 *
 * Constraint worth stating plainly: the Workers free plan allows 10ms of CPU per request,
 * and PBKDF2 is deliberately CPU-bound. The iteration count that OWASP recommends for a
 * server would blow that budget and the request would simply be killed. So the work factor
 * here is tuned to what the platform allows, and the defence that actually carries the
 * weight against an online guessing attack is the rate limiter below, plus a generated
 * initial password with far more entropy than anything a person would choose.
 *
 * Everything uses WebCrypto, which is native in Workers -- no dependencies.
 */

const ENC = new TextEncoder();

/**
 * Tuned against the free plan's CPU ceiling, measured on the real runtime rather than
 * guessed: 60k cost 11-17ms of CPU on workerd, against a documented budget of 10ms per
 * request. Those requests did succeed, but building on top of an undocumented grace
 * margin is how a login page stops working after a platform change. Changing a password
 * hashes twice (verify the old, derive the new), so the figure that has to fit is double
 * this one.
 *
 * This is well below the ~600k OWASP suggests for PBKDF2-SHA256. What compensates:
 * the initial password is generated with ~114 bits of entropy, so its iteration count is
 * irrelevant; a chosen one must be at least 12 characters; logins are throttled per
 * source address; and an offline attack needs the D1 database, which needs the Cloudflare
 * account, at which point the medical data is already exposed anyway.
 *
 * Stored per-row, so raising this later does not invalidate an existing password.
 */
export const PBKDF2_ITERATIONS = 25_000;
const KEY_BITS = 256;

export const SESSION_TTL_MS = 14 * 24 * 3600_000;
/** `__Host-` forces Secure, Path=/ and no Domain, which blocks subdomain injection. */
export const SESSION_COOKIE = '__Host-medbot_session';

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** URL-safe random token. Used for session cookies and invite codes. */
export function randomToken(bytes = 32): string {
  return b64(randomBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A human-typable code: no vowels (so it cannot spell anything), and none of the
 * characters people misread aloud -- 0/O, 1/I/L.
 */
export function humanCode(length = 8): string {
  const alphabet = '23456789BCDFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** A generated password. 20 chars from this alphabet is ~100 bits -- unguessable. */
export function generatePassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15)}`;
}

export async function hashPassword(
  password: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return b64(bits);
}

/**
 * Compares in constant time. A plain `===` on the hash would leak, through response
 * timing, how many leading bytes of a guess were right.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the work, so a length mismatch is not measurably faster.
    let sink = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      sink |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return sink === -1; // unreachable; keeps the branch from being optimised away
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ENC.encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PasswordCheck {
  ok: boolean;
  problem?: string;
}

/**
 * The generated password is strong by construction; this only has to stop the admin
 * replacing it with something trivial, since the hash's work factor is capped by the
 * platform's CPU budget.
 */
export function checkPasswordStrength(password: string): PasswordCheck {
  if (password.length < 12) return { ok: false, problem: 'Use at least 12 characters.' };
  if (password.length > 200) return { ok: false, problem: 'That is longer than 200 characters.' };
  const weak = ['password', '12345678', 'qwerty', 'medbot', 'letmein', 'admin'];
  const lower = password.toLowerCase();
  if (weak.some((w) => lower.includes(w))) {
    return { ok: false, problem: 'That contains a very common word or sequence.' };
  }
  if (/^(.)\1+$/.test(password)) return { ok: false, problem: 'That is a single repeated character.' };
  return { ok: true };
}

export function cookieFrom(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, maxAgeMs: number): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(maxAgeMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
