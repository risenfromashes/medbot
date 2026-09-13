/**
 * Spacing between different medicines.
 *
 * A prescription that says "please give 10 minutes between two drops" is not saying the
 * drops share a schedule -- it is saying that whenever two of them coincide, separate
 * them. Real post-operative eye prescriptions routinely pair a drop four times a day with
 * a lubricant every two hours, both needing that gap.
 *
 * So this is a constraint applied after each medicine has computed its own due time,
 * rather than a merge that would force them onto one frequency. Pure, like everything
 * else in `core/`.
 */

import type { Action, Dose, Medicine } from './domain.js';

export interface SpacedDose {
  dose: Dose;
  med: Medicine;
}

/**
 * Push apart the live doses of any medicines sharing a spacing group.
 *
 * The floor starts at the most recent dose actually taken by *any* member, so the gap is
 * measured from what really happened rather than from a planned time nobody kept. Each
 * member then reserves the next slot, which staggers a pile-up automatically: three drops
 * all due at 08:00 become 08:00, 08:10 and 08:20, and once the first is genuinely taken at
 * 08:03 the remaining two shift to 08:13 and 08:23.
 *
 * Mutates the passed dose objects so later stages in the same pass see the new times, and
 * emits a retime action for each one it moved.
 */
export function applySpacing(
  live: SpacedDose[],
  now: number,
  emit: (a: Action) => void,
): void {
  const groups = new Map<string, SpacedDose[]>();
  for (const item of live) {
    const key = item.med.spacingGroup;
    if (key === null || item.med.spacingMs <= 0) continue;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  for (const [, members] of groups) {
    const spacing = Math.max(...members.map((m) => m.med.spacingMs));

    // Where the group as a whole last had something put in the eye.
    let floor = -Infinity;
    for (const m of members) {
      if (m.med.lastTakenAt !== null) floor = Math.max(floor, m.med.lastTakenAt + spacing);
    }

    // Order within the group.
    //
    // Whichever is due first goes first -- but when several fall due together, which they
    // usually do, the tie is broken deliberately rather than by whatever order the rows
    // came back in:
    //
    //   1. an explicit `group_seq` from the prescription, if the doctor gave an order;
    //   2. then plain medicines before tapering ones, so the steady part of the routine
    //      stays put and only the changing one moves as the taper steps down;
    //   3. then by name, so the sequence is at least stable day to day.
    //
    // Order matters here beyond tidiness: the patient learns a sequence, and a sequence
    // that reshuffles itself is one they will get wrong.
    const rank = (m: Medicine): [number, number, string] => [
      m.groupSeq ?? 1000,
      m.phases !== null && m.phases.length > 1 ? 1 : 0,
      m.name,
    ];
    const ordered = [...members].sort((a, b) => {
      const byDue = a.dose.effectiveDueAt - b.dose.effectiveDueAt;
      if (Math.abs(byDue) > 60_000) return byDue;
      const [as, at, an] = rank(a.med);
      const [bs, bt, bn] = rank(b.med);
      return as - bs || at - bt || an.localeCompare(bn);
    });

    for (const item of ordered) {
      // A deferred dose is parked for sleep; leave it alone or it would be woken early.
      if (item.dose.status === 'deferred') continue;

      if (item.dose.effectiveDueAt < floor) {
        emit({ t: 'retimeDose', doseId: item.dose.id, effectiveDueAt: floor });
        item.dose.effectiveDueAt = floor;
      }
      // The next member of the group waits at least a full gap after this one.
      floor = Math.max(floor, item.dose.effectiveDueAt + spacing);
    }
  }
}
