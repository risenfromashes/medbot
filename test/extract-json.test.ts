import { describe, expect, it } from 'vitest';
import { describeJsonError, extractJson, looksLikeJsonFragment } from '../src/core/extractJson.js';

const doc = '{"version":1,"medicines":[{"id":"a","name":"A"}]}';

describe('getting JSON out of a chat message', () => {
  it('takes it plain', () => {
    expect(extractJson(doc)).toEqual({ kind: 'json', text: doc });
  });

  it('unwraps a code fence', () => {
    const r = extractJson('```json\n' + doc + '\n```');
    expect(r.kind).toBe('json');
    if (r.kind === 'json') expect(JSON.parse(r.text)).toHaveProperty('version', 1);
  });

  it('ignores a chatbot explaining itself around the JSON', () => {
    const r = extractJson(`Sure! Here's the JSON for your prescription:\n\n${doc}\n\nLet me know if you need changes.`);
    expect(r.kind).toBe('json');
    if (r.kind === 'json') expect(JSON.parse(r.text)).toHaveProperty('version', 1);
  });

  it('survives curly quotes from a rendered chat window', () => {
    const smart = doc.replace(/"/g, '“').replace(/“(?=[,:\]}])/g, '”');
    const r = extractJson(smart);
    expect(r.kind).toBe('json');
    if (r.kind === 'json') expect(() => JSON.parse(r.text)).not.toThrow();
  });

  it('survives non-breaking and zero-width characters', () => {
    const r = extractJson('﻿{"version": 1,"medicines":[]}​');
    expect(r.kind).toBe('json');
    if (r.kind === 'json') expect(JSON.parse(r.text)).toHaveProperty('version', 1);
  });

  it('is not fooled by braces inside strings', () => {
    const tricky = '{"name":"take 1 } drop","medicines":[]}';
    const r = extractJson(tricky);
    expect(r.kind).toBe('json');
    if (r.kind === 'json') expect(JSON.parse(r.text)).toHaveProperty('name', 'take 1 } drop');
  });

  it('recognises a split paste as incomplete rather than malformed', () => {
    // This is what Telegram actually delivers when someone pastes something long: the
    // first half, ending mid-object, with nothing to suggest it was cut.
    const half = doc.slice(0, 30);
    const r = extractJson(half);
    expect(r.kind).toBe('partial');
    if (r.kind === 'partial') expect(r.missing).toBeGreaterThan(0);
  });

  it('finds nothing in a message that is not JSON at all', () => {
    expect(extractJson('hello there').kind).toBe('none');
    expect(extractJson('').kind).toBe('none');
  });

  it('reassembles the two halves of a split paste', () => {
    const a = doc.slice(0, 30);
    const b = doc.slice(30);
    const first = extractJson(a);
    expect(first.kind).toBe('partial');
    if (first.kind !== 'partial') return;
    const joined = extractJson(first.text + b);
    expect(joined.kind).toBe('json');
    if (joined.kind === 'json') expect(JSON.parse(joined.text)).toHaveProperty('version', 1);
  });
});

describe('spotting a continuation message', () => {
  it('recognises the tail of a split paste', () => {
    expect(looksLikeJsonFragment('"course":{"days":7}}]}')).toBe(true);
    expect(looksLikeJsonFragment('  "id": "moxi",')).toBe(true);
    expect(looksLikeJsonFragment('}]}')).toBe(true);
  });

  it('does not mistake a command or ordinary chat for one', () => {
    expect(looksLikeJsonFragment('/status')).toBe(false);
    expect(looksLikeJsonFragment('taken')).toBe(false);
    expect(looksLikeJsonFragment('')).toBe(false);
  });
});

describe('explaining a syntax error', () => {
  it('gives a line and the text around it, not a byte offset', () => {
    const broken = '{\n  "version": 1,\n  "medicines": [,]\n}';
    try {
      JSON.parse(broken);
      throw new Error('should not parse');
    } catch (e) {
      const described = describeJsonError(broken, e);
      expect(described).toMatch(/line \d+/);
      expect(described).toContain('medicines');
    }
  });
});
