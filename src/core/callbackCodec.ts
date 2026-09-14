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
  /** Going to bed with doses still outstanding: what to do about them. */
  | { a: 'bedtime'; choice: 'took' | 'skip' | 'leave' }
  /** "Yes, I really am going to bed" -- overriding the too-soon-to-sleep guard. */
  | { a: 'sleepAnyway' }
  /** Answering "still turning in at one?": now, or a shift in minutes (0 = on time). */
  | { a: 'bedAt'; shiftMinutes: number }
  | { a: 'bedNow' }
  /** Answering "did you just wake up?" */
  | { a: 'wokeNow' }
  | { a: 'wokeEarlier' }
  /** How long ago they actually woke, from the follow-up menu. */
  | { a: 'wokeAgo'; minutesAgo: number }
  /** Still asleep: push the next check back by this many minutes. */
  | { a: 'sleepOn'; minutes: number }
  /** "I did take that one" -- flips a reconstructed missed dose back to taken. */
  | { a: 'tookPast'; doseId: number }
  | { a: 'ate'; meal: string }
  /** "I'm eating in about N minutes" -- what makes a before-meal dose schedulable. */
  | { a: 'planMeal'; meal: string; inMinutes: number }
  /** "Yes, around then" or "push it back" -- an answer to a proposed meal time. */
  | { a: 'mealAt'; meal: string; at: number }
  | { a: 'skipMeal'; meal: string }
  | { a: 'confirmImport'; versionId: number }
  /** Open the tap-through edit menu for a medicine. */
  | { a: 'editMenu'; medId: number }
  /** One of the suggested values inside that menu. */
  | { a: 'editSet'; medId: number; field: string; value: string }
  | { a: 'cancelImport'; versionId: number }
  /** Break a caregiver link, from either side. */
  | { a: 'unlink'; chatId: number; patientId: number }
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
    case 'bedtime': return `B.${cb.choice}`;
    case 'sleepAnyway': return 'Z';
    case 'bedAt': return `D.${b36(cb.shiftMinutes + 720)}`;
    case 'bedNow': return 'N';
    case 'wokeNow': return 'W';
    case 'wokeEarlier': return 'R';
    case 'wokeAgo': return `G.${b36(cb.minutesAgo)}`;
    case 'sleepOn': return `O.${b36(cb.minutes)}`;
    case 'tookPast': return `P.${b36(cb.doseId)}`;
    case 'ate': return `m.${cb.meal}`;
    case 'planMeal': return `p.${cb.meal}.${b36(cb.inMinutes)}`;
    // Minutes since the epoch, which is nine base-36 characters -- comfortably inside
    // Telegram's 64-byte callback_data limit, and precise enough for a meal.
    case 'mealAt': return `M.${cb.meal}.${b36(Math.round(cb.at / 60_000))}`;
    case 'skipMeal': return `x.${cb.meal}`;
    case 'editMenu': return `E.${b36(cb.medId)}`;
    // field and value are short tokens, well inside the 64-byte callback_data cap.
    case 'editSet': return `S.${b36(cb.medId)}.${cb.field}.${cb.value}`;
    case 'confirmImport': return `i.${b36(cb.versionId)}`;
    case 'cancelImport': return `c.${b36(cb.versionId)}`;
    case 'unlink': return `U.${b36(Math.abs(cb.chatId))}.${cb.chatId < 0 ? 'n' : 'p'}.${b36(cb.patientId)}`;
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
    case 'B':
      return parts[1] === 'took' || parts[1] === 'skip' || parts[1] === 'leave'
        ? { a: 'bedtime', choice: parts[1] }
        : { a: 'noop' };
    case 'Z': return { a: 'sleepAnyway' };
    // Shifts are stored offset by twelve hours so a negative one still encodes cleanly.
    case 'D': return Number.isFinite(n(1)) ? { a: 'bedAt', shiftMinutes: n(1) - 720 } : { a: 'noop' };
    case 'N': return { a: 'bedNow' };
    case 'W': return { a: 'wokeNow' };
    case 'R': return { a: 'wokeEarlier' };
    case 'G': return Number.isFinite(n(1)) ? { a: 'wokeAgo', minutesAgo: Math.max(n(1), 0) } : { a: 'noop' };
    case 'O': return valid(n(1)) ? { a: 'sleepOn', minutes: n(1) } : { a: 'noop' };
    case 'P': return valid(n(1)) ? { a: 'tookPast', doseId: n(1) } : { a: 'noop' };
    case 'm': return parts[1] !== undefined ? { a: 'ate', meal: parts[1] } : { a: 'noop' };
    case 'p':
      return parts[1] !== undefined && Number.isFinite(n(2))
        ? { a: 'planMeal', meal: parts[1], inMinutes: Math.max(0, n(2)) }
        : { a: 'noop' };
    case 'M':
      return parts[1] !== undefined && Number.isFinite(n(2)) && n(2) > 0
        ? { a: 'mealAt', meal: parts[1], at: n(2) * 60_000 }
        : { a: 'noop' };
    case 'x': return parts[1] !== undefined ? { a: 'skipMeal', meal: parts[1] } : { a: 'noop' };
    case 'E': return valid(n(1)) ? { a: 'editMenu', medId: n(1) } : { a: 'noop' };
    case 'S':
      return valid(n(1)) && parts[2] !== undefined && parts[3] !== undefined
        ? { a: 'editSet', medId: n(1), field: parts[2], value: parts[3] }
        : { a: 'noop' };
    case 'i': return valid(n(1)) ? { a: 'confirmImport', versionId: n(1) } : { a: 'noop' };
    case 'c': return valid(n(1)) ? { a: 'cancelImport', versionId: n(1) } : { a: 'noop' };
    case 'U': {
      // Group chat ids are negative, so the sign travels separately.
      const magnitude = n(1);
      const sign = parts[2] === 'n' ? -1 : 1;
      const patientId = un36(parts[3] ?? '');
      return Number.isFinite(magnitude) && magnitude > 0 && Number.isFinite(patientId) && patientId > 0
        ? { a: 'unlink', chatId: sign * magnitude, patientId }
        : { a: 'noop' };
    }
    default: return { a: 'noop' };
  }
}
