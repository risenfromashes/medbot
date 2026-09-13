import { describe, expect, it } from 'vitest';
import { decodeCallback, encodeCallback } from '../src/core/callbackCodec.js';

/**
 * The two kinds of code do different things, and offering one to the wrong command used
 * to burn it silently -- leaving someone holding a dead single-use code with no
 * explanation.
 */
describe('caregiver and joining codes are separate', () => {
  it('round-trips an unlink for a private chat', () => {
    const cb = { a: 'unlink', chatId: 555001, patientId: 3 } as const;
    expect(decodeCallback(encodeCallback(cb))).toEqual(cb);
  });

  it('round-trips an unlink for a group chat, whose id is negative', () => {
    const cb = { a: 'unlink', chatId: -1001234567890, patientId: 12 } as const;
    expect(decodeCallback(encodeCallback(cb))).toEqual(cb);
  });

  it('keeps unlink payloads inside the 64-byte callback limit', () => {
    const encoded = encodeCallback({ a: 'unlink', chatId: -1009999999999, patientId: 99999 });
    expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(64);
  });

  it('refuses a malformed unlink rather than acting on a guess', () => {
    // Note "U.x.p.y" is deliberately absent: x and y are valid base-36 digits, so that is
    // a well-formed payload for chat 33, patient 34. Nothing stops a stranger sending
    // one -- what stops it mattering is the authorisation check in the handler, which
    // requires the acting chat to be either that caregiver or that patient. The codec's
    // job is only to reject what it cannot parse.
    for (const bad of ['U', 'U.', 'U.0.p.0', 'U.1.p.', 'U..p.1', 'U.-1.p.2', 'U.1.p.0']) {
      expect(decodeCallback(bad).a, `accepted "${bad}"`).toBe('noop');
    }
  });
});

describe('every callback payload fits Telegram limits', () => {
  it('checks the widest realistic value of each kind', () => {
    const samples = [
      { a: 'take', doseId: 999_999 },
      { a: 'skip', doseId: 999_999 },
      { a: 'snooze', doseId: 999_999, minutes: 120 },
      { a: 'earlier', doseId: 999_999, minutesAgo: 240 },
      { a: 'takeAll', promptId: 999_999 },
      { a: 'ate', meal: 'afternoon_snack' },
      { a: 'skipMeal', meal: 'afternoon_snack' },
      { a: 'planMeal', meal: 'afternoon_snack', inMinutes: 720 },
      { a: 'mealAt', meal: 'afternoon_snack', at: Date.UTC(2030, 0, 1) },
      { a: 'confirmImport', versionId: 99_999 },
      { a: 'editMenu', medId: 99_999 },
      { a: 'editSet', medId: 99_999, field: 'perday', value: '12' },
      { a: 'unlink', chatId: -1009999999999, patientId: 99_999 },
    ] as const;
    for (const s of samples) {
      const encoded = encodeCallback(s);
      expect(new TextEncoder().encode(encoded).length, `${s.a} is too long: ${encoded}`).toBeLessThanOrEqual(64);
      expect(decodeCallback(encoded).a, `${s.a} did not round-trip`).toBe(s.a);
    }
  });
});

describe('you cannot become your own backup', () => {
  it('a patient chat keeps its role when a caregiver link is written over it', async () => {
    // Reproduces a real incident: the chat that created a patient redeemed a caregiver
    // code for that same patient, and the upsert overwrote role='patient' with
    // 'caregiver'. The patient then had no tier-0 chat at all, so nobody was being
    // reminded first-hand -- and from the outside the link looked perfectly healthy.
    const sql = (await import('node:fs')).readFileSync('src/io/db.ts', 'utf8');
    const upsert = sql.slice(sql.indexOf('INSERT INTO chats'), sql.indexOf('INSERT INTO chats') + 1200);
    expect(upsert, 'the chats upsert can still demote a patient').toContain("chats.role = 'patient' THEN 'patient'");
    expect(upsert, 'a demoted patient would also lose tier 0').toContain("chats.role = 'patient' THEN 0");
  });

  it('the caregiver command refuses a code for a patient this chat already owns', async () => {
    const src = (await import('node:fs')).readFileSync('src/handlers/commands.ts', 'utf8');
    expect(src).toContain("you can't be your own backup");
  });
});
