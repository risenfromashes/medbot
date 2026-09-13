import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/handlers/commands.js';
import { readFileSync } from 'node:fs';

/**
 * Telegram rejects a whole setMyCommands call if a single entry is malformed, and it does
 * so quietly -- the menu simply stays as it was. These check the real array rather than
 * parsing the source, which is how three entries slipped past an earlier regex check.
 */
describe('the published command menu', () => {
  it('obeys Telegram limits on every entry', () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
    expect(COMMANDS.length, 'Telegram caps the menu at 100').toBeLessThanOrEqual(100);
    for (const c of COMMANDS) {
      expect(c.command, `"${c.command}" is not 1-32 lowercase letters, digits or underscores`)
        .toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length, `description for /${c.command} is empty`).toBeGreaterThan(0);
      expect(c.description.length, `description for /${c.command} exceeds 256`).toBeLessThanOrEqual(256);
    }
  });

  it('lists no command twice', () => {
    const names = COMMANDS.map((c) => c.command);
    expect(new Set(names).size, `duplicates: ${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`)
      .toBe(names.length);
  });

  it('publishes every command the router actually handles', () => {
    // Only the top-level command router. Other switches in this file dispatch /edit field
    // names like "perday", which are not commands and have no business in the menu.
    const src = readFileSync('src/handlers/commands.ts', 'utf8');
    const from = src.indexOf('export async function handleCommand');
    const to = src.indexOf('/** Bare words that ought to just work', from);
    const router = src.slice(from, to === -1 ? undefined : to);

    const routed = new Set<string>();
    for (const m of router.matchAll(/case '([a-z_]+)':/g)) routed.add(m[1]!);

    // Aliases and internal cases that deliberately stay out of the menu.
    const unlisted = new Set([
      'wokeup', 'up', 'bed', 'goodnight', 'eaten', 'take', 'taken', 'medicines',
      'prescription', 'adherence', 'timezone', 'watch', 'unwatch', 'set', 'new',
      'template', 'json', 'plan', 'callme', 'start', 'health', 'add',
    ]);
    const published = new Set(COMMANDS.map((c) => c.command));

    for (const name of routed) {
      if (unlisted.has(name) || published.has(name)) continue;
      throw new Error(`/${name} is handled but never appears in the menu, so nobody will find it`);
    }
  });

  it('publishes nothing the router cannot handle', () => {
    const src = readFileSync('src/handlers/commands.ts', 'utf8');
    for (const c of COMMANDS) {
      expect(src.includes(`case '${c.command}':`), `/${c.command} is in the menu but has no handler`).toBe(true);
    }
  });

  it('republishes itself when the list changes', () => {
    // The menu used to be sent only when the webhook was registered, so a deploy that
    // added a command left it invisible -- it worked if typed, but nobody knew it existed.
    const tick = readFileSync('src/handlers/scheduled.ts', 'utf8');
    expect(tick).toContain('ensureCommandMenu');
    expect(tick, 'nothing detects that the list has changed').toContain('commands_hash');
  });
});
