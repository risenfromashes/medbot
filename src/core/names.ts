/**
 * Whether Telegram actually told us who someone is.
 *
 * It often does not. A chat with no first name on it, or a privacy setting, leaves the
 * bot holding a word like "Member" or "User" -- which it then cheerfully used as the
 * patient's name, in every reminder, in the caregiver's messages, and on the dashboard.
 * One household lived with that for a fortnight because nothing ever asked.
 */

const PLACEHOLDERS = new Set([
  'there', 'member', 'user', 'patient', 'telegram', 'unknown', 'someone', 'admin', 'bot', 'me',
]);

export function looksLikeRealName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (PLACEHOLDERS.has(t.toLowerCase())) return false;
  // A name is not a phone number, a user id, or an empty run of punctuation.
  return /\p{L}/u.test(t) && !/^\+?\d[\d\s-]*$/.test(t);
}

/** What to call someone when nobody has said. Never stored as though it were a name. */
export const FALLBACK_NAME = 'there';
