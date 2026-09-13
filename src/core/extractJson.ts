/**
 * Getting usable JSON out of whatever actually arrives in a chat message.
 *
 * Pasting a prescription into Telegram goes wrong in several mundane ways, and the error
 * people see is "Unexpected token", which tells them nothing. What actually happens:
 *
 *   - Telegram clients split a long paste into several messages, so the first one ends
 *     mid-object and nothing about it looks like a truncation;
 *   - chatbots wrap their answer in a ```json fence, or in a sentence explaining it;
 *   - copying from a rendered chat window can bring curly quotes and non-breaking spaces
 *     with it.
 *
 * So: strip the wrapping, normalise the punctuation, and be able to say specifically
 * "this is only part of it" rather than pointing at a character.
 */

export type ExtractResult =
  | { kind: 'json'; text: string }
  /** Starts like JSON but does not finish: almost always a split paste. */
  | { kind: 'partial'; text: string; missing: number }
  | { kind: 'none' };

/** Quotes and spaces that survive a copy out of a rendered chat window. */
function normalise(raw: string): string {
  return raw
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    // Non-breaking and zero-width characters, which are invisible and fatal.
    .replace(/[   ]/g, ' ')
    .replace(/[​-‍﻿]/g, '');
}

/** Strip a markdown code fence, opened or unopened. */
function stripFence(s: string): string {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s);
  if (fenced !== null) return fenced[1]!.trim();
  // An unterminated fence: the closing one is in the next message.
  const opened = /```(?:json|JSON)?\s*([\s\S]*)$/.exec(s);
  if (opened !== null) return opened[1]!.trim();
  return s.trim();
}

/**
 * Scan for a balanced object, ignoring braces inside strings. Returns how many closing
 * braces are still owed when the text runs out, which is what distinguishes a split paste
 * from a genuine syntax error.
 */
function scan(s: string, from: number): { end: number; depth: number } {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return { end: i, depth: 0 };
    }
  }
  return { end: -1, depth };
}

export function extractJson(raw: string): ExtractResult {
  const text = stripFence(normalise(raw));
  const start = text.indexOf('{');
  if (start === -1) return { kind: 'none' };

  const { end, depth } = scan(text, start);
  if (end !== -1) return { kind: 'json', text: text.slice(start, end + 1) };
  return { kind: 'partial', text: text.slice(start), missing: depth };
}

/** True when a message looks like a continuation of a prescription rather than a command. */
export function looksLikeJsonFragment(raw: string): boolean {
  const t = normalise(raw).trim();
  if (t === '') return false;
  if (t.startsWith('/')) return false;
  // Continuations begin mid-structure: a key, a closing brace, a value.
  return /^["}\]{,]|^\s*"[\w_]+"\s*:/.test(t) || t.includes('"') || t.includes('}');
}

/**
 * A parse error a person can act on: which line, and what is actually there.
 * "Unexpected token } in JSON at position 1843" is not something anyone can use.
 */
export function describeJsonError(text: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  const locate = (index: number): string => {
    const before = text.slice(0, index);
    const line = before.split('\n').length;
    const column = index - before.lastIndexOf('\n');
    const snippet = text.slice(Math.max(0, index - 40), index + 40).replace(/\n/g, ' ⏎ ');
    return `line ${line}, character ${column}\n…${snippet}…`;
  };

  // Older runtimes give a byte offset.
  const at = /position (\d+)/.exec(message);
  if (at !== null) return locate(Number(at[1]));

  // Newer ones give a quoted excerpt instead, e.g.
  //   Unexpected token ',', ..."icines": [,]... is not valid JSON
  // which can be located in the source to recover a line number.
  const excerpt = /\.\.\."?(.+?)"?\.\.\./.exec(message) ?? /"([^"]{6,})"\s+is not valid JSON/.exec(message);
  if (excerpt !== null) {
    const needle = excerpt[1]!.replace(/\\n/g, '\n');
    const index = text.indexOf(needle.slice(0, 20));
    if (index !== -1) return locate(index);
  }

  // Nothing locatable: at least strip the noise.
  return message.replace(/\s+is not valid JSON$/, '');
}
