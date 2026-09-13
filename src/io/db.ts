/**
 * The D1 gateway. Every SQL statement in the system lives here or in a call from here.
 *
 * Two properties matter more than elegance:
 *   - Writes that resolve a dose are *guarded* -- D1 has no interactive transactions, so
 *     "read, check, write" is not available and every contended update has to carry its
 *     precondition in the WHERE clause and then inspect `meta.changes`.
 *   - Applying a plan is two round trips: one batch of inserts (whose `last_row_id`
 *     resolves the planner's placeholder ids) and one batch of everything else.
 */

import type {
  Action, Chat, Dose, DoseStatus, MealDef, MealEvent, Medicine, Patient, PatientState, Prompt,
} from '../core/domain.js';
import { advanceMedicine } from '../core/advance.js';
import type { Resolution } from '../core/advance.js';
import type { NormalizedPrescription } from '../core/prescription.js';

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean => num(v) !== 0;
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export class Db {
  constructor(private readonly d1: D1Database) {}

  // --- patients ----------------------------------------------------------

  async patientsNeedingAttention(now: number): Promise<number[]> {
    // The whole timer wheel: one indexed range scan that usually returns nothing.
    const res = await this.d1
      .prepare('SELECT id FROM patients WHERE next_action_at IS NULL OR next_action_at <= ?1')
      .bind(now)
      .all<Row>();
    return (res.results ?? []).map((r) => num(r['id']));
  }

  async getPatient(id: number): Promise<Patient | null> {
    const row = await this.d1.prepare('SELECT * FROM patients WHERE id = ?1').bind(id).first<Row>();
    return row === null ? null : rowToPatient(row);
  }

  async createPatient(name: string, tz: string, now: number): Promise<number> {
    const res = await this.d1
      .prepare(
        `INSERT INTO patients (display_name, tz, wake_state, wake_confidence, wake_state_since, created_at)
         VALUES (?1, ?2, 'asleep', 'presumed', ?3, ?3) RETURNING id`,
      )
      .bind(name, tz, now)
      .first<Row>();
    return num(res?.['id']);
  }

  async touchActivity(chatId: number, now: number): Promise<void> {
    // Any inbound message proves the sender is up. Free wake detection.
    await this.d1
      .prepare(
        `UPDATE patients SET last_activity_at = ?2, next_action_at = MIN(COALESCE(next_action_at, ?2), ?2)
         WHERE id IN (SELECT patient_id FROM chats WHERE chat_id = ?1 AND active = 1 AND role = 'patient')`,
      )
      .bind(chatId, now)
      .run();
  }

  /** Ask the tick to look at this patient immediately, regardless of its timer. */
  async wakeNow(patientId: number, now: number): Promise<void> {
    await this.d1
      .prepare('UPDATE patients SET next_action_at = ?2 WHERE id = ?1')
      .bind(patientId, now)
      .run();
  }

  // --- chats -------------------------------------------------------------

  async chatsFor(patientId: number): Promise<Chat[]> {
    const res = await this.d1
      .prepare('SELECT * FROM chats WHERE patient_id = ?1 AND active = 1 ORDER BY escalation_tier')
      .bind(patientId)
      .all<Row>();
    return (res.results ?? []).map(rowToChat);
  }

  async linksForChat(chatId: number): Promise<Chat[]> {
    const res = await this.d1
      .prepare('SELECT * FROM chats WHERE chat_id = ?1 AND active = 1 ORDER BY escalation_tier')
      .bind(chatId)
      .all<Row>();
    return (res.results ?? []).map(rowToChat);
  }

  async linkChat(
    chatId: number,
    patientId: number,
    role: 'patient' | 'caregiver',
    tier: number,
    escalateAfterMs: number,
    now: number,
  ): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO chats (chat_id, patient_id, role, can_ack, escalation_tier, escalate_after_ms, active, linked_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, 1, ?6)
         ON CONFLICT (chat_id, patient_id) DO UPDATE SET
           role = ?3, escalation_tier = ?4, escalate_after_ms = ?5, active = 1, blocked_at = NULL`,
      )
      .bind(chatId, patientId, role, tier, escalateAfterMs, now)
      .run();
  }

  async deactivateChat(chatId: number, now: number): Promise<void> {
    // A blocked bot would otherwise burn a subrequest per tick forever.
    await this.d1
      .prepare('UPDATE chats SET active = 0, blocked_at = ?2 WHERE chat_id = ?1')
      .bind(chatId, now)
      .run();
  }

  // --- the planner snapshot ----------------------------------------------

  async loadState(patientId: number, today: string): Promise<PatientState | null> {
    const batched = await this.d1.batch<Row>([
        this.d1.prepare('SELECT * FROM patients WHERE id = ?1').bind(patientId),
        this.d1.prepare('SELECT * FROM chats WHERE patient_id = ?1 AND active = 1').bind(patientId),
        this.d1.prepare("SELECT * FROM medications WHERE patient_id = ?1 AND status = 'active'").bind(patientId),
        this.d1
          .prepare(
            `SELECT * FROM doses WHERE patient_id = ?1
             AND status IN ('scheduled','deferred','due','prompted')`,
          )
          .bind(patientId),
        this.d1.prepare("SELECT * FROM prompts WHERE patient_id = ?1 AND state = 'open'").bind(patientId),
        this.d1.prepare('SELECT * FROM meal_defs WHERE patient_id = ?1').bind(patientId),
        this.d1.prepare('SELECT * FROM meal_events WHERE patient_id = ?1 AND local_day = ?2').bind(patientId, today),
        this.d1.prepare('SELECT * FROM day_counters WHERE patient_id = ?1 AND local_day = ?2').bind(patientId, today),
    ]);

    // Indexed rather than destructured: `noUncheckedIndexedAccess` is on, and an empty
    // slot here would be a silently-missing table rather than a type error.
    const rows = (i: number): Row[] => batched[i]?.results ?? [];

    const prow = rows(0)[0];
    if (prow === undefined) return null;

    const dayCounters = new Map<number, { taken: number; missed: number }>();
    for (const r of rows(7)) {
      dayCounters.set(num(r['med_id']), { taken: num(r['taken']), missed: num(r['missed']) });
    }

    return {
      patient: rowToPatient(prow),
      chats: rows(1).map(rowToChat),
      meds: rows(2).map(rowToMed),
      liveDoses: rows(3).map(rowToDose),
      openPrompts: rows(4).map(rowToPrompt),
      mealDefs: rows(5).map(rowToMealDef),
      mealEvents: rows(6).map(rowToMealEvent),
      dayCounters,
    };
  }

  /**
   * Apply a plan.
   *
   * Inserts go first so their real ids can replace the planner's negative placeholders;
   * everything else follows in one batch, which D1 runs as a single implicit transaction.
   * Returns the id mapping plus the prompts that need sending.
   */
  async applyActions(
    state: PatientState,
    actions: Action[],
    now: number,
  ): Promise<{ doseIds: Map<number, number>; promptIds: Map<number, number> }> {
    const doseIds = new Map<number, number>();
    const promptIds = new Map<number, number>();
    const pid = state.patient.id;

    const medById = new Map(state.meds.map((m) => [m.id, m]));
    const doseById = new Map(state.liveDoses.map((d) => [d.id, d]));

    /**
     * Phase one: vacate the live slot before filling it.
     *
     * `uq_dose_live` permits exactly one live dose per medicine. When the planner rolls an
     * unanswered dose forward it emits the resolution *and* its successor in the same
     * plan, so if the insert ran first the index would reject it and the whole tick would
     * fail -- silently wedging the very medicine the roll-forward exists to keep moving.
     * The action list is already in the right order; this preserves it across the batch
     * boundary that `last_row_id` forces on us.
     */
    const vacating: D1PreparedStatement[] = [];
    for (const a of actions) {
      if (a.t === 'resolveDose') {
        vacating.push(
          ...this.resolveStatements(a.doseId, doseById.get(a.doseId), medById, a.status, a.takenAt, a.byChat, a.src, now, state),
        );
      } else if (a.t === 'setDoseStatus' && !['scheduled', 'deferred', 'due', 'prompted'].includes(a.status)) {
        vacating.push(this.d1.prepare('UPDATE doses SET status = ?2 WHERE id = ?1').bind(a.doseId, a.status));
      }
    }
    if (vacating.length > 0) await this.d1.batch(vacating);

    const creates = actions.filter(
      (a): a is Extract<Action, { t: 'createDose' } | { t: 'createPrompt' }> =>
        a.t === 'createDose' || a.t === 'createPrompt',
    );

    if (creates.length > 0) {
      const stmts = creates.map((a) =>
        a.t === 'createDose'
          ? this.d1
              .prepare(
                `INSERT INTO doses (patient_id, med_id, seq, step, local_day, planned_due_at,
                                    effective_due_at, anchor_kind, status, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'scheduled',?9)`,
              )
              .bind(pid, a.medId, a.seq, a.step, a.localDay, a.plannedDueAt, a.effectiveDueAt, a.anchorKind, now)
          : this.d1
              .prepare(
                `INSERT INTO prompts (patient_id, kind, state, body_json, created_at)
                 VALUES (?1,?2,'open',?3,?4)`,
              )
              .bind(pid, a.kind, JSON.stringify(a.body), now),
      );
      const results = await this.d1.batch(stmts);
      results.forEach((res, i) => {
        const a = creates[i]!;
        const id = num(res.meta.last_row_id);
        if (a.t === 'createDose') doseIds.set(a.id, id);
        else promptIds.set(a.id, id);
      });
    }

    const realDose = (id: number): number => doseIds.get(id) ?? id;
    const realPrompt = (id: number): number => promptIds.get(id) ?? id;

    const rest: D1PreparedStatement[] = [];

    for (const a of actions) {
      switch (a.t) {
        case 'setWake':
          rest.push(
            this.d1
              .prepare(
                `UPDATE patients SET wake_state = ?2, wake_confidence = ?3, wake_state_since = ?4,
                   last_wake_at = CASE WHEN ?2 = 'awake' THEN ?4 ELSE last_wake_at END,
                   last_sleep_at = CASE WHEN ?2 = 'asleep' THEN ?4 ELSE last_sleep_at END
                 WHERE id = ?1`,
              )
              .bind(pid, a.state, a.confidence, a.at),
            this.d1
              .prepare(
                `INSERT INTO wake_events (patient_id, kind, at, local_day, source)
                 VALUES (?1, ?2, ?3, ?4, ?5)`,
              )
              .bind(pid, a.state === 'awake' ? 'wake' : 'sleep', a.at, state.patient.localDay ?? '', a.source),
          );
          break;

        case 'rollDay':
          rest.push(this.d1.prepare('UPDATE patients SET local_day = ?2 WHERE id = ?1').bind(pid, a.localDay));
          break;

        case 'retimeDose':
          rest.push(
            this.d1
              .prepare(
                `UPDATE doses SET effective_due_at = ?2,
                   anchor_kind = COALESCE(?3, anchor_kind),
                   status = CASE WHEN status = 'deferred' THEN 'scheduled' ELSE status END
                 WHERE id = ?1`,
              )
              .bind(realDose(a.doseId), a.effectiveDueAt, a.anchorKind ?? null),
          );
          break;

        case 'setDoseStatus':
          // Terminal statuses were already applied in the vacating phase above.
          if (['scheduled', 'deferred', 'due', 'prompted'].includes(a.status)) {
            rest.push(
              this.d1.prepare('UPDATE doses SET status = ?2 WHERE id = ?1').bind(realDose(a.doseId), a.status),
            );
          }
          break;

        case 'resolveDose':
          break; // applied in the vacating phase

        case 'completeMed':
          rest.push(
            this.d1.prepare("UPDATE medications SET status = 'completed' WHERE id = ?1").bind(a.medId),
            this.d1
              .prepare('INSERT INTO audit_log (patient_id, at, kind, med_id, actor, detail_json) VALUES (?1,?2,?3,?4,?5,?6)')
              .bind(pid, now, 'course_complete', a.medId, 'system', JSON.stringify({ reason: a.reason })),
          );
          break;

        case 'createPrompt': {
          const promptId = realPrompt(a.id);
          for (const tempDoseId of a.body.doseIds) {
            rest.push(
              this.d1
                .prepare("UPDATE doses SET prompt_id = ?2, status = 'prompted', first_prompt_at = COALESCE(first_prompt_at, ?3) WHERE id = ?1")
                .bind(realDose(tempDoseId), promptId, now),
            );
          }
          // Rewrite the body with real ids so a later render does not have to remap.
          rest.push(
            this.d1
              .prepare('UPDATE prompts SET body_json = ?2 WHERE id = ?1')
              .bind(promptId, JSON.stringify({ ...a.body, doseIds: a.body.doseIds.map(realDose) })),
          );
          break;
        }

        case 'nudgePrompt':
          rest.push(
            this.d1
              .prepare('UPDATE prompts SET nudge_count = nudge_count + 1, last_nudge_at = ?2 WHERE id = ?1')
              .bind(realPrompt(a.promptId), a.at),
            this.d1
              .prepare("UPDATE doses SET nag_count = nag_count + 1 WHERE prompt_id = ?1 AND status = 'prompted'")
              .bind(realPrompt(a.promptId)),
          );
          break;

        case 'escalatePrompt':
          rest.push(
            this.d1.prepare('UPDATE prompts SET escalated_tier = ?2 WHERE id = ?1').bind(realPrompt(a.promptId), a.tier),
          );
          break;

        case 'closePrompt':
          rest.push(
            this.d1
              .prepare('UPDATE prompts SET state = ?2, resolved_at = ?3 WHERE id = ?1')
              .bind(realPrompt(a.promptId), a.state, a.at),
          );
          break;

        case 'recordMeal':
          rest.push(
            this.d1
              .prepare(
                `INSERT INTO meal_events (patient_id, meal, local_day, at, source) VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT (patient_id, meal, local_day) DO UPDATE SET at = ?4, source = ?5`,
              )
              .bind(pid, a.meal, a.localDay, a.at, a.source),
          );
          break;

        case 'setNextAction':
          rest.push(this.d1.prepare('UPDATE patients SET next_action_at = ?2 WHERE id = ?1').bind(pid, a.at));
          break;

        case 'advancePhase':
          rest.push(
            this.d1.prepare('UPDATE medications SET phase_index = ?2 WHERE id = ?1').bind(a.medId, a.phaseIndex),
            // The dose already scheduled under the previous phase is no longer right.
            this.d1
              .prepare(
                `UPDATE doses SET status = 'cancelled', resolved_at = ?2, resolution_src = 'import'
                 WHERE med_id = ?1 AND status IN ('scheduled','deferred','due','prompted')`,
              )
              .bind(a.medId, now),
            this.d1
              .prepare('INSERT INTO audit_log (patient_id, at, kind, med_id, actor, detail_json) VALUES (?1,?2,?3,?4,?5,?6)')
              .bind(pid, now, 'phase_advanced', a.medId, 'system', JSON.stringify({ phaseIndex: a.phaseIndex, label: a.label })),
          );
          break;

        case 'markDigestSent':
          rest.push(this.d1.prepare('UPDATE patients SET last_digest_day = ?2 WHERE id = ?1').bind(pid, a.localDay));
          break;

        case 'markWatchdogRun':
          rest.push(this.d1.prepare('UPDATE patients SET last_watchdog_at = ?2 WHERE id = ?1').bind(pid, a.at));
          break;

        case 'sendInfo':
          // Dispatched separately; recorded here so the digest and any watchdog alert
          // appear in the medical record alongside everything else.
          rest.push(
            this.d1
              .prepare('INSERT INTO audit_log (patient_id, at, kind, actor, detail_json) VALUES (?1,?2,?3,?4,?5)')
              .bind(pid, now, 'info_sent', 'system', JSON.stringify({ dedupe: a.dedupe })),
          );
          break;

        case 'note':
          rest.push(
            this.d1
              .prepare('INSERT INTO audit_log (patient_id, at, kind, actor, detail_json) VALUES (?1,?2,?3,?4,?5)')
              .bind(pid, now, a.kind, 'system', JSON.stringify(a.detail)),
          );
          break;
      }
    }

    if (rest.length > 0) await this.d1.batch(rest);
    return { doseIds, promptIds };
  }

  /** The statements that resolve one dose and roll its medicine forward. */
  private resolveStatements(
    doseId: number,
    dose: Dose | undefined,
    medById: Map<number, Medicine>,
    status: Resolution,
    takenAt: number | null,
    byChat: number | null,
    src: string,
    now: number,
    state: PatientState,
  ): D1PreparedStatement[] {
    const out: D1PreparedStatement[] = [
      this.d1
        .prepare(
          `UPDATE doses SET status = ?2, taken_at = ?3, resolved_at = ?4, resolved_by_chat = ?5, resolution_src = ?6
           WHERE id = ?1`,
        )
        .bind(doseId, status, status === 'taken' ? takenAt : null, now, byChat, src),
    ];
    if (dose === undefined) return out;
    const med = medById.get(dose.medId);
    if (med === undefined) return out;

    const adv = advanceMedicine(med, dose, status, takenAt);
    out.push(
      this.d1
        .prepare(
          `UPDATE medications SET last_taken_at = ?2, last_cycle_start_at = ?3, last_planned_due_at = ?4,
             next_seq = ?5, next_step = ?6, doses_taken = ?7, doses_missed = ?8, started_at = ?9
           WHERE id = ?1`,
        )
        .bind(
          med.id, adv.lastTakenAt, adv.lastCycleStartAt, adv.lastPlannedDueAt,
          adv.nextSeq, adv.nextStep, adv.dosesTaken, adv.dosesMissed, adv.startedAt,
        ),
    );

    if ((status === 'taken' || status === 'missed') && dose.step === 0) {
      out.push(
        this.d1
          .prepare(
            `INSERT INTO day_counters (patient_id, med_id, local_day, taken, missed) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT (patient_id, med_id, local_day) DO UPDATE SET
               taken = taken + ?4, missed = missed + ?5`,
          )
          .bind(state.patient.id, med.id, dose.localDay, status === 'taken' ? 1 : 0, status === 'missed' ? 1 : 0),
      );
    }

    out.push(
      this.d1
        .prepare('INSERT INTO audit_log (patient_id, at, kind, med_id, dose_id, actor, detail_json) VALUES (?1,?2,?3,?4,?5,?6,?7)')
        .bind(
          state.patient.id, now, `dose_${status}`, med.id, doseId,
          byChat === null ? 'system' : String(byChat),
          JSON.stringify({ takenAt, plannedDueAt: dose.plannedDueAt, src, step: dose.step }),
        ),
    );
    return out;
  }

  // --- acknowledgment (the contended path) --------------------------------

  /**
   * Resolve a dose on behalf of a chat.
   *
   * The precondition rides in the WHERE clause: two people tapping "Taken" at the same
   * moment produce two concurrent Worker invocations, and only the one whose UPDATE
   * actually changes a row may advance the schedule. The loser is told who beat them.
   */
  async tryResolveDose(
    doseId: number,
    chatId: number,
    status: Resolution,
    takenAt: number | null,
    now: number,
    src: string,
  ): Promise<{ won: boolean; dose: Dose | null; med: Medicine | null; alreadyBy: number | null }> {
    const before = await this.d1.prepare('SELECT * FROM doses WHERE id = ?1').bind(doseId).first<Row>();
    if (before === null) return { won: false, dose: null, med: null, alreadyBy: null };
    const dose = rowToDose(before);

    const res = await this.d1
      .prepare(
        `UPDATE doses SET status = ?2, taken_at = ?3, resolved_at = ?4, resolved_by_chat = ?5, resolution_src = ?6
         WHERE id = ?1 AND status IN ('scheduled','deferred','due','prompted')`,
      )
      .bind(doseId, status, status === 'taken' ? takenAt : null, now, chatId, src)
      .run();

    if (num(res.meta.changes) === 0) {
      const after = await this.d1.prepare('SELECT * FROM doses WHERE id = ?1').bind(doseId).first<Row>();
      return {
        won: false,
        dose: after === null ? null : rowToDose(after),
        med: null,
        alreadyBy: after === null ? null : numOrNull(after['resolved_by_chat']),
      };
    }

    const medRow = await this.d1.prepare('SELECT * FROM medications WHERE id = ?1').bind(dose.medId).first<Row>();
    const med = medRow === null ? null : rowToMed(medRow);
    if (med !== null) {
      const adv = advanceMedicine(med, dose, status, takenAt);
      await this.d1.batch([
        this.d1
          .prepare(
            `UPDATE medications SET last_taken_at = ?2, last_cycle_start_at = ?3, last_planned_due_at = ?4,
               next_seq = ?5, next_step = ?6, doses_taken = ?7, doses_missed = ?8, started_at = ?9
             WHERE id = ?1`,
          )
          .bind(med.id, adv.lastTakenAt, adv.lastCycleStartAt, adv.lastPlannedDueAt, adv.nextSeq, adv.nextStep, adv.dosesTaken, adv.dosesMissed, adv.startedAt),
        this.d1
          .prepare(
            `INSERT INTO day_counters (patient_id, med_id, local_day, taken, missed) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT (patient_id, med_id, local_day) DO UPDATE SET taken = taken + ?4, missed = missed + ?5`,
          )
          .bind(dose.patientId, med.id, dose.localDay, status === 'taken' && dose.step === 0 ? 1 : 0, status === 'missed' && dose.step === 0 ? 1 : 0),
        this.d1
          .prepare('INSERT INTO audit_log (patient_id, at, kind, med_id, dose_id, actor, detail_json) VALUES (?1,?2,?3,?4,?5,?6,?7)')
          .bind(dose.patientId, now, `dose_${status}`, med.id, doseId, String(chatId), JSON.stringify({ takenAt, src, step: dose.step })),
        this.d1.prepare('UPDATE patients SET next_action_at = ?2 WHERE id = ?1').bind(dose.patientId, now),
      ]);
    }

    return { won: true, dose, med, alreadyBy: null };
  }

  /**
   * Flip an already-resolved dose back to taken, at a stated time.
   * This is the retrospective correction path: it must also re-derive the schedule, which
   * the caller triggers by cancelling the live dose and letting the next tick rebuild it.
   */
  async correctDose(
    doseId: number,
    chatId: number,
    takenAt: number,
    now: number,
  ): Promise<{ dose: Dose; med: Medicine } | null> {
    const row = await this.d1.prepare('SELECT * FROM doses WHERE id = ?1').bind(doseId).first<Row>();
    if (row === null) return null;
    const dose = rowToDose(row);
    const medRow = await this.d1.prepare('SELECT * FROM medications WHERE id = ?1').bind(dose.medId).first<Row>();
    if (medRow === null) return null;
    const med = rowToMed(medRow);

    const adv = advanceMedicine(med, dose, 'taken', takenAt);
    const wasMissed = dose.status === 'missed';

    await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE doses SET status = 'taken', taken_at = ?2, resolved_at = ?3, resolved_by_chat = ?4,
             resolution_src = 'correction' WHERE id = ?1`,
        )
        .bind(doseId, takenAt, now, chatId),
      // Cancel whatever the scheduler built on top of the wrong assumption; the next tick
      // rebuilds it from the corrected anchor.
      this.d1
        .prepare(
          `UPDATE doses SET status = 'cancelled', resolved_at = ?2, resolution_src = 'correction'
           WHERE med_id = ?1 AND status IN ('scheduled','deferred','due','prompted')`,
        )
        .bind(dose.medId, now),
      this.d1
        .prepare(
          `UPDATE medications SET last_taken_at = ?2, last_cycle_start_at = ?3, last_planned_due_at = ?4,
             next_seq = ?5, next_step = ?6, doses_taken = ?7, doses_missed = ?8, started_at = ?9
           WHERE id = ?1`,
        )
        .bind(med.id, adv.lastTakenAt, adv.lastCycleStartAt, adv.lastPlannedDueAt, adv.nextSeq, adv.nextStep, adv.dosesTaken, Math.max(0, wasMissed ? med.dosesMissed - 1 : med.dosesMissed), adv.startedAt),
      this.d1
        .prepare(
          `INSERT INTO day_counters (patient_id, med_id, local_day, taken, missed) VALUES (?1,?2,?3,1,?4)
           ON CONFLICT (patient_id, med_id, local_day) DO UPDATE SET taken = taken + 1, missed = MAX(0, missed + ?4)`,
        )
        .bind(dose.patientId, med.id, dose.localDay, wasMissed ? -1 : 0),
      // Append-only: the original value and the revision both survive. It is a medical record.
      this.d1
        .prepare('INSERT INTO audit_log (patient_id, at, kind, med_id, dose_id, actor, detail_json) VALUES (?1,?2,?3,?4,?5,?6,?7)')
        .bind(
          dose.patientId, now, 'dose_corrected', med.id, doseId, String(chatId),
          JSON.stringify({ from: dose.status, to: 'taken', originalResolvedAt: dose.resolvedAt, correctedTakenAt: takenAt }),
        ),
      this.d1.prepare('UPDATE patients SET next_action_at = ?2 WHERE id = ?1').bind(dose.patientId, now),
    ]);

    return { dose, med };
  }

  async recentDoses(medId: number, limit = 12): Promise<Dose[]> {
    const res = await this.d1
      .prepare('SELECT * FROM doses WHERE med_id = ?1 ORDER BY planned_due_at DESC LIMIT ?2')
      .bind(medId, limit)
      .all<Row>();
    return (res.results ?? []).map(rowToDose);
  }

  async liveDoseFor(medId: number): Promise<Dose | null> {
    const row = await this.d1
      .prepare(
        `SELECT * FROM doses WHERE med_id = ?1 AND status IN ('scheduled','deferred','due','prompted') LIMIT 1`,
      )
      .bind(medId)
      .first<Row>();
    return row === null ? null : rowToDose(row);
  }

  async getDose(doseId: number): Promise<Dose | null> {
    const row = await this.d1.prepare('SELECT * FROM doses WHERE id = ?1').bind(doseId).first<Row>();
    return row === null ? null : rowToDose(row);
  }

  async snoozeDose(doseId: number, until: number, now: number): Promise<boolean> {
    // Moves the prompt, never the grid: planned_due_at is untouched, so repeatedly
    // snoozing cannot ratchet the whole schedule forward.
    const res = await this.d1
      .prepare(
        `UPDATE doses SET effective_due_at = ?2, status = 'scheduled', prompt_id = NULL
         WHERE id = ?1 AND status IN ('due','prompted')`,
      )
      .bind(doseId, until)
      .run();
    void now;
    return num(res.meta.changes) > 0;
  }

  // --- medicines ----------------------------------------------------------

  async medsFor(patientId: number, includeInactive = false): Promise<Medicine[]> {
    const sql = includeInactive
      ? 'SELECT * FROM medications WHERE patient_id = ?1 ORDER BY name'
      : "SELECT * FROM medications WHERE patient_id = ?1 AND status = 'active' ORDER BY name";
    const res = await this.d1.prepare(sql).bind(patientId).all<Row>();
    return (res.results ?? []).map(rowToMed);
  }

  async getMed(medId: number): Promise<Medicine | null> {
    const row = await this.d1.prepare('SELECT * FROM medications WHERE id = ?1').bind(medId).first<Row>();
    return row === null ? null : rowToMed(row);
  }

  /**
   * Change one medicine's configuration in place.
   *
   * Any change to *when* it is due invalidates the dose already scheduled under the old
   * rule, so the live dose is cancelled and the next tick rebuilds it. Course progress and
   * history are untouched -- editing a dose text should not restart a seven-day course.
   */
  async updateMed(
    medId: number,
    patch: Partial<Pick<Medicine, 'name' | 'doseText' | 'notes' | 'intervalMs' | 'minGapMs' | 'maxPerDay' | 'critical' | 'awakeOnly' | 'stepSpacingMs' | 'courseDays' | 'courseKind' | 'driftPolicy'>> & { spec?: Medicine['spec'] },
    opts: { rescheduleNow: boolean },
    now: number,
  ): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    const put = (col: string, value: unknown): void => {
      binds.push(value);
      sets.push(`${col} = ?${binds.length + 1}`);
    };

    if (patch.name !== undefined) put('name', patch.name);
    if (patch.doseText !== undefined) put('dose_text', patch.doseText);
    if (patch.notes !== undefined) put('notes', patch.notes);
    if (patch.intervalMs !== undefined) put('interval_ms', patch.intervalMs);
    if (patch.minGapMs !== undefined) put('min_gap_ms', patch.minGapMs);
    if (patch.maxPerDay !== undefined) put('max_per_day', patch.maxPerDay);
    if (patch.critical !== undefined) put('critical', patch.critical ? 1 : 0);
    if (patch.awakeOnly !== undefined) put('awake_only', patch.awakeOnly ? 1 : 0);
    if (patch.stepSpacingMs !== undefined) put('step_spacing_ms', patch.stepSpacingMs);
    if (patch.courseDays !== undefined) put('course_days', patch.courseDays);
    if (patch.courseKind !== undefined) put('course_kind', patch.courseKind);
    if (patch.driftPolicy !== undefined) put('drift_policy', patch.driftPolicy);
    if (patch.spec !== undefined) {
      put('spec_json', JSON.stringify(patch.spec));
      put('kind', patch.spec.kind);
    }
    if (sets.length === 0) return;

    const stmts: D1PreparedStatement[] = [
      this.d1.prepare(`UPDATE medications SET ${sets.join(', ')} WHERE id = ?1`).bind(medId, ...binds),
    ];
    if (opts.rescheduleNow) {
      stmts.push(
        this.d1
          .prepare(
            `UPDATE doses SET status = 'cancelled', resolved_at = ?2, resolution_src = 'import'
             WHERE med_id = ?1 AND status IN ('scheduled','deferred','due','prompted')`,
          )
          .bind(medId, now),
      );
    }
    await this.d1.batch(stmts);
  }

  /** Insert medicines into an existing prescription without disturbing the others. */
  async addMedicines(patientId: number, meds: NormalizedPrescription['meds'], now: number): Promise<void> {
    if (meds.length === 0) return;
    await this.d1.batch(
      meds.map((m) =>
        this.d1
          .prepare(
            `INSERT INTO medications (patient_id, med_key, name, dose_text, notes, kind, spec_json, spec_hash,
               steps_json, step_spacing_ms, interval_ms, min_gap_ms, onset_offset_ms, max_per_day,
               awake_only, critical, drift_policy, drift_tolerance_ms, catchup_grace_ms, nag_policy_json,
               mergeable, course_kind, course_days, course_doses, course_until, spacing_group, spacing_ms,
               phases_json, status, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,'active',?29)`,
          )
          .bind(
            patientId, m.medKey, m.name, m.doseText, m.notes, m.kind, JSON.stringify(m.spec), m.specHash,
            JSON.stringify(m.steps), m.stepSpacingMs, m.intervalMs, m.minGapMs, m.onsetOffsetMs, m.maxPerDay,
            m.awakeOnly ? 1 : 0, m.critical ? 1 : 0, m.driftPolicy, m.driftToleranceMs, m.catchupGraceMs,
            JSON.stringify(m.nagPolicy), m.mergeable ? 1 : 0, m.courseKind, m.courseDays, m.courseDoses,
            m.courseUntil, m.spacingGroup, m.spacingMs,
            m.phases === null ? null : JSON.stringify(m.phases), now,
          ),
      ),
    );
  }

  async setMedStatus(medId: number, status: Medicine['status'], now: number): Promise<void> {
    await this.d1.batch([
      this.d1.prepare('UPDATE medications SET status = ?2 WHERE id = ?1').bind(medId, status),
      this.d1
        .prepare(
          `UPDATE doses SET status = 'cancelled', resolved_at = ?2
           WHERE med_id = ?1 AND status IN ('scheduled','deferred','due','prompted')`,
        )
        .bind(medId, now),
    ]);
  }

  // --- prompts ------------------------------------------------------------

  async getPrompt(promptId: number): Promise<Prompt | null> {
    const row = await this.d1.prepare('SELECT * FROM prompts WHERE id = ?1').bind(promptId).first<Row>();
    return row === null ? null : rowToPrompt(row);
  }

  async openPromptsFor(patientId: number): Promise<Prompt[]> {
    const res = await this.d1
      .prepare("SELECT * FROM prompts WHERE patient_id = ?1 AND state = 'open'")
      .bind(patientId)
      .all<Row>();
    return (res.results ?? []).map(rowToPrompt);
  }

  async closePrompt(promptId: number, state: Prompt['state'], now: number): Promise<void> {
    await this.d1
      .prepare('UPDATE prompts SET state = ?2, resolved_at = ?3 WHERE id = ?1')
      .bind(promptId, state, now)
      .run();
  }

  async promptMessages(promptId: number): Promise<Array<{ chatId: number; messageId: number | null }>> {
    const res = await this.d1
      .prepare("SELECT chat_id, message_id FROM prompt_messages WHERE prompt_id = ?1 AND send_state = 'sent'")
      .bind(promptId)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ chatId: num(r['chat_id']), messageId: numOrNull(r['message_id']) }));
  }

  async recordPromptMessage(
    promptId: number,
    chatId: number,
    messageId: number | null,
    sendState: string,
    now: number,
    error?: string,
  ): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO prompt_messages (prompt_id, chat_id, message_id, send_state, last_error, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT (prompt_id, chat_id) DO UPDATE SET message_id = ?3, send_state = ?4, last_error = ?5, updated_at = ?6`,
      )
      .bind(promptId, chatId, messageId, sendState, error ?? null, now)
      .run();
  }

  async clearPromptMessage(promptId: number, chatId: number): Promise<void> {
    await this.d1
      .prepare("UPDATE prompt_messages SET send_state = 'deleted' WHERE prompt_id = ?1 AND chat_id = ?2")
      .bind(promptId, chatId)
      .run();
  }

  // --- meals --------------------------------------------------------------

  async recordMeal(
    patientId: number,
    meal: string,
    localDay: string,
    at: number,
    source: MealEvent['source'],
  ): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO meal_events (patient_id, meal, local_day, at, source) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT (patient_id, meal, local_day) DO UPDATE SET at = ?4, source = ?5`,
      )
      .bind(patientId, meal, localDay, at, source)
      .run();
  }

  async mealDefsFor(patientId: number): Promise<MealDef[]> {
    const res = await this.d1.prepare('SELECT * FROM meal_defs WHERE patient_id = ?1').bind(patientId).all<Row>();
    return (res.results ?? []).map(rowToMealDef);
  }

  async mealEventsFor(patientId: number, localDay: string): Promise<MealEvent[]> {
    const res = await this.d1
      .prepare('SELECT * FROM meal_events WHERE patient_id = ?1 AND local_day = ?2')
      .bind(patientId, localDay)
      .all<Row>();
    return (res.results ?? []).map(rowToMealEvent);
  }

  async setWake(
    patientId: number,
    state: 'awake' | 'asleep',
    at: number,
    localDay: string,
    source: string,
    byChat: number | null,
  ): Promise<void> {
    await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE patients SET wake_state = ?2, wake_confidence = 'confirmed', wake_state_since = ?3,
             last_wake_at = CASE WHEN ?2 = 'awake' THEN ?3 ELSE last_wake_at END,
             last_sleep_at = CASE WHEN ?2 = 'asleep' THEN ?3 ELSE last_sleep_at END,
             next_action_at = ?3
           WHERE id = ?1`,
        )
        .bind(patientId, state, at),
      this.d1
        .prepare('INSERT INTO wake_events (patient_id, kind, at, local_day, source, by_chat) VALUES (?1,?2,?3,?4,?5,?6)')
        .bind(patientId, state === 'awake' ? 'wake' : 'sleep', at, localDay, source, byChat),
    ]);
  }

  // --- prescriptions ------------------------------------------------------

  async stageePrescription(
    patientId: number,
    raw: string,
    hash: string,
    diff: string,
    chatId: number,
    now: number,
  ): Promise<number> {
    const res = await this.d1
      .prepare(
        `INSERT INTO prescription_versions (patient_id, raw_json, json_hash, state, diff_text, imported_at, imported_by_chat)
         VALUES (?1,?2,?3,'pending_confirm',?4,?5,?6) RETURNING id`,
      )
      .bind(patientId, raw, hash, diff, now, chatId)
      .first<Row>();
    return num(res?.['id']);
  }

  async getPrescriptionVersion(id: number): Promise<{ patientId: number; raw: string; state: string } | null> {
    const row = await this.d1.prepare('SELECT * FROM prescription_versions WHERE id = ?1').bind(id).first<Row>();
    if (row === null) return null;
    return { patientId: num(row['patient_id']), raw: str(row['raw_json']), state: str(row['state']) };
  }

  /**
   * Activate a staged prescription.
   *
   * Course progress is keyed on `med_key`, so a corrected prescription preserves the
   * counters of medicines that have not changed rather than restarting a seven-day
   * antibiotic on day five. A medicine that changed keeps its counters but loses its live
   * dose, which the next tick recomputes; one that disappeared is discontinued, never
   * deleted, because the history has to stay.
   */
  async activatePrescription(
    versionId: number,
    patientId: number,
    presc: NormalizedPrescription,
    now: number,
  ): Promise<{ added: string[]; changed: string[]; stopped: string[] }> {
    const existing = await this.medsFor(patientId, true);
    const byKey = new Map(existing.map((m) => [m.medKey, m]));
    const added: string[] = [];
    const changed: string[] = [];
    const stopped: string[] = [];

    const stmts: D1PreparedStatement[] = [];

    for (const m of presc.meds) {
      const prev = byKey.get(m.medKey);
      if (prev === undefined) {
        added.push(m.name);
        stmts.push(
          this.d1
            .prepare(
              `INSERT INTO medications (patient_id, med_key, name, dose_text, notes, kind, spec_json, spec_hash,
                 steps_json, step_spacing_ms, interval_ms, min_gap_ms, onset_offset_ms, max_per_day,
                 awake_only, critical, drift_policy, drift_tolerance_ms, catchup_grace_ms, nag_policy_json,
                 mergeable, course_kind, course_days, course_doses, course_until, spacing_group,
                 spacing_ms, phases_json, status, version_id, created_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,'active',?29,?30)`,
            )
            .bind(
              patientId, m.medKey, m.name, m.doseText, m.notes, m.kind, JSON.stringify(m.spec), m.specHash,
              JSON.stringify(m.steps), m.stepSpacingMs, m.intervalMs, m.minGapMs, m.onsetOffsetMs, m.maxPerDay,
              m.awakeOnly ? 1 : 0, m.critical ? 1 : 0, m.driftPolicy, m.driftToleranceMs, m.catchupGraceMs,
              JSON.stringify(m.nagPolicy), m.mergeable ? 1 : 0, m.courseKind, m.courseDays, m.courseDoses,
              m.courseUntil, m.spacingGroup, m.spacingMs,
              m.phases === null ? null : JSON.stringify(m.phases), versionId, now,
            ),
        );
        continue;
      }

      if (prev.specHash === m.specHash && prev.status === 'active') continue; // untouched

      changed.push(m.name);
      stmts.push(
        this.d1
          .prepare(
            `UPDATE medications SET name = ?2, dose_text = ?3, notes = ?4, kind = ?5, spec_json = ?6, spec_hash = ?7,
               steps_json = ?8, step_spacing_ms = ?9, interval_ms = ?10, min_gap_ms = ?11, onset_offset_ms = ?12,
               max_per_day = ?13, awake_only = ?14, critical = ?15, drift_policy = ?16, drift_tolerance_ms = ?17,
               catchup_grace_ms = ?18, nag_policy_json = ?19, mergeable = ?20, course_kind = ?21, course_days = ?22,
               course_doses = ?23, course_until = ?24, spacing_group = ?25, spacing_ms = ?26,
               phases_json = ?27, status = 'active', version_id = ?28, next_step = 0
             WHERE id = ?1`,
          )
          .bind(
            prev.id, m.name, m.doseText, m.notes, m.kind, JSON.stringify(m.spec), m.specHash,
            JSON.stringify(m.steps), m.stepSpacingMs, m.intervalMs, m.minGapMs, m.onsetOffsetMs, m.maxPerDay,
            m.awakeOnly ? 1 : 0, m.critical ? 1 : 0, m.driftPolicy, m.driftToleranceMs, m.catchupGraceMs,
            JSON.stringify(m.nagPolicy), m.mergeable ? 1 : 0, m.courseKind, m.courseDays, m.courseDoses,
            m.courseUntil, m.spacingGroup, m.spacingMs,
            m.phases === null ? null : JSON.stringify(m.phases), versionId,
          ),
        this.d1
          .prepare(
            `UPDATE doses SET status = 'cancelled', resolved_at = ?2, resolution_src = 'import'
             WHERE med_id = ?1 AND status IN ('scheduled','deferred','due','prompted')`,
          )
          .bind(prev.id, now),
      );
    }

    const incoming = new Set(presc.meds.map((m) => m.medKey));
    for (const prev of existing) {
      if (incoming.has(prev.medKey) || prev.status !== 'active') continue;
      stopped.push(prev.name);
      stmts.push(
        this.d1.prepare("UPDATE medications SET status = 'discontinued' WHERE id = ?1").bind(prev.id),
        this.d1
          .prepare(
            `UPDATE doses SET status = 'cancelled', resolved_at = ?2, resolution_src = 'import'
             WHERE med_id = ?1 AND status IN ('scheduled','deferred','due','prompted')`,
          )
          .bind(prev.id, now),
      );
    }

    for (const meal of presc.meals) {
      stmts.push(
        this.d1
          .prepare(
            `INSERT INTO meal_defs (patient_id, meal, typical_local, ask_after_local, presume_at_local)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT (patient_id, meal) DO UPDATE SET typical_local = ?3, ask_after_local = ?4, presume_at_local = ?5`,
          )
          .bind(patientId, meal.meal, meal.typicalLocal, meal.askAfterLocal, meal.presumeAtLocal),
      );
    }

    const d = presc.day;
    stmts.push(
      this.d1
        .prepare(
          `UPDATE patients SET
             tz = COALESCE(?2, tz),
             display_name = COALESCE(?3, display_name),
             morning_poll_at = COALESCE(?4, morning_poll_at),
             presumed_wake_at = COALESCE(?5, presumed_wake_at),
             evening_poll_at = COALESCE(?6, evening_poll_at),
             presumed_sleep_at = COALESCE(?7, presumed_sleep_at),
             digest_at = COALESCE(?8, digest_at),
             next_action_at = ?9
           WHERE id = ?1`,
        )
        .bind(
          patientId, presc.tz, presc.patientName,
          d.morningPollAt ?? null, d.presumedWakeAt ?? null, d.eveningPollAt ?? null,
          d.presumedSleepAt ?? null, d.digestAt ?? null, now,
        ),
      this.d1
        .prepare("UPDATE prescription_versions SET state = 'superseded' WHERE patient_id = ?1 AND state = 'active'")
        .bind(patientId),
      this.d1
        .prepare("UPDATE prescription_versions SET state = 'active', activated_at = ?2 WHERE id = ?1")
        .bind(versionId, now),
    );

    await this.d1.batch(stmts);
    return { added, changed, stopped };
  }

  async latestPrescription(patientId: number): Promise<string | null> {
    const row = await this.d1
      .prepare("SELECT raw_json FROM prescription_versions WHERE patient_id = ?1 AND state = 'active' ORDER BY imported_at DESC LIMIT 1")
      .bind(patientId)
      .first<Row>();
    return row === null ? null : str(row['raw_json']);
  }

  // --- the outbound queue ---------------------------------------------------

  /**
   * Queue a message rather than dropping it.
   *
   * A Worker invocation gets 50 subrequests and Telegram rate-limits per chat, so a busy
   * tick can genuinely run out of room mid-fan-out. Without this, that reminder is simply
   * lost -- and a lost reminder is the failure mode this whole system exists to avoid.
   */
  async enqueue(
    item: {
      patientId: number | null;
      chatId: number;
      method: string;
      payload: unknown;
      priority?: number;
      promptId?: number | null;
      dedupeKey?: string | null;
      notBefore?: number;
    },
    now: number,
  ): Promise<void> {
    await this.d1
      .prepare(
        `INSERT OR IGNORE INTO outbox (patient_id, chat_id, method, payload_json, prompt_id,
           priority, not_before, dedupe_key, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
      )
      .bind(
        item.patientId, item.chatId, item.method, JSON.stringify(item.payload),
        item.promptId ?? null, item.priority ?? 100, item.notBefore ?? now,
        item.dedupeKey ?? null, now,
      )
      .run();
  }

  async dueOutbox(now: number, limit: number): Promise<Array<{
    id: number; chatId: number; method: string; payload: Record<string, unknown>;
    promptId: number | null; attempts: number; priority: number;
  }>> {
    const res = await this.d1
      .prepare(
        `SELECT * FROM outbox WHERE state = 'queued' AND not_before <= ?1
         ORDER BY priority, id LIMIT ?2`,
      )
      .bind(now, limit)
      .all<Row>();
    return (res.results ?? []).map((r) => ({
      id: num(r['id']),
      chatId: num(r['chat_id']),
      method: str(r['method']),
      payload: json(r['payload_json'], {} as Record<string, unknown>),
      promptId: numOrNull(r['prompt_id']),
      attempts: num(r['attempts']),
      priority: num(r['priority']),
    }));
  }

  async settleOutbox(
    id: number,
    outcome: 'sent' | 'retry' | 'dropped',
    now: number,
    opts: { error?: string; retryAfterMs?: number } = {},
  ): Promise<void> {
    if (outcome === 'retry') {
      // Exponential backoff, honouring a 429's retry_after when Telegram gave one.
      await this.d1
        .prepare(
          `UPDATE outbox SET attempts = attempts + 1, last_error = ?2,
             not_before = ?3,
             state = CASE WHEN attempts + 1 >= 8 THEN 'failed' ELSE 'queued' END
           WHERE id = ?1`,
        )
        .bind(id, opts.error ?? null, now + (opts.retryAfterMs ?? 60_000))
        .run();
      return;
    }
    await this.d1
      .prepare('UPDATE outbox SET state = ?2, last_error = ?3 WHERE id = ?1')
      .bind(id, outcome === 'sent' ? 'sent' : 'dropped', opts.error ?? null)
      .run();
  }

  async gcOutbox(before: number): Promise<void> {
    await this.d1.prepare("DELETE FROM outbox WHERE state != 'queued' AND created_at < ?1").bind(before).run();
  }

  async outboxDepth(): Promise<number> {
    const row = await this.d1.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'queued'").first<Row>();
    return row === null ? 0 : num(row['n']);
  }

  // --- misc ---------------------------------------------------------------

  /** Insert-first dedupe: Telegram redelivers updates, and a repeated "taken" double-counts. */
  async claimUpdate(updateId: number, now: number): Promise<boolean> {
    try {
      const res = await this.d1
        .prepare('INSERT OR IGNORE INTO processed_updates (update_id, seen_at) VALUES (?1, ?2)')
        .bind(updateId, now)
        .run();
      return num(res.meta.changes) > 0;
    } catch {
      return false;
    }
  }

  async gcUpdates(before: number): Promise<void> {
    await this.d1.prepare('DELETE FROM processed_updates WHERE seen_at < ?1').bind(before).run();
  }

  async heartbeat(now: number, localDay: string): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO heartbeat (id, last_tick_at, ticks_today, local_day) VALUES (1, ?1, 1, ?2)
         ON CONFLICT (id) DO UPDATE SET last_tick_at = ?1,
           ticks_today = CASE WHEN local_day = ?2 THEN ticks_today + 1 ELSE 1 END,
           local_day = ?2`,
      )
      .bind(now, localDay)
      .run();
  }

  async getHeartbeat(): Promise<{ lastTickAt: number; ticksToday: number } | null> {
    const row = await this.d1.prepare('SELECT * FROM heartbeat WHERE id = 1').first<Row>();
    return row === null ? null : { lastTickAt: num(row['last_tick_at']), ticksToday: num(row['ticks_today']) };
  }

  async kvGet(key: string): Promise<string | null> {
    const row = await this.d1.prepare('SELECT v FROM kv WHERE k = ?1').bind(key).first<Row>();
    return row === null ? null : str(row['v']);
  }

  async kvSet(key: string, value: string): Promise<void> {
    await this.d1
      .prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = ?2')
      .bind(key, value)
      .run();
  }

  async audit(patientId: number | null, kind: string, actor: string, detail: unknown, now: number): Promise<void> {
    await this.d1
      .prepare('INSERT INTO audit_log (patient_id, at, kind, actor, detail_json) VALUES (?1,?2,?3,?4,?5)')
      .bind(patientId, now, kind, actor, JSON.stringify(detail))
      .run();
  }

  async adherence(patientId: number, sinceDay: string): Promise<Array<{ medId: number; status: DoseStatus; n: number }>> {
    const res = await this.d1
      .prepare(
        `SELECT med_id, status, COUNT(*) AS n FROM doses
         WHERE patient_id = ?1 AND local_day >= ?2 AND status IN ('taken','missed','skipped')
         GROUP BY med_id, status`,
      )
      .bind(patientId, sinceDay)
      .all<Row>();
    return (res.results ?? []).map((r) => ({
      medId: num(r['med_id']),
      status: str(r['status']) as DoseStatus,
      n: num(r['n']),
    }));
  }
}

// --- row mappers ---------------------------------------------------------

function rowToPatient(r: Row): Patient {
  return {
    id: num(r['id']),
    displayName: str(r['display_name']),
    tz: str(r['tz']),
    morningPollAt: str(r['morning_poll_at']),
    presumedWakeAt: str(r['presumed_wake_at']),
    eveningPollAt: str(r['evening_poll_at']),
    presumedSleepAt: str(r['presumed_sleep_at']),
    quietStart: strOrNull(r['quiet_start']),
    quietEnd: strOrNull(r['quiet_end']),
    wakeState: str(r['wake_state']) as Patient['wakeState'],
    wakeConfidence: str(r['wake_confidence']) as Patient['wakeConfidence'],
    wakeStateSince: num(r['wake_state_since']),
    lastWakeAt: numOrNull(r['last_wake_at']),
    lastSleepAt: numOrNull(r['last_sleep_at']),
    lastActivityAt: numOrNull(r['last_activity_at']),
    localDay: strOrNull(r['local_day']),
    digestAt: str(r['digest_at']),
    pausedUntil: numOrNull(r['paused_until']),
    nextActionAt: numOrNull(r['next_action_at']),
    lastDigestDay: strOrNull(r['last_digest_day']),
    lastWatchdogAt: numOrNull(r['last_watchdog_at']),
  };
}

function rowToChat(r: Row): Chat {
  return {
    chatId: num(r['chat_id']),
    patientId: num(r['patient_id']),
    role: str(r['role']) as Chat['role'],
    canAck: bool(r['can_ack']),
    escalationTier: num(r['escalation_tier']),
    escalateAfterMs: num(r['escalate_after_ms']),
    active: bool(r['active']),
  };
}

function rowToMed(r: Row): Medicine {
  return {
    id: num(r['id']),
    patientId: num(r['patient_id']),
    medKey: str(r['med_key']),
    name: str(r['name']),
    doseText: strOrNull(r['dose_text']),
    notes: strOrNull(r['notes']),
    kind: str(r['kind']) as Medicine['kind'],
    spec: json(r['spec_json'], { kind: 'interval' } as Medicine['spec']),
    specHash: str(r['spec_hash']),
    steps: json(r['steps_json'], [] as Medicine['steps']),
    stepSpacingMs: num(r['step_spacing_ms']),
    spacingGroup: strOrNull(r['spacing_group']),
    spacingMs: num(r['spacing_ms'] ?? 0),
    phases: (() => {
      const raw = r['phases_json'];
      if (typeof raw !== 'string' || raw === '') return null;
      try { return JSON.parse(raw) as Medicine['phases']; } catch { return null; }
    })(),
    phaseIndex: num(r['phase_index'] ?? 0),
    intervalMs: numOrNull(r['interval_ms']),
    minGapMs: num(r['min_gap_ms']),
    onsetOffsetMs: num(r['onset_offset_ms']),
    maxPerDay: numOrNull(r['max_per_day']),
    awakeOnly: bool(r['awake_only']),
    critical: bool(r['critical']),
    driftPolicy: str(r['drift_policy']) as Medicine['driftPolicy'],
    driftToleranceMs: num(r['drift_tolerance_ms']),
    catchupGraceMs: num(r['catchup_grace_ms']),
    nagPolicy: json(r['nag_policy_json'], { stepsMs: [600_000], escalateAfterMs: 300_000 }),
    mergeable: bool(r['mergeable']),
    courseKind: str(r['course_kind']) as Medicine['courseKind'],
    courseDays: numOrNull(r['course_days']),
    courseDoses: numOrNull(r['course_doses']),
    courseUntil: numOrNull(r['course_until']),
    startedAt: numOrNull(r['started_at']),
    dosesTaken: num(r['doses_taken']),
    dosesMissed: num(r['doses_missed']),
    lastTakenAt: numOrNull(r['last_taken_at']),
    lastCycleStartAt: numOrNull(r['last_cycle_start_at']),
    lastPlannedDueAt: numOrNull(r['last_planned_due_at']),
    nextSeq: num(r['next_seq']),
    nextStep: num(r['next_step']),
    status: str(r['status']) as Medicine['status'],
  };
}

function rowToDose(r: Row): Dose {
  return {
    id: num(r['id']),
    patientId: num(r['patient_id']),
    medId: num(r['med_id']),
    seq: num(r['seq']),
    step: num(r['step']),
    localDay: str(r['local_day']),
    plannedDueAt: num(r['planned_due_at']),
    effectiveDueAt: num(r['effective_due_at']),
    anchorKind: str(r['anchor_kind']) as Dose['anchorKind'],
    status: str(r['status']) as DoseStatus,
    takenAt: numOrNull(r['taken_at']),
    resolvedAt: numOrNull(r['resolved_at']),
    resolvedByChat: numOrNull(r['resolved_by_chat']),
    resolutionSrc: strOrNull(r['resolution_src']) as Dose['resolutionSrc'],
    nagCount: num(r['nag_count']),
    firstPromptAt: numOrNull(r['first_prompt_at']),
    promptId: numOrNull(r['prompt_id']),
  };
}

function rowToPrompt(r: Row): Prompt {
  return {
    id: num(r['id']),
    patientId: num(r['patient_id']),
    kind: str(r['kind']) as Prompt['kind'],
    state: str(r['state']) as Prompt['state'],
    body: json(r['body_json'], { kind: 'info', doseIds: [] } as Prompt['body']),
    nudgeCount: num(r['nudge_count']),
    lastNudgeAt: numOrNull(r['last_nudge_at']),
    escalatedTier: num(r['escalated_tier']),
    createdAt: num(r['created_at']),
  };
}

function rowToMealDef(r: Row): MealDef {
  return {
    patientId: num(r['patient_id']),
    meal: str(r['meal']),
    typicalLocal: str(r['typical_local']),
    askAfterLocal: str(r['ask_after_local']),
    presumeAtLocal: strOrNull(r['presume_at_local']),
  };
}

function rowToMealEvent(r: Row): MealEvent {
  return {
    patientId: num(r['patient_id']),
    meal: str(r['meal']),
    localDay: str(r['local_day']),
    at: num(r['at']),
    source: str(r['source']) as MealEvent['source'],
  };
}
