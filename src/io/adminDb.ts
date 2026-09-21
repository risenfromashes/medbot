/**
 * Database access for the dashboard: the admin account, sessions, invites, and the
 * read-only views over everyone's schedule.
 *
 * Kept separate from `Db` because the trust boundary is different. Everything the bot
 * does is scoped to a chat that has already proved which patient it belongs to; the
 * dashboard reads across the whole family group, and that access is what the session
 * check upstream is protecting.
 */

import type { Dose, Medicine, Patient } from '../core/domain.js';
import {
  DEFAULT_ITERATIONS, SESSION_TTL_MS, b64, clampIterations, constantTimeEqual,
  generatePassword, hashPassword, humanCode, randomBytes, randomToken, sha256Hex, unb64,
} from './auth.js';

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  mustChange: boolean;
  createdAt: number;
  passwordChangedAt: number | null;
  lastLoginAt: number | null;
}

export interface Invite {
  code: string;
  kind: 'enrol' | 'caregiver';
  patientId: number | null;
  label: string | null;
  escalateAfterMs: number | null;
  createdAt: number;
  createdBy: string;
  expiresAt: number;
  usedAt: number | null;
  usedByChat: number | null;
}

export interface RedeemResult {
  ok: boolean;
  invite?: Invite;
  reason?: 'unknown' | 'used' | 'expired' | 'wrong_kind';
}

export class AdminDb {
  private iterationsCache: number | null = null;

  constructor(private readonly d1: D1Database) {}

  /**
   * The PBKDF2 work factor, read from the database rather than compiled in, so the deploy
   * script can calibrate it to whatever this runtime can actually afford inside the CPU
   * budget. Cached for the life of the request.
   */
  async iterations(): Promise<number> {
    if (this.iterationsCache !== null) return this.iterationsCache;
    const row = await this.d1.prepare("SELECT v FROM kv WHERE k = 'pbkdf2_iterations'").first<Row>();
    const value = row === null ? DEFAULT_ITERATIONS : clampIterations(Number(row['v']));
    this.iterationsCache = value;
    return value;
  }

  async setIterations(n: number): Promise<number> {
    const value = clampIterations(n);
    await this.d1
      .prepare("INSERT INTO kv (k, v) VALUES ('pbkdf2_iterations', ?1) ON CONFLICT (k) DO UPDATE SET v = ?1")
      .bind(String(value))
      .run();
    this.iterationsCache = value;
    return value;
  }

  // --- the admin account ---------------------------------------------------

  async adminExists(): Promise<boolean> {
    const row = await this.d1.prepare('SELECT id FROM admin_users WHERE id = 1').first<Row>();
    return row !== null;
  }

  async getAdmin(): Promise<AdminUser | null> {
    const row = await this.d1.prepare('SELECT * FROM admin_users WHERE id = 1').first<Row>();
    if (row === null) return null;
    return {
      id: num(row['id']),
      username: str(row['username']),
      displayName: str(row['display_name']),
      mustChange: num(row['must_change']) !== 0,
      createdAt: num(row['created_at']),
      passwordChangedAt: numOrNull(row['password_changed_at']),
      lastLoginAt: numOrNull(row['last_login_at']),
    };
  }

  /**
   * Creates the single admin account with a generated password, returned once. There is
   * no recovery path: if it is lost, /setup has to be re-run to reset the account.
   */
  async createAdmin(username: string, displayName: string, now: number): Promise<string> {
    const password = generatePassword();
    const iterations = await this.iterations();
    const salt = randomBytes(16);
    const hash = await hashPassword(password, salt, iterations);
    await this.d1
      .prepare(
        `INSERT INTO admin_users (id, username, display_name, password_hash, password_salt,
           iterations, must_change, created_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, 1, ?6)`,
      )
      .bind(username, displayName, hash, b64(salt), iterations, now)
      .run();
    return password;
  }

  async resetAdminPassword(now: number): Promise<string> {
    const password = generatePassword();
    const iterations = await this.iterations();
    const salt = randomBytes(16);
    const hash = await hashPassword(password, salt, iterations);
    await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE admin_users SET password_hash = ?1, password_salt = ?2, iterations = ?3,
             must_change = 1, password_changed_at = ?4 WHERE id = 1`,
        )
        .bind(hash, b64(salt), iterations, now),
      // Any session opened with the old password is no longer trustworthy.
      this.d1.prepare('DELETE FROM sessions'),
    ]);
    return password;
  }

  async verifyPassword(username: string, password: string): Promise<boolean> {
    const row = await this.d1.prepare('SELECT * FROM admin_users WHERE id = 1').first<Row>();
    if (row === null) return false;
    // Hash regardless of whether the username matched, so a wrong username is not
    // measurably faster to reject than a wrong password.
    const salt = unb64(str(row['password_salt']));
    const candidate = await hashPassword(password, salt, num(row['iterations']));
    const userOk = constantTimeEqual(str(row['username']), username);
    const passOk = constantTimeEqual(str(row['password_hash']), candidate);
    return userOk && passOk;
  }

  async setPassword(password: string, now: number, keepSession?: string): Promise<void> {
    const iterations = await this.iterations();
    const salt = randomBytes(16);
    const hash = await hashPassword(password, salt, iterations);
    const stmts = [
      this.d1
        .prepare(
          `UPDATE admin_users SET password_hash = ?1, password_salt = ?2, iterations = ?3,
             must_change = 0, password_changed_at = ?4 WHERE id = 1`,
        )
        .bind(hash, b64(salt), iterations, now),
    ];
    // Changing a password logs out every other device, which is the point of doing it.
    stmts.push(
      keepSession === undefined
        ? this.d1.prepare('DELETE FROM sessions')
        : this.d1.prepare('DELETE FROM sessions WHERE token_hash != ?1').bind(keepSession),
    );
    await this.d1.batch(stmts);
  }

  async setDisplayName(name: string): Promise<void> {
    await this.d1.prepare('UPDATE admin_users SET display_name = ?1 WHERE id = 1').bind(name).run();
  }

  async setUsername(username: string): Promise<void> {
    await this.d1.prepare('UPDATE admin_users SET username = ?1 WHERE id = 1').bind(username).run();
  }

  // --- sessions ------------------------------------------------------------

  async createSession(now: number, userAgent: string | null): Promise<string> {
    const token = randomToken(32);
    await this.d1
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
         VALUES (?1, 1, ?2, ?3, ?2, ?4)`,
      )
      .bind(await sha256Hex(token), now, now + SESSION_TTL_MS, userAgent?.slice(0, 200) ?? null)
      .run();
    await this.d1.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now).run();
    return token;
  }

  async validateSession(token: string, now: number): Promise<AdminUser | null> {
    const hash = await sha256Hex(token);
    const row = await this.d1
      .prepare('SELECT * FROM sessions WHERE token_hash = ?1 AND expires_at > ?2')
      .bind(hash, now)
      .first<Row>();
    if (row === null) return null;
    // Sliding expiry, written at most once an hour so a busy dashboard does not turn
    // every page view into a write.
    if (now - num(row['last_seen_at']) > 3600_000) {
      await this.d1
        .prepare('UPDATE sessions SET last_seen_at = ?2, expires_at = ?3 WHERE token_hash = ?1')
        .bind(hash, now, now + SESSION_TTL_MS)
        .run();
    }
    return this.getAdmin();
  }

  async sessionHash(token: string): Promise<string> {
    return sha256Hex(token);
  }

  async destroySession(token: string): Promise<void> {
    await this.d1.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
  }

  async destroyAllSessions(): Promise<void> {
    await this.d1.prepare('DELETE FROM sessions').run();
  }

  async activeSessions(now: number): Promise<Array<{ createdAt: number; lastSeenAt: number; userAgent: string | null }>> {
    const res = await this.d1
      .prepare('SELECT created_at, last_seen_at, user_agent FROM sessions WHERE expires_at > ?1 ORDER BY last_seen_at DESC')
      .bind(now)
      .all<Row>();
    return (res.results ?? []).map((r) => ({
      createdAt: num(r['created_at']),
      lastSeenAt: num(r['last_seen_at']),
      userAgent: strOrNull(r['user_agent']),
    }));
  }

  // --- login throttling ----------------------------------------------------

  async recordLoginAttempt(ok: boolean, ip: string | null, now: number): Promise<void> {
    await this.d1
      .prepare('INSERT INTO login_attempts (at, ok, ip) VALUES (?1, ?2, ?3)')
      .bind(now, ok ? 1 : 0, ip)
      .run();
    await this.d1.prepare('DELETE FROM login_attempts WHERE at < ?1').bind(now - 24 * 3600_000).run();
  }

  /**
   * The real defence against online guessing, given that the hash work factor is capped
   * by the Worker CPU budget.
   *
   * Counted per source address rather than globally, with a much looser global backstop.
   * A single global counter would let anyone lock the admin out of their own dashboard
   * indefinitely just by guessing wrong every few minutes -- trading a brute-force
   * defence for a denial-of-service hole.
   */
  async recentFailures(now: number, ip: string | null): Promise<{ fromIp: number; total: number }> {
    const since = now - 15 * 60_000;
    const [ipRes, allRes] = await this.d1.batch<Row>([
      this.d1
        .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND at > ?1 AND ip IS ?2')
        .bind(since, ip),
      this.d1.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND at > ?1').bind(since),
    ]);
    return {
      fromIp: num((ipRes?.results ?? [])[0]?.['n'] ?? 0),
      total: num((allRes?.results ?? [])[0]?.['n'] ?? 0),
    };
  }

  // --- invites -------------------------------------------------------------

  async createInvite(
    kind: 'enrol' | 'caregiver',
    opts: { patientId?: number; label?: string; escalateAfterMs?: number; createdBy: string; ttlMs: number },
    now: number,
  ): Promise<Invite> {
    const code = humanCode(8);
    const expiresAt = now + opts.ttlMs;
    await this.d1
      .prepare(
        `INSERT INTO invites (code, kind, patient_id, label, escalate_after_ms, created_at, created_by, expires_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
      )
      .bind(code, kind, opts.patientId ?? null, opts.label ?? null, opts.escalateAfterMs ?? null, now, opts.createdBy, expiresAt)
      .run();
    return {
      code, kind,
      patientId: opts.patientId ?? null,
      label: opts.label ?? null,
      escalateAfterMs: opts.escalateAfterMs ?? null,
      createdAt: now, createdBy: opts.createdBy, expiresAt,
      usedAt: null, usedByChat: null,
    };
  }

  /**
   * Claims an invite atomically. The single-use guarantee rides in the WHERE clause --
   * two people redeeming the same code at once would otherwise both succeed.
   */
  async redeemInvite(
    code: string,
    chatId: number,
    now: number,
    expect?: 'enrol' | 'caregiver',
  ): Promise<RedeemResult> {
    const normalised = code.trim().toUpperCase();
    const row = await this.d1.prepare('SELECT * FROM invites WHERE code = ?1').bind(normalised).first<Row>();
    if (row === null) return { ok: false, reason: 'unknown' };

    const invite = rowToInvite(row);
    if (invite.usedAt !== null) return { ok: false, invite, reason: 'used' };
    if (invite.expiresAt < now) return { ok: false, invite, reason: 'expired' };
    // Checked BEFORE the claim, so offering a caregiver code to /start does not burn it.
    // These codes are single use; consuming one on the wrong command would leave the
    // person holding a dead code and no idea why.
    if (expect !== undefined && invite.kind !== expect) {
      return { ok: false, invite, reason: 'wrong_kind' };
    }

    const res = await this.d1
      .prepare('UPDATE invites SET used_at = ?2, used_by_chat = ?3 WHERE code = ?1 AND used_at IS NULL AND expires_at >= ?2')
      .bind(normalised, now, chatId)
      .run();
    if (num(res.meta.changes) === 0) return { ok: false, invite, reason: 'used' };
    return { ok: true, invite };
  }

  /**
   * Read an invite without claiming it.
   *
   * Every reason to refuse a code has to be found before the claim, not after. These are
   * single use: consuming one and then rejecting it leaves the holder with something dead
   * and no explanation.
   */
  async peekInvite(code: string): Promise<Invite | null> {
    const row = await this.d1
      .prepare('SELECT * FROM invites WHERE code = ?1')
      .bind(code.trim().toUpperCase())
      .first<Row>();
    return row === null ? null : rowToInvite(row);
  }

  async liveInvites(now: number): Promise<Invite[]> {
    const res = await this.d1
      .prepare('SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ?1 ORDER BY created_at DESC')
      .bind(now)
      .all<Row>();
    return (res.results ?? []).map(rowToInvite);
  }

  async recentInvites(limit = 20): Promise<Invite[]> {
    const res = await this.d1
      .prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT ?1')
      .bind(limit)
      .all<Row>();
    return (res.results ?? []).map(rowToInvite);
  }

  async revokeInvite(code: string, now: number): Promise<void> {
    await this.d1
      .prepare('UPDATE invites SET expires_at = ?2 WHERE code = ?1 AND used_at IS NULL')
      .bind(code.toUpperCase(), now - 1)
      .run();
  }

  // --- read-only views over the family group -------------------------------

  async overview(now: number): Promise<{
    patients: Array<Patient & { chatCount: number; medCount: number }>;
    chatCount: number;
    heartbeat: { lastTickAt: number; ticksToday: number } | null;
  }> {
    const [patientsRes, chatRes, hbRes] = await this.d1.batch<Row>([
      this.d1.prepare(`
        SELECT p.*,
          (SELECT COUNT(*) FROM chats c WHERE c.patient_id = p.id AND c.active = 1) AS chat_count,
          (SELECT COUNT(*) FROM medications m WHERE m.patient_id = p.id AND m.status = 'active') AS med_count
        FROM patients p ORDER BY p.display_name`),
      this.d1.prepare('SELECT COUNT(DISTINCT chat_id) AS n FROM chats WHERE active = 1'),
      this.d1.prepare('SELECT * FROM heartbeat WHERE id = 1'),
    ]);
    void now;

    const hbRow = (hbRes?.results ?? [])[0];
    return {
      patients: (patientsRes?.results ?? []).map((r) => ({
        ...rowToPatientLite(r),
        chatCount: num(r['chat_count']),
        medCount: num(r['med_count']),
      })),
      chatCount: num((chatRes?.results ?? [])[0]?.['n'] ?? 0),
      heartbeat: hbRow === undefined ? null : { lastTickAt: num(hbRow['last_tick_at']), ticksToday: num(hbRow['ticks_today']) },
    };
  }

  /** Everything the dashboard shows for one person. Read-only, by design. */
  async patientDetail(patientId: number, today: string, sinceDay: string): Promise<{
    patient: Patient;
    meds: Medicine[];
    liveDoses: Dose[];
    chats: Array<{ chatId: number; displayName: string | null; role: string; tier: number; escalateAfterMs: number }>;
    adherence: Array<{ medId: number; status: string; n: number }>;
    recent: Dose[];
    prescriptionJson: string | null;
  } | null> {
    const [pRes, mRes, dRes, cRes, aRes, rRes, presRes] = await this.d1.batch<Row>([
      this.d1.prepare('SELECT * FROM patients WHERE id = ?1').bind(patientId),
      this.d1.prepare('SELECT * FROM medications WHERE patient_id = ?1 ORDER BY status, name').bind(patientId),
      this.d1
        .prepare("SELECT * FROM doses WHERE patient_id = ?1 AND status IN ('scheduled','deferred','due','prompted')")
        .bind(patientId),
      this.d1.prepare('SELECT * FROM chats WHERE patient_id = ?1 ORDER BY escalation_tier').bind(patientId),
      this.d1
        .prepare(
          `SELECT med_id, status, COUNT(*) AS n FROM doses
           WHERE patient_id = ?1 AND local_day >= ?2 AND status IN ('taken','missed','skipped')
           GROUP BY med_id, status`,
        )
        .bind(patientId, sinceDay),
      this.d1
        .prepare(
          `SELECT * FROM doses WHERE patient_id = ?1 AND status IN ('taken','missed','skipped')
           ORDER BY COALESCE(taken_at, resolved_at, planned_due_at) DESC LIMIT 40`,
        )
        .bind(patientId),
      this.d1
        .prepare("SELECT raw_json FROM prescription_versions WHERE patient_id = ?1 AND state = 'active' ORDER BY imported_at DESC LIMIT 1")
        .bind(patientId),
    ]);
    void today;

    const prow = (pRes?.results ?? [])[0];
    if (prow === undefined) return null;

    return {
      patient: rowToPatientLite(prow),
      meds: (mRes?.results ?? []).map(rowToMedLite),
      liveDoses: (dRes?.results ?? []).map(rowToDoseLite),
      chats: (cRes?.results ?? []).map((r) => ({
        chatId: num(r['chat_id']),
        displayName: strOrNull(r['display_name']),
        role: str(r['role']),
        tier: num(r['escalation_tier']),
        escalateAfterMs: num(r['escalate_after_ms']),
      })),
      adherence: (aRes?.results ?? []).map((r) => ({
        medId: num(r['med_id']), status: str(r['status']), n: num(r['n']),
      })),
      recent: (rRes?.results ?? []).map(rowToDoseLite),
      prescriptionJson: strOrNull((presRes?.results ?? [])[0]?.['raw_json']),
    };
  }

  /** Nodes and edges for the caregiver relationship graph. */
  async relationships(): Promise<{
    patients: Array<{ id: number; name: string }>;
    links: Array<{ chatId: number; patientId: number; displayName: string | null; role: string; tier: number; escalateAfterMs: number }>;
  }> {
    const [pRes, cRes] = await this.d1.batch<Row>([
      this.d1.prepare('SELECT id, display_name FROM patients ORDER BY display_name'),
      this.d1.prepare('SELECT * FROM chats WHERE active = 1'),
    ]);
    return {
      patients: (pRes?.results ?? []).map((r) => ({ id: num(r['id']), name: str(r['display_name']) })),
      links: (cRes?.results ?? []).map((r) => ({
        chatId: num(r['chat_id']),
        patientId: num(r['patient_id']),
        displayName: strOrNull(r['display_name']),
        role: str(r['role']),
        tier: num(r['escalation_tier']),
        escalateAfterMs: num(r['escalate_after_ms']),
      })),
    };
  }
}

function rowToInvite(r: Row): Invite {
  return {
    code: str(r['code']),
    kind: str(r['kind']) as Invite['kind'],
    patientId: numOrNull(r['patient_id']),
    label: strOrNull(r['label']),
    escalateAfterMs: numOrNull(r['escalate_after_ms']),
    createdAt: num(r['created_at']),
    createdBy: str(r['created_by']),
    expiresAt: num(r['expires_at']),
    usedAt: numOrNull(r['used_at']),
    usedByChat: numOrNull(r['used_by_chat']),
  };
}

function rowToPatientLite(r: Row): Patient {
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
    wakeAskAfter: numOrNull(r['wake_ask_after']),
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

function rowToMedLite(r: Row): Medicine {
  const parse = <T>(v: unknown, fb: T): T => {
    if (typeof v !== 'string') return fb;
    try { return JSON.parse(v) as T; } catch { return fb; }
  };
  return {
    id: num(r['id']),
    patientId: num(r['patient_id']),
    medKey: str(r['med_key']),
    name: str(r['name']),
    doseText: strOrNull(r['dose_text']),
    notes: strOrNull(r['notes']),
    kind: str(r['kind']) as Medicine['kind'],
    spec: parse(r['spec_json'], {} as Medicine['spec']),
    specHash: str(r['spec_hash']),
    steps: parse(r['steps_json'], [] as Medicine['steps']),
    stepSpacingMs: num(r['step_spacing_ms']),
    createdAt: numOrNull(r['created_at']),
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
    awakeOnly: num(r['awake_only']) !== 0,
    critical: num(r['critical']) !== 0,
    driftPolicy: str(r['drift_policy']) as Medicine['driftPolicy'],
    driftToleranceMs: num(r['drift_tolerance_ms']),
    catchupGraceMs: num(r['catchup_grace_ms']),
    nagPolicy: parse(r['nag_policy_json'], { stepsMs: [], escalateAfterMs: 0 }),
    mergeable: num(r['mergeable']) !== 0,
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

function rowToDoseLite(r: Row): Dose {
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
    status: str(r['status']) as Dose['status'],
    takenAt: numOrNull(r['taken_at']),
    resolvedAt: numOrNull(r['resolved_at']),
    resolvedByChat: numOrNull(r['resolved_by_chat']),
    resolutionSrc: strOrNull(r['resolution_src']) as Dose['resolutionSrc'],
    nagCount: num(r['nag_count']),
    firstPromptAt: numOrNull(r['first_prompt_at']),
    promptId: numOrNull(r['prompt_id']),
  };
}
