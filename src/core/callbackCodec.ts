/**
 * Inline button payloads.
 *
 * Telegram caps callback_data at 64 bytes, so this is a terse positional encoding rather
 * than JSON: an action letter, then base36 ids. Anything that does not decode cleanly is
 * treated as a no-op rather than trusted.
 */

export type Callback =
  | { a: 'take'; doseId: number }
  | { a: 'skip'; doseId: number }
  | { a: 'snooze'; doseId: number; minutes: number }
  /** "I took it N minutes ago" -- the one-tap form of a retrospective correction. */
  | { a: 'earlier'; doseId: number; minutesAgo: number }
  | { a: 'takeAll'; promptId: number }
  | { a: 'wake' }
  | { a: 'sleep' }
  | { a: 'ate'; meal: string }
  | { a: 'skipMeal'; meal: string }
  | { a: 'confirmImport'; versionId: number }
  /** Open the tap-through edit menu for a medicine. */
  | { a: 'editMenu'; medId: number }
  /** One of the suggested values inside that menu. */
  | { a: 'editSet'; medId: number; field: string; value: string }
  | { a: 'cancelImport'; versionId: number }
  | { a: 'noop' };

const b36 = (n: number): string => Math.round(n).toString(36);
const un36 = (s: string): number => parseInt(s, 36);

export function encodeCallback(cb: Callback): string {
  switch (cb.a) {
    case 'take': return `t.${b36(cb.doseId)}`;
    case 'skip': return `s.${b36(cb.doseId)}`;
    case 'snooze': return `z.${b36(cb.doseId)}.${b36(cb.minutes)}`;
    case 'earlier': return `e.${b36(cb.doseId)}.${b36(cb.minutesAgo)}`;
    case 'takeAll': return `A.${b36(cb.promptId)}`;
    case 'wake': return 'w';
    case 'sleep': return 'b';
    case 'ate': return `m.${cb.meal}`;
    case 'skipMeal': return `x.${cb.meal}`;
    case 'editMenu': return `E.${b36(cb.medId)}`;
    // field and value are short tokens, well inside the 64-byte callback_data cap.
    case 'editSet': return `S.${b36(cb.medId)}.${cb.field}.${cb.value}`;
    case 'confirmImport': return `i.${b36(cb.versionId)}`;
    case 'cancelImport': return `c.${b36(cb.versionId)}`;
    case 'noop': return '-';
  }
}

export function decodeCallback(data: string): Callback {
  const parts = data.split('.');
  const head = parts[0] ?? '';
  const n = (i: number): number => un36(parts[i] ?? '');
  const valid = (v: number): boolean => Number.isFinite(v) && v > 0;

  switch (head) {
    case 't': return valid(n(1)) ? { a: 'take', doseId: n(1) } : { a: 'noop' };
    case 's': return valid(n(1)) ? { a: 'skip', doseId: n(1) } : { a: 'noop' };
    case 'z': return valid(n(1)) ? { a: 'snooze', doseId: n(1), minutes: valid(n(2)) ? n(2) : 15 } : { a: 'noop' };
    case 'e': return valid(n(1)) ? { a: 'earlier', doseId: n(1), minutesAgo: valid(n(2)) ? n(2) : 15 } : { a: 'noop' };
    case 'A': return valid(n(1)) ? { a: 'takeAll', promptId: n(1) } : { a: 'noop' };
    case 'w': return { a: 'wake' };
    case 'b': return { a: 'sleep' };
    case 'm': return parts[1] !== undefined ? { a: 'ate', meal: parts[1] } : { a: 'noop' };
    case 'x': return parts[1] !== undefined ? { a: 'skipMeal', meal: parts[1] } : { a: 'noop' };
    case 'E': return valid(n(1)) ? { a: 'editMenu', medId: n(1) } : { a: 'noop' };
    case 'S':
      return valid(n(1)) && parts[2] !== undefined && parts[3] !== undefined
        ? { a: 'editSet', medId: n(1), field: parts[2], value: parts[3] }
        : { a: 'noop' };
    case 'i': return valid(n(1)) ? { a: 'confirmImport', versionId: n(1) } : { a: 'noop' };
    case 'c': return valid(n(1)) ? { a: 'cancelImport', versionId: n(1) } : { a: 'noop' };
    default: return { a: 'noop' };
  }
}
