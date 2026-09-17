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
    displayName: string | null = null,
  ): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO chats (chat_id, patient_id, role, can_ack, escalation_tier, escalate_after_ms, active, linked_at, display_name)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, 1, ?6, ?7)
         ON CONFLICT (chat_id, patient_id) DO UPDATE SET
           -- Never demote the patient's own chat. Redeeming a caregiver code for yourself
           -- would otherwise turn your own chat into a backup for you, and you would stop
           -- getting reminders first-hand -- silently, since a caregiver link looks
           -- perfectly healthy from the outside.
           role = CASE WHEN chats.role = 'patient' THEN 'patient' ELSE ?3 END,
           escalation_tier = CASE WHEN chats.role = 'patient' THEN 0 ELSE ?4 END,
           escalate_after_ms = ?5, active = 1, blocked_at = NULL,
           display_name = COALESCE(?7, display_name)`,
      )
      .bind(chatId, patientId, role, tier, escalateAfterMs, now, displayName)
      .run();
  }

  /**
   * Break one caregiver link. Deliberately a hard delete rather than a flag: someone who
   * has stepped back should stop appearing in the other person's list of who is watching
   * them, not linger as an inactive row.
   */
  async unlinkChat(chatId: number, patientId: number, now: number): Promise<boolean> {
    const res = await this.d1
      .prepare("DELETE FROM chats WHERE chat_id = ?1 AND patient_id = ?2 AND role = 'caregiver'")
      .bind(chatId, patientId)
      .run();
    const removed = num(res.meta.changes) > 0;
    if (removed) {
      await this.audit(patientId, 'caregiver_removed', String(chatId), { chatId }, now);
    }
    return removed;
  }

  async caregiversFor(patientId: number): Promise<Chat[]> {
    const res = await this.d1
      .prepare("SELECT * FROM chats WHERE patient_id = ?1 AND role = 'caregiver' AND active = 1 ORDER BY linked_at")
      .bind(patientId)
      .all<Row>();
    return (res.results ?? []).map(rowToChat);
  }

  async deactivateChat(chatId: number, now: number): Promise<void> {
    // A blocked bot would otherwise burn a subrequest per tick forever.
    await this.d1
      .prepare('UPDATE chats SET active = 0, blocked_at = ?2 WHERE chat_id = ?1')
      .bind(chatId, now)
      .run();
  }

  // --- the planner snapshot ----------------------------------------------

  async loadState(patientId: number, today: string, mealDay = today): Promise<PatientState | null> {
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
        // Meals belong to the waking day. Someone still up at half past midnight has not
        // had a fresh breakfast, lunch and dinner to answer for.
        this.d1.prepare('SELECT * FROM meal_events WHERE patient_id = ?1 AND local_day = ?2').bind(patientId, mealDay),
        this.d1.prepare('SELECT * FROM day_counters WHERE patient_id = ?1 AND local_day = ?2').bind(patientId, today),
        // The waking day, which is what "four times a day" actually means.
        this.d1
          .prepare(
            `SELECT med_id, COUNT(*) AS n FROM doses
              WHERE patient_id = ?1 AND status IN ('taken','missed','skipped') AND step = 0
                AND COALESCE(taken_at, resolved_at, 0) >=
                  (SELECT COALESCE(last_wake_at, wake_state_since, 0) FROM patients WHERE id = ?1)
              GROUP BY med_id`,
          )
          .bind(patientId),
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

    const dosesSinceWake = new Map<number, number>();
    for (const r of rows(8)) dosesSinceWake.set(num(r['med_id']), num(r['n']));

    return {
      patient: rowToPatient(prow),
      chats: rows(1).map(rowToChat),
      meds: rows(2).map(rowToMed),
      liveDoses: rows(3).map(rowToDose),
      openPrompts: rows(4).map(rowToPrompt),
      mealDefs: rows(5).map(rowToMealDef),
      mealEvents: rows(6).map(rowToMealEvent),
      dayCounters,
      dosesSinceWake,
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
      } else if (a.t === 'advancePhase') {
        // A taper stepping down cancels what the old phase had scheduled, and the planner
        // creates the replacement in the same pass. The cancel therefore has to clear the
        // one-live-dose index before the insert, or the whole tick fails on it.
        vacating.push(
          this.d1
            .prepare(
              `UPDATE doses SET status = 'cancelled', resolved_at = ?2, resolution_src = 'import'
                WHERE med_id = ?1 AND status IN ('scheduled','deferred','due','prompted')`,
            )
            .bind(a.medId, now),
        );
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
                   -- A dose moved onto a new wake anchor belongs to today, so its planned
                   -- time moves with it and drift is measured from the new grid.
                   -- A dose moved onto a new anchor belongs to that anchor, so its
                   -- planned time moves with it and drift is measured from the new grid.
                   planned_due_at = CASE WHEN ?3 IN ('wake','meal') THEN ?2 ELSE planned_due_at END,
                   prompt_id = CASE WHEN ?3 IN ('wake','meal') AND ?2 > ?4 THEN NULL ELSE prompt_id END,
                   status = CASE
                     WHEN status = 'deferred' THEN 'scheduled'
                     WHEN ?3 IN ('wake','meal') AND ?2 > ?4 AND status IN ('due','prompted') THEN 'scheduled'
                     ELSE status END
                 WHERE id = ?1`,
              )
              .bind(realDose(a.doseId), a.effectiveDueAt, a.anchorKind ?? null, now),
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
            // A closed prompt must not leave a dose pointing at it. `prompted` with a
            // dead prompt is the quietest failure this system has: nothing re-prompts it,
            // because a new prompt is only made for a dose whose prompt_id is null, and
            // nothing nudges it, because the prompt is gone. The medicine simply stops.
            this.d1
              .prepare(
                `UPDATE doses SET prompt_id = NULL,
                   status = CASE WHEN status = 'prompted' THEN 'due' ELSE status END
                 WHERE prompt_id = ?1`,
              )
              .bind(realPrompt(a.promptId)),
          );
          break;

        case 'recordMeal':
          rest.push(
            this.d1
              .prepare(
                `INSERT INTO meal_events (patient_id, meal, local_day, at, source, planned_at)
                 VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT (patient_id, meal, local_day) DO UPDATE SET
                   at = ?4, source = ?5, planned_at = COALESCE(?6, planned_at)`,
              )
              .bind(pid, a.meal, a.localDay, a.at, a.source, a.plannedAt ?? null),
          );
          break;

        case 'closeMealPrompt':
          rest.push(
            this.d1
              .prepare(
                `UPDATE prompts SET state = 'resolved', resolved_at = ?3
                 WHERE patient_id = ?1 AND state = 'open' AND kind = 'meal'
                   AND json_extract(body_json, '$.meal') = ?2`,
              )
              .bind(pid, a.meal, now),
          );
          break;

        case 'setNextAction':
          rest.push(this.d1.prepare('UPDATE patients SET next_action_at = ?2 WHERE id = ?1').bind(pid, a.at));
          break;

        case 'advancePhase':
          rest.push(
            this.d1.prepare('UPDATE medications SET phase_index = ?2 WHERE id = ?1').bind(a.medId, a.phaseIndex),
            // The dose the old phase had scheduled is cancelled in the vacating pass above,
            // so the replacement can be inserted in this same batch.
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

        case 'setExpectedSleep':
          rest.push(this.d1.prepare('UPDATE patients SET expected_sleep_at = ?2 WHERE id = ?1').bind(pid, a.at));
          break;

        case 'setExpectedWake':
          rest.push(this.d1.prepare('UPDATE patients SET expected_wake_at = ?2 WHERE id = ?1').bind(pid, a.at));
          break;

        case 'setPromptBody':
          rest.push(
            this.d1
              .prepare('UPDATE prompts SET body_json = ?2 WHERE id = ?1')
              .bind(a.promptId, JSON.stringify(a.body)),
          );
          break;

        case 'markWakeCheck':
          rest.push(this.d1.prepare('UPDATE patients SET last_wake_check_at = ?2 WHERE id = ?1').bind(pid, a.at));
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
          // Guarded, like every other resolution. The tick loaded its snapshot a second or
          // two ago; if the patient tapped "Taken" in between, this would rewrite the row
          // to missed and wipe the tap out of the medical record. The race is not a remote
          // one -- the moment the planner gives up on a dose is exactly the moment people
          // answer it. The counter updates below are conditional on the same guard.
          `UPDATE doses SET status = ?2, taken_at = ?3, resolved_at = ?4, resolved_by_chat = ?5, resolution_src = ?6
           WHERE id = ?1 AND status IN ('scheduled','deferred','due','prompted')`,
        )
        .bind(doseId, status, status === 'taken' ? takenAt : null, now, byChat, src),
    ];
    if (dose === undefined) return out;
    const med = medById.get(dose.medId);
    if (med === undefined) return out;

    // Everything after the resolution is conditional on it having WON. The statements run
    // in order within one batch, so this sees the row as the line above left it: if the
    // patient's own tap got there first, the cursor does not move, the day's counters do
    // not move, and no second entry lands in the record for one dose.
    const won = `EXISTS (SELECT 1 FROM doses WHERE id = ${Math.trunc(doseId)} AND resolved_at = ${Math.trunc(now)} AND resolution_src = ?ws)`;

    const adv = advanceMedicine(med, dose, status, takenAt);
    out.push(
      this.d1
        .prepare(
          `UPDATE medications SET last_taken_at = ?2, last_cycle_start_at = ?3, last_planned_due_at = ?4,
             next_seq = ?5, next_step = ?6, doses_taken = ?7, doses_missed = ?8, started_at = ?9
           WHERE id = ?1 AND ${won.replace('?ws', '?10')}`,
        )
        .bind(
          med.id, adv.lastTakenAt, adv.lastCycleStartAt, adv.lastPlannedDueAt,
          adv.nextSeq, adv.nextStep, adv.dosesTaken, adv.dosesMissed, adv.startedAt, src,
        ),
    );

    if ((status === 'taken' || status === 'missed') && dose.step === 0) {
      out.push(
        this.d1
          .prepare(
            `INSERT INTO day_counters (patient_id, med_id, local_day, taken, missed)
             SELECT ?1,?2,?3,?4,?5 WHERE ${won.replace('?ws', '?6')}
             ON CONFLICT (patient_id, med_id, local_day) DO UPDATE SET
               taken = taken + ?4, missed = missed + ?5`,
          )
          .bind(state.patient.id, med.id, dose.localDay, status === 'taken' ? 1 : 0, status === 'missed' ? 1 : 0, src),
      );
    }

    out.push(
      this.d1
        .prepare(
          `INSERT INTO audit_log (patient_id, at, kind, med_id, dose_id, actor, detail_json)
           SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE ${won.replace('?ws', '?8')}`,
        )
        .bind(
          state.patient.id, now, `dose_${status}`, med.id, doseId,
          byChat === null ? 'system' : String(byChat),
          JSON.stringify({ takenAt, plannedDueAt: dose.plannedDueAt, src, step: dose.step }),
          src,
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
          .bind(
            dose.patientId, now, `dose_${status}`, med.id, doseId, String(chatId),
            // The medicine's cursor before it moved. /undo restores exactly this, which
            // is the only way to put a mistaken tap back without guessing at the schedule
            // that produced it.
            JSON.stringify({
              takenAt, src, step: dose.step,
              prevDoseStatus: dose.status,
              prev: {
                lastTakenAt: med.lastTakenAt,
                lastCycleStartAt: med.lastCycleStartAt,
                lastPlannedDueAt: med.lastPlannedDueAt,
                nextSeq: med.nextSeq,
                nextStep: med.nextStep,
                dosesTaken: med.dosesTaken,
                dosesMissed: med.dosesMissed,
                startedAt: med.startedAt,
              },
            }),
          ),
        this.d1.prepare('UPDATE patients SET next_action_at = ?2 WHERE id = ?1').bind(dose.patientId, now),
      ]);
    }

    return { won: true, dose, med, alreadyBy: null };
  }

  /**
   * Everything still hanging over the patient right now: due, being nagged about, or
   * parked for the night. What you would want listed if you were about to go to bed.
   */
  async outstandingDoses(patientId: number): Promise<Array<{ dose: Dose; med: Medicine; label: string }>> {
    const res = await this.d1
      .prepare(
        `SELECT d.* FROM doses d
          WHERE d.patient_id = ?1 AND d.status IN ('due','prompted','deferred')
          ORDER BY d.effective_due_at`,
      )
      .bind(patientId)
      .all<Row>();
    const out: Array<{ dose: Dose; med: Medicine; label: string }> = [];
    for (const row of res.results) {
      const dose = rowToDose(row);
      const medRow = await this.d1.prepare('SELECT * FROM medications WHERE id = ?1').bind(dose.medId).first<Row>();
      if (medRow === null) continue;
      const med = rowToMed(medRow);
      const step = med.steps[dose.step];
      out.push({
        dose,
        med,
        label: med.steps.length > 1 ? `${step?.name ?? med.name} (${dose.step + 1}/${med.steps.length})` : med.name,
      });
    }
    return out;
  }

  /**
   * Put back the last thing that was logged.
   *
   * A tap is one thumb-width from the wrong button, and the case that made this necessary
   * was someone confirming two doses at five in the morning that they had not taken. The
   * menu already offered /undo; all it did was explain how to say the right thing
   * instead, which is no use at all when what you need is the record to stop being wrong.
   *
   * Restores the dose, the medicine's cursor and the day's counters from the snapshot
   * taken when it was resolved, then lets the planner rebuild the live dose from there.
   */
  async undoLast(
    patientIds: number[],
    now: number,
    withinMs = 24 * 3600_000,
  ): Promise<{ medName: string; status: string; at: number } | null> {
    if (patientIds.length === 0) return null;
    const list = patientIds.map((n) => Math.trunc(n)).join(',');
    // A handful of candidates, not just the newest. An entry whose dose has since been
    // deleted -- a re-import, a reset -- must not block undo for everything behind it,
    // which is exactly what "the last thing I did is unreachable" feels like from the
    // other end.
    const candidates = await this.d1
      .prepare(
        `SELECT a.* FROM audit_log a
          WHERE a.patient_id IN (${list})
            AND a.kind IN ('dose_taken','dose_skipped','dose_missed','day_state_set','meal_set')
            AND a.at >= ?1
            AND NOT EXISTS (
              SELECT 1 FROM audit_log u
               WHERE u.kind = 'undone' AND u.dose_id = a.id AND u.at >= a.at)
          ORDER BY a.at DESC, a.id DESC LIMIT 20`,
      )
      .bind(now - withinMs)
      .all<Row>();

    for (const candidate of candidates.results) {
      const done = await this.undoOne(candidate, now);
      if (done !== null) return done;
    }
    return null;
  }

  private async undoOne(row: Row, now: number): Promise<{ medName: string; status: string; at: number } | null> {

    // Every undone entry is marked by its own id, so stepping back twice steps back two
    // decisions rather than bouncing off the same one.
    const markUndone = (patientId: number): D1PreparedStatement =>
      this.d1
        .prepare('INSERT INTO audit_log (patient_id, at, kind, med_id, dose_id, actor, detail_json) VALUES (?1,?2,?3,NULL,?4,?5,?6)')
        .bind(patientId, now, 'undone', num(row['id']), 'undo', JSON.stringify({ was: str(row['kind']) }));

    if (str(row['kind']) === 'day_state_set') {
      const patientId = numOrNull(row['patient_id']);
      if (patientId === null) return null;
      let d: { to?: string; prev?: Record<string, unknown> } = {};
      try {
        d = JSON.parse(str(row['detail_json'] ?? '{}')) as typeof d;
      } catch {
        return null;
      }
      const prev = d.prev;
      if (prev === undefined) return null;
      await this.d1.batch([
        this.d1
          .prepare(
            `UPDATE patients SET wake_state = ?2, wake_confidence = ?3, wake_state_since = ?4,
               last_wake_at = ?5, last_sleep_at = ?6, next_action_at = ?7 WHERE id = ?1`,
          )
          .bind(
            patientId, String(prev['wakeState'] ?? 'asleep'), String(prev['wakeConfidence'] ?? 'presumed'),
            Number(prev['wakeStateSince'] ?? now), (prev['lastWakeAt'] ?? null) as number | null,
            (prev['lastSleepAt'] ?? null) as number | null, now,
          ),
        markUndone(patientId),
      ]);
      return { medName: d.to === 'awake' ? 'starting the day' : 'ending the day', status: 'undone', at: num(row['at']) };
    }

    if (str(row['kind']) === 'meal_set') {
      const patientId = numOrNull(row['patient_id']);
      if (patientId === null) return null;
      let d: { meal?: string; localDay?: string; prev?: Record<string, unknown> | null } = {};
      try {
        d = JSON.parse(str(row['detail_json'] ?? '{}')) as typeof d;
      } catch {
        return null;
      }
      if (d.meal === undefined || d.localDay === undefined) return null;
      await this.d1.batch([
        d.prev === null || d.prev === undefined
          ? this.d1
              .prepare('DELETE FROM meal_events WHERE patient_id = ?1 AND meal = ?2 AND local_day = ?3')
              .bind(patientId, d.meal, d.localDay)
          : this.d1
              .prepare(
                `UPDATE meal_events SET at = ?4, source = ?5, planned_at = ?6
                  WHERE patient_id = ?1 AND meal = ?2 AND local_day = ?3`,
              )
              .bind(
                patientId, d.meal, d.localDay, Number(d.prev['at'] ?? now),
                String(d.prev['source'] ?? 'confirmed'), (d.prev['plannedAt'] ?? null) as number | null,
              ),
        this.d1.prepare('UPDATE patients SET next_action_at = ?2 WHERE id = ?1').bind(patientId, now),
        markUndone(patientId),
      ]);
      return { medName: d.meal, status: 'un-recorded', at: num(row['at']) };
    }

    const doseId = numOrNull(row['dose_id']);
    const medId = numOrNull(row['med_id']);
    const patientId = numOrNull(row['patient_id']);
    if (doseId === null || medId === null || patientId === null) return null;

    let detail: { prevDoseStatus?: string; prev?: Record<string, number | null> } = {};
    try {
      detail = JSON.parse(str(row['detail_json'] ?? '{}')) as typeof detail;
    } catch {
      return null;
    }
    const prev = detail.prev;
    if (prev === undefined) return null;

    const doseRow = await this.d1.prepare('SELECT * FROM doses WHERE id = ?1').bind(doseId).first<Row>();
    if (doseRow === null) return null; // deleted since; try the next candidate
    const dose = rowToDose(doseRow);
    const medRow = await this.d1.prepare('SELECT * FROM medications WHERE id = ?1').bind(medId).first<Row>();
    const medName = medRow === null ? 'that medicine' : str(medRow['name']);
    const kind = str(row['kind']).replace('dose_', '');

    // Whatever the planner scheduled next for this medicine is downstream of the mistake,
    // so it goes; the next tick builds the right one from the restored cursor.
    await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE doses SET status = ?2, taken_at = NULL, resolved_at = NULL,
             resolved_by_chat = NULL, resolution_src = NULL WHERE id = ?1`,
        )
        .bind(doseId, detail.prevDoseStatus ?? 'due'),
      this.d1
        .prepare(
          `DELETE FROM doses WHERE med_id = ?1 AND id <> ?2
             AND status IN ('scheduled','deferred','due','prompted')`,
        )
        .bind(medId, doseId),
      this.d1
        .prepare(
          `UPDATE medications SET last_taken_at = ?2, last_cycle_start_at = ?3, last_planned_due_at = ?4,
             next_seq = ?5, next_step = ?6, doses_taken = ?7, doses_missed = ?8, started_at = ?9
           WHERE id = ?1`,
        )
        .bind(
          medId, prev['lastTakenAt'] ?? null, prev['lastCycleStartAt'] ?? null,
          prev['lastPlannedDueAt'] ?? null, prev['nextSeq'] ?? 1, prev['nextStep'] ?? 0,
          prev['dosesTaken'] ?? 0, prev['dosesMissed'] ?? 0, prev['startedAt'] ?? null,
        ),
      this.d1
        .prepare(
          `UPDATE day_counters SET taken = MAX(taken - ?4, 0), missed = MAX(missed - ?5, 0)
           WHERE patient_id = ?1 AND med_id = ?2 AND local_day = ?3`,
        )
        .bind(patientId, medId, dose.localDay, kind === 'taken' && dose.step === 0 ? 1 : 0, kind === 'missed' && dose.step === 0 ? 1 : 0),
      markUndone(patientId),
      this.d1.prepare('UPDATE patients SET next_action_at = ?2 WHERE id = ?1').bind(patientId, now),
    ]);

    return { medName, status: kind, at: num(row['at']) };
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
               group_seq, phases_json, status, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,'active',?30)`,
          )
          .bind(
            patientId, m.medKey, m.name, m.doseText, m.notes, m.kind, JSON.stringify(m.spec), m.specHash,
            JSON.stringify(m.steps), m.stepSpacingMs, m.intervalMs, m.minGapMs, m.onsetOffsetMs, m.maxPerDay,
            m.awakeOnly ? 1 : 0, m.critical ? 1 : 0, m.driftPolicy, m.driftToleranceMs, m.catchupGraceMs,
            JSON.stringify(m.nagPolicy), m.mergeable ? 1 : 0, m.courseKind, m.courseDays, m.courseDoses,
            m.courseUntil, m.spacingGroup, m.spacingMs, m.groupSeq,
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
    await this.d1.batch([
      this.d1
        .prepare('UPDATE prompts SET state = ?2, resolved_at = ?3 WHERE id = ?1')
        .bind(promptId, state, now),
      // See applyActions: a dose left `prompted` against a closed prompt goes silent.
      this.d1
        .prepare(
          `UPDATE doses SET prompt_id = NULL,
             status = CASE WHEN status = 'prompted' THEN 'due' ELSE status END
           WHERE prompt_id = ?1`,
        )
        .bind(promptId),
    ]);
  }

  /**
   * Notes posted about a dose that are not prompts -- the "give it ten minutes, and here
   * is a button if you already did" that follows a spaced drop.
   *
   * They need taking down when the dose they are about is answered, or the chat keeps an
   * "✅ Already did Prednisolone" button live long after Prednisolone was done, and
   * tapping it says something confusing about a dose that has moved on.
   */
  async noteMessage(doseId: number, chatId: number, messageId: number, now: number): Promise<void> {
    const key = `note:${doseId}`;
    const raw = await this.kvGet(key);
    const list = raw === null || raw === '' ? [] : (JSON.parse(raw) as Array<[number, number]>);
    list.push([chatId, messageId]);
    await this.kvSet(key, JSON.stringify(list.slice(-6)));
    void now;
  }

  async takeDownNotes(doseId: number): Promise<Array<{ chatId: number; messageId: number }>> {
    const key = `note:${doseId}`;
    const raw = await this.kvGet(key);
    if (raw === null || raw === '') return [];
    await this.kvSet(key, '');
    try {
      return (JSON.parse(raw) as Array<[number, number]>).map(([chatId, messageId]) => ({ chatId, messageId }));
    } catch {
      return [];
    }
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
    plannedAt: number | null = null,
    byChat: number | null = null,
    /** When the write happened. The audit used to stamp itself with the *meal's* time,
     *  which makes the log say a dinner was recorded at dinner time however long after
     *  the fact the button was actually pressed -- and that gap is exactly what goes
     *  wrong with meals. */
    writtenAt: number | null = null,
  ): Promise<void> {
    const before = byChat === null
      ? null
      : await this.d1
          .prepare('SELECT * FROM meal_events WHERE patient_id = ?1 AND meal = ?2 AND local_day = ?3')
          .bind(patientId, meal, localDay)
          .first<Row>();

    await this.d1.batch([
      this.d1
        .prepare(
          `INSERT INTO meal_events (patient_id, meal, local_day, at, source, planned_at)
           VALUES (?1,?2,?3,?4,?5,?6)
           ON CONFLICT (patient_id, meal, local_day) DO UPDATE SET
             at = ?4, source = ?5, planned_at = COALESCE(?6, planned_at)`,
        )
        .bind(patientId, meal, localDay, at, source, plannedAt),
      ...(byChat === null
        ? []
        : [
            this.d1
              .prepare('INSERT INTO audit_log (patient_id, at, kind, med_id, dose_id, actor, detail_json) VALUES (?1,?2,?3,NULL,NULL,?4,?5)')
              .bind(patientId, writtenAt ?? at, 'meal_set', String(byChat), JSON.stringify({
                meal, localDay, at,
                prev: before === null
                  ? null
                  : { at: num(before['at']), source: str(before['source']), plannedAt: numOrNull(before['planned_at']) },
              })),
          ]),
    ]);
  }

  async mealDefsFor(patientId: number): Promise<MealDef[]> {
    // In meal order. Without the ORDER BY, SQLite served them off the (patient, meal)
    // index -- alphabetically -- and /status listed breakfast, dinner, lunch.
    const res = await this.d1
      .prepare('SELECT * FROM meal_defs WHERE patient_id = ?1 ORDER BY seq, typical_local')
      .bind(patientId)
      .all<Row>();
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
    // Only a person's decision is undoable. The planner presuming someone is up is not a
    // decision anybody made, and offering to reverse it would be noise.
    const human = source === 'command' || source === 'button';
    const before = human
      ? await this.d1
          .prepare(
            `SELECT wake_state, wake_confidence, wake_state_since, last_wake_at, last_sleep_at
               FROM patients WHERE id = ?1`,
          )
          .bind(patientId)
          .first<Row>()
      : null;

    await this.d1.batch([
      ...(before === null
        ? []
        : [
            this.d1
              .prepare('INSERT INTO audit_log (patient_id, at, kind, med_id, dose_id, actor, detail_json) VALUES (?1,?2,?3,NULL,NULL,?4,?5)')
              .bind(patientId, at, 'day_state_set', String(byChat ?? 'system'), JSON.stringify({
                to: state,
                prev: {
                  wakeState: str(before['wake_state']),
                  wakeConfidence: str(before['wake_confidence']),
                  wakeStateSince: num(before['wake_state_since']),
                  lastWakeAt: numOrNull(before['last_wake_at']),
                  lastSleepAt: numOrNull(before['last_sleep_at']),
                },
              })),
          ]),
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

  /** Move tonight's bedtime, and wake the planner so it re-plans against the new one. */
  async setExpectedSleep(patientId: number, at: number | null, now: number): Promise<void> {
    await this.d1
      .prepare('UPDATE patients SET expected_sleep_at = ?2, next_action_at = ?3 WHERE id = ?1')
      .bind(patientId, at, now)
      .run();
  }

  /** Push back when the bot will next ask whether they are up. */
  async setExpectedWake(patientId: number, at: number | null, now: number): Promise<void> {
    await this.d1
      .prepare(
        'UPDATE patients SET expected_wake_at = ?2, last_wake_check_at = ?3, next_action_at = ?2 WHERE id = ?1',
      )
      .bind(patientId, at, now)
      .run();
  }

  /**
   * Write back the doses that should have happened while nobody was logging.
   *
   * Someone who got up at seven and only reaches for their phone at eleven has had four
   * hours of doses either taken-and-unlogged or genuinely missed. Leaving that as a hole
   * is the worst of both: the adherence record is wrong, and the schedule carries on from
   * a cycle that never started. They go in as missed -- the honest default -- and each one
   * comes back with a button to say otherwise.
   */
  async reconstructMissed(
    med: Medicine,
    patientId: number,
    times: number[],
    localDayOf: (at: number) => string,
    now: number,
  ): Promise<Array<{ id: number; at: number }>> {
    if (times.length === 0) return [];
    const made: Array<{ id: number; at: number }> = [];
    let seq = med.nextSeq;
    for (const at of times) {
      const res = await this.d1
        .prepare(
          `INSERT INTO doses (patient_id, med_id, seq, step, local_day, planned_due_at,
             effective_due_at, anchor_kind, status, resolved_at, resolution_src, created_at)
           VALUES (?1,?2,?3,0,?4,?5,?5,'wake','missed',?6,'reconstructed',?6)`,
        )
        .bind(patientId, med.id, seq, localDayOf(at), at, now)
        .run();
      made.push({ id: num(res.meta.last_row_id), at });
      seq++;
    }
    const last = times[times.length - 1]!;
    await this.d1
      .prepare(
        `UPDATE medications SET next_seq = ?2, doses_missed = doses_missed + ?3,
           last_cycle_start_at = ?4, last_planned_due_at = ?4,
           started_at = COALESCE(started_at, ?5)
         WHERE id = ?1`,
      )
      .bind(med.id, seq, times.length, last, times[0]!)
      .run();
    return made;
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
                 spacing_ms, group_seq, phases_json, status, version_id, created_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,'active',?30,?31)`,
            )
            .bind(
              patientId, m.medKey, m.name, m.doseText, m.notes, m.kind, JSON.stringify(m.spec), m.specHash,
              JSON.stringify(m.steps), m.stepSpacingMs, m.intervalMs, m.minGapMs, m.onsetOffsetMs, m.maxPerDay,
              m.awakeOnly ? 1 : 0, m.critical ? 1 : 0, m.driftPolicy, m.driftToleranceMs, m.catchupGraceMs,
              JSON.stringify(m.nagPolicy), m.mergeable ? 1 : 0, m.courseKind, m.courseDays, m.courseDoses,
              m.courseUntil, m.spacingGroup, m.spacingMs, m.groupSeq,
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
               group_seq = ?27, phases_json = ?28, status = 'active', version_id = ?29, next_step = 0
             WHERE id = ?1`,
          )
          .bind(
            prev.id, m.name, m.doseText, m.notes, m.kind, JSON.stringify(m.spec), m.specHash,
            JSON.stringify(m.steps), m.stepSpacingMs, m.intervalMs, m.minGapMs, m.onsetOffsetMs, m.maxPerDay,
            m.awakeOnly ? 1 : 0, m.critical ? 1 : 0, m.driftPolicy, m.driftToleranceMs, m.catchupGraceMs,
            JSON.stringify(m.nagPolicy), m.mergeable ? 1 : 0, m.courseKind, m.courseDays, m.courseDoses,
            m.courseUntil, m.spacingGroup, m.spacingMs, m.groupSeq,
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

    // Ordered, because "the meal after breakfast" has to mean something: the planner
    // spaces each meal from the previous one and derives its assumed time from the
    // patient's waking. Without a sequence every meal looked like the first one.
    for (const [index, meal] of presc.meals.entries()) {
      stmts.push(
        this.d1
          .prepare(
            `INSERT INTO meal_defs (patient_id, meal, typical_local, ask_after_local, presume_at_local, seq)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT (patient_id, meal) DO UPDATE SET
               typical_local = ?3, ask_after_local = ?4, presume_at_local = ?5, seq = ?6`,
          )
          .bind(patientId, meal.meal, meal.typicalLocal, meal.askAfterLocal, meal.presumeAtLocal, index),
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
             min_sleep_ms = COALESCE(?10, min_sleep_ms),
             next_action_at = ?9
           WHERE id = ?1`,
        )
        .bind(
          patientId, presc.tz, presc.patientName,
          d.morningPollAt ?? null, d.presumedWakeAt ?? null, d.eveningPollAt ?? null,
          d.presumedSleepAt ?? null, d.digestAt ?? null, now, d.minSleepMs ?? null,
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

  /**
   * The doses themselves, newest first -- what /log is actually for.
   *
   * A percentage answers "how am I doing"; what someone reaches for the log to settle is
   * "did that get taken, and when". Those are different questions and the second one is
   * the one with a wrong answer you can act on.
   */
  async doseHistory(
    patientId: number,
    sinceDay: string,
    limit = 60,
  ): Promise<Array<{ medId: number; step: number; status: DoseStatus; at: number; src: string | null }>> {
    const res = await this.d1
      .prepare(
        `SELECT med_id, step, status, COALESCE(taken_at, resolved_at) AS at, resolution_src FROM doses
         WHERE patient_id = ?1 AND local_day >= ?2 AND status IN ('taken','missed','skipped')
           AND COALESCE(taken_at, resolved_at) IS NOT NULL
         ORDER BY at DESC LIMIT ?3`,
      )
      .bind(patientId, sinceDay, limit)
      .all<Row>();
    return (res.results ?? []).map((r) => ({
      medId: num(r['med_id']),
      step: num(r['step']),
      status: str(r['status']) as DoseStatus,
      at: num(r['at']),
      src: r['resolution_src'] === null ? null : str(r['resolution_src']),
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
    minSleepMs: numOrNull(r['min_sleep_ms']) ?? 4 * 3_600_000,
    expectedSleepAt: numOrNull(r['expected_sleep_at']),
    expectedWakeAt: numOrNull(r['expected_wake_at']),
    lastWakeCheckAt: numOrNull(r['last_wake_check_at']),
    bedLeadFirstMs: numOrNull(r['bed_lead_first_ms']) ?? 3_600_000,
    bedLeadSecondMs: numOrNull(r['bed_lead_second_ms']) ?? 1_800_000,
    postBedGraceMs: numOrNull(r['post_bed_grace_ms']) ?? 3_600_000,
    wakeCheckEveryMs: numOrNull(r['wake_check_every_ms']) ?? 3_600_000,
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
    displayName: strOrNull(r['display_name']),
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
    groupSeq: numOrNull(r['group_seq']),
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
    afterWakeMs: numOrNull(r['after_wake_ms']),
    minGapAfterPrevMs: num(r['min_gap_after_prev_ms'] ?? 10_800_000),
    seq: num(r['seq'] ?? 0),
  };
}

function rowToMealEvent(r: Row): MealEvent {
  return {
    patientId: num(r['patient_id']),
    meal: str(r['meal']),
    localDay: str(r['local_day']),
    at: num(r['at']),
    source: str(r['source']) as MealEvent['source'],
    plannedAt: numOrNull(r['planned_at']),
    askedAt: numOrNull(r['asked_at']),
  };
}
