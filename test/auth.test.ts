import { describe, expect, it } from 'vitest';
import {
  checkPasswordStrength, constantTimeEqual, cookieFrom, generatePassword, hashPassword,
  humanCode, randomToken, sessionCookie, sha256Hex,
} from '../src/io/auth.js';

describe('password hashing', () => {
  it('produces a stable hash for the same salt and a different one otherwise', async () => {
    const salt = new Uint8Array(16).fill(7);
    const a = await hashPassword('CorrectHorse99', salt, 1000);
    const b = await hashPassword('CorrectHorse99', salt, 1000);
    const c = await hashPassword('CorrectHorse98', salt, 1000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('depends on the salt, so two identical passwords do not collide', async () => {
    const a = await hashPassword('same', new Uint8Array(16).fill(1), 1000);
    const b = await hashPassword('same', new Uint8Array(16).fill(2), 1000);
    expect(a).not.toBe(b);
  });

  it('depends on the iteration count, so it can be raised later', async () => {
    const salt = new Uint8Array(16).fill(3);
    expect(await hashPassword('x', salt, 1000)).not.toBe(await hashPassword('x', salt, 2000));
  });
});

describe('constantTimeEqual', () => {
  it('compares correctly', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('a', '')).toBe(false);
  });
});

describe('generated secrets', () => {
  it('generates passwords with real entropy and no repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generatePassword());
    expect(seen.size).toBe(200);
    const one = generatePassword();
    expect(one.length).toBeGreaterThanOrEqual(20);
  });

  it('uses an invite alphabet with no easily-misread characters', () => {
    // No 0/O, 1/I/L, and no vowels -- these get read aloud and typed by hand.
    for (let i = 0; i < 300; i++) {
      expect(humanCode(8)).toMatch(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{8}$/);
    }
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) codes.add(humanCode(8));
    expect(codes.size).toBe(500);
  });

  it('generates URL-safe session tokens', () => {
    for (let i = 0; i < 50; i++) expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('password strength', () => {
  it('rejects what it should', () => {
    expect(checkPasswordStrength('short').ok).toBe(false);
    expect(checkPasswordStrength('mypassword123').ok).toBe(false);
    expect(checkPasswordStrength('aaaaaaaaaaaaaa').ok).toBe(false);
    expect(checkPasswordStrength('medbot123456').ok).toBe(false);
    expect(checkPasswordStrength('x'.repeat(300)).ok).toBe(false);
  });

  it('accepts a reasonable one, and every generated one', () => {
    expect(checkPasswordStrength('CorrectHorse99').ok).toBe(true);
    for (let i = 0; i < 100; i++) {
      expect(checkPasswordStrength(generatePassword()).ok, 'a generated password was rejected').toBe(true);
    }
  });
});

describe('cookies', () => {
  it('extracts a named cookie from a header', () => {
    expect(cookieFrom('a=1; __Host-medbot_session=tok123; b=2', '__Host-medbot_session')).toBe('tok123');
    expect(cookieFrom('other=1', '__Host-medbot_session')).toBeNull();
    expect(cookieFrom(null, '__Host-medbot_session')).toBeNull();
  });

  it('sets the flags that actually matter', () => {
    const c = sessionCookie('tok', 3600_000);
    // __Host- requires Secure and Path=/ with no Domain; HttpOnly keeps it away from JS.
    expect(c).toContain('__Host-medbot_session=tok');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).not.toContain('Domain=');
  });
});

describe('session token storage', () => {
  it('stores only a digest, so a database copy does not hand over live sessions', async () => {
    const token = randomToken(32);
    const hash = await sha256Hex(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(await sha256Hex(token)).toBe(hash);
  });
});
