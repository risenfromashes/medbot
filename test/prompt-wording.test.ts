import { describe, expect, it } from 'vitest';
import { renderConfirmation, renderDosePrompt } from '../src/core/render.js';
import type { Dose, Prompt } from '../src/core/domain.js';
import { makeMed, TZ } from './simulate.js';
import { zoneFor } from '../src/core/tz.js';

/**
 * The wording that caused a double dose.
 *
 * Vigalon was planned for 8:49pm and first asked about at 8:50pm. By 11:47pm the prompt
 * had been nagged seven times, and in the meantime the planner had pushed the dose's
 * `effective_due_at` out to 11:38pm -- so the message read "9m overdue — due at 11:38pm".
 * The drop had already been given at half past ten and not logged; the reader took the
 * message for a fresh dose and gave a second one.
 */

const z = zoneFor(TZ);
const at = (hhmm: string): number => z.wallOnDayUtc('2026-09-16', hhmm);

const med = makeMed({ id: 1, medKey: 'vigalon', name: 'Vigalon Eye Drops 5ml', doseText: '1 drop' });

function dose(over: Partial<Dose> = {}): Dose {
  return {
    id: 134, patientId: 14, medId: 1, seq: 3, step: 0, localDay: '2026-09-16',
    plannedDueAt: at('20:49'), effectiveDueAt: at('23:38'), anchorKind: 'actual',
    status: 'prompted', takenAt: null, resolvedAt: null, resolvedByChat: null,
    resolutionSrc: null, nagCount: 7, firstPromptAt: at('20:50'), promptId: 9,
    ...over,
  };
}

function prompt(nudgeCount: number): Prompt {
  return {
    id: 9, patientId: 14, kind: 'dose', state: 'open', body: { kind: 'dose', doseIds: [134] },
    nudgeCount, lastNudgeAt: null, escalatedTier: 0, createdAt: at('20:50'),
  };
}

const render = (n: number, d = dose(), now = at('23:47')): string =>
  renderDosePrompt(prompt(n), [d], new Map([[1, med]]), z, now).text;

describe('an outstanding dose never reads as a new one', () => {
  it('dates the nag from when it was first asked, not from the moved due time', () => {
    const text = render(7);
    expect(text, 'named the rescheduled time, which looks like a fresh dose').toContain('8:50pm');
    expect(text, 'the moved due time is what misled the reader').not.toContain('11:38pm');
  });

  it('says outright that this is the same dose', () => {
    expect(render(7)).toMatch(/not a new one/i);
  });

  it('counts the hours it has been waiting, not the minutes since it was re-clamped', () => {
    // 8:50pm to 11:47pm is just under three hours. "9m overdue" was the old answer.
    expect(render(7)).toMatch(/\b2h\s*5[0-9]m|\b3h/);
  });

  it('points at the button that records it as already taken', () => {
    expect(render(7), 'the honest answer was available and never offered').toMatch(/Taken earlier/);
  });

  it('is still gentle on the first nudge', () => {
    const text = render(1);
    expect(text).toMatch(/Still waiting/);
    expect(text).not.toMatch(/not a new one/i);
  });

  it('says nothing about lateness on the first ask', () => {
    const text = render(0);
    expect(text).not.toMatch(/overdue|Still/i);
  });

  it('falls back to the due time for a dose that was never prompted', () => {
    const text = render(3, dose({ firstPromptAt: null }));
    expect(text).toContain('11:38pm');
  });
});

describe('the confirmation says which dose it was', () => {
  it('names the dose when it is confirmed hours later', () => {
    const line = renderConfirmation('Vigalon Eye Drops 5ml', at('23:47'), z, 'Ashrafur', false, at('20:50'));
    expect(line).toContain('taken 11:47pm');
    expect(line, 'a name and a timestamp cannot tell a late tap from a second dose')
      .toContain('the 8:50pm dose');
  });

  it('stays quiet when the dose was answered promptly', () => {
    const line = renderConfirmation('Vigalon Eye Drops 5ml', at('20:55'), z, 'Ashrafur', false, at('20:50'));
    expect(line).not.toMatch(/the .* dose/);
  });

  it('is unchanged when there is nothing to name', () => {
    expect(renderConfirmation('Drops', at('20:55'), z, null, false)).toBe('✅ <b>Drops</b> — taken 8:55pm');
  });
});

describe('a dose merged with others', () => {
  it('dates the nag from the earliest of them', () => {
    const second = dose({ id: 135, medId: 2, firstPromptAt: at('22:10'), effectiveDueAt: at('23:40') });
    const meds = new Map([[1, med], [2, makeMed({ id: 2, medKey: 'sonexa', name: 'Sonexa' })]]);
    const text = renderDosePrompt(
      { ...prompt(4), body: { kind: 'dose', doseIds: [134, 135] } }, [dose(), second], meds, z, at('23:47'),
    ).text;
    expect(text).toContain('8:50pm');
  });
});

describe('a clock that disagrees', () => {
  it('never reports negative lateness', () => {
    // A tick delivered out of order, or a first-prompt stamp in the future after a
    // retrospective correction: clamp rather than print "-50m overdue".
    expect(render(5, dose(), at('20:00'))).not.toMatch(/-\d/);
  });
});
