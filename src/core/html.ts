/**
 * Escaping, kept in core so the planner can reach it.
 *
 * Telegram does not ignore HTML it cannot parse -- it rejects the whole message with a
 * 400 and sends nothing. So a medicine called "Vitamin A & D" does not arrive slightly
 * wrong, it does not arrive at all, and nothing in the chat says why. Every piece of text
 * that came from a prescription, a person, or a chat title goes through here.
 */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Strip markup rather than escape it, for the fallback path: if a message is rejected for
 * unparseable entities despite everything above, it is re-sent as plain text. A reminder
 * that arrives without its bold is infinitely better than one that does not arrive.
 */
export function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
