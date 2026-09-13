-- medbot initial schema.
--
-- Conventions:
--   * every instant is an INTEGER of epoch MILLISECONDS, UTC;
--   * every wall-clock time is TEXT 'HH:MM' interpreted in the patient's zone;
--   * every local day is TEXT 'YYYY-MM-DD' computed in the patient's zone;
--   * JSON columns hold structures the planner owns; hot fields are denormalised out
--     into real columns so an untouched medicine never has to be parsed.

-- ---------------------------------------------------------------------------
-- Patients and the chats linked to them
-- ---------------------------------------------------------------------------

CREATE TABLE patients (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name      TEXT    NOT NULL,
  tz                TEXT    NOT NULL DEFAULT 'UTC',

  morning_poll_at   TEXT    NOT NULL DEFAULT '07:00',
  -- The hard exit from not knowing. Past this local time we presume the patient is up
  -- and dose normally, whatever they have or have not told us. Without it, someone who
  -- leaves their phone charging receives nothing all day and the bot never notices.
  presumed_wake_at  TEXT    NOT NULL DEFAULT '09:30',
  evening_poll_at   TEXT    NOT NULL DEFAULT '22:00',
  presumed_sleep_at TEXT    NOT NULL DEFAULT '01:30',
  quiet_start       TEXT,
  quiet_end         TEXT,

  wake_state        TEXT    NOT NULL DEFAULT 'asleep'
                      CHECK (wake_state IN ('awake','asleep')),
  wake_confidence   TEXT    NOT NULL DEFAULT 'presumed'
                      CHECK (wake_confidence IN ('confirmed','inferred','presumed')),
  wake_state_since  INTEGER NOT NULL,
  last_wake_at      INTEGER,
  last_sleep_at     INTEGER,
  last_activity_at  INTEGER,

  local_day         TEXT,
  digest_at         TEXT    NOT NULL DEFAULT '21:00',
  paused_until      INTEGER,

  -- The entire timer wheel, in one column: the earliest instant the planner asked to be
  -- woken. An idle tick is one indexed range scan returning zero rows, which is what
  -- keeps CPU flat and D1 reads near zero as patients are added.
  next_action_at    INTEGER,

  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_patients_due ON patients(next_action_at) WHERE next_action_at IS NOT NULL;

CREATE TABLE chats (
  chat_id           INTEGER NOT NULL,
  patient_id        INTEGER NOT NULL REFERENCES patients(id),
  role              TEXT    NOT NULL DEFAULT 'patient'
                      CHECK (role IN ('patient','caregiver')),
  can_ack           INTEGER NOT NULL DEFAULT 1,
  -- 0 receives every prompt immediately. 1+ is only pulled in after a prompt has gone
  -- unanswered for escalate_after_ms, which is how a caregiver gets the safety net
  -- without the noise of every routine reminder.
  escalation_tier   INTEGER NOT NULL DEFAULT 0,
  escalate_after_ms INTEGER NOT NULL DEFAULT 300000,
  active            INTEGER NOT NULL DEFAULT 1,
  blocked_at        INTEGER,
  linked_at         INTEGER NOT NULL,
  PRIMARY KEY (chat_id, patient_id)
);

CREATE INDEX idx_chats_patient ON chats(patient_id) WHERE active = 1;
CREATE INDEX idx_chats_chat    ON chats(chat_id);

-- ---------------------------------------------------------------------------
-- Prescriptions and medicines
-- ---------------------------------------------------------------------------

CREATE TABLE prescription_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       INTEGER NOT NULL REFERENCES patients(id),
  raw_json         TEXT    NOT NULL,
  json_hash        TEXT    NOT NULL,
  state            TEXT    NOT NULL
                     CHECK (state IN ('pending_confirm','active','superseded','rejected')),
  diff_text        TEXT,
  imported_at      INTEGER NOT NULL,
  imported_by_chat INTEGER,
  activated_at     INTEGER
);

CREATE INDEX idx_pv_patient ON prescription_versions(patient_id, imported_at DESC);

CREATE TABLE medications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id         INTEGER NOT NULL REFERENCES patients(id),
  -- Stable identity across re-imports, so a corrected prescription preserves course
  -- progress instead of silently restarting a seven-day antibiotic on day five.
  med_key            TEXT    NOT NULL,
  name               TEXT    NOT NULL,
  dose_text          TEXT,
  notes              TEXT,

  kind               TEXT    NOT NULL
                       CHECK (kind IN ('interval','fixed_times','meal','as_needed')),
  spec_json          TEXT    NOT NULL,
  spec_hash          TEXT    NOT NULL,

  -- A medicine with more than one step IS the spacing group: three eye drops ten minutes
  -- apart are one medicine with three steps. The one-live-dose-per-medicine index below
  -- then guarantees only one of them is ever pending, and an unanswered first drop
  -- cannot strand the other two.
  steps_json         TEXT    NOT NULL DEFAULT '[]',
  step_spacing_ms    INTEGER NOT NULL DEFAULT 0,

  interval_ms        INTEGER,
  -- The hard safety floor between two doses. Never overridden by the wake anchor, a meal,
  -- a nudge, a retrospective correction or a re-import. This is the single check that
  -- stands between the scheduler and a double dose.
  min_gap_ms         INTEGER NOT NULL DEFAULT 0,
  onset_offset_ms    INTEGER NOT NULL DEFAULT 0,
  max_per_day        INTEGER,
  awake_only         INTEGER NOT NULL DEFAULT 1,
  critical           INTEGER NOT NULL DEFAULT 0,

  drift_policy       TEXT    NOT NULL DEFAULT 'absorb'
                       CHECK (drift_policy IN ('absorb','strict_actual','strict_grid')),
  drift_tolerance_ms INTEGER NOT NULL DEFAULT 1800000,
  catchup_grace_ms   INTEGER NOT NULL DEFAULT 3600000,
  nag_policy_json    TEXT    NOT NULL,
  mergeable          INTEGER NOT NULL DEFAULT 1,

  course_kind        TEXT    NOT NULL DEFAULT 'indefinite'
                       CHECK (course_kind IN ('days','doses','until','indefinite')),
  course_days        INTEGER,
  course_doses       INTEGER,
  course_until       INTEGER,
  started_at         INTEGER,
  doses_taken        INTEGER NOT NULL DEFAULT 0,
  doses_missed       INTEGER NOT NULL DEFAULT 0,

  last_taken_at      INTEGER,       -- last step of any cycle; anchors spacing + min gap
  last_cycle_start_at INTEGER,      -- step 0 of the last cycle; anchors the interval
  last_planned_due_at INTEGER,      -- where the grid wanted it; anchors drift absorption
  next_seq           INTEGER NOT NULL DEFAULT 1,
  -- Which step of the current cycle comes next. Resolving the last step rolls the
  -- cycle over to next_seq + 1, step 0.
  next_step          INTEGER NOT NULL DEFAULT 0,

  status             TEXT    NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','completed','discontinued','paused')),
  version_id         INTEGER REFERENCES prescription_versions(id),
  created_at         INTEGER NOT NULL,
  UNIQUE (patient_id, med_key)
);

CREATE INDEX idx_med_active ON medications(patient_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Doses
-- ---------------------------------------------------------------------------

CREATE TABLE doses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       INTEGER NOT NULL REFERENCES patients(id),
  med_id           INTEGER NOT NULL REFERENCES medications(id),
  seq              INTEGER NOT NULL,
  step             INTEGER NOT NULL DEFAULT 0,
  local_day        TEXT    NOT NULL,
  planned_due_at   INTEGER NOT NULL,
  effective_due_at INTEGER NOT NULL,
  anchor_kind      TEXT    NOT NULL,
  status           TEXT    NOT NULL
                     CHECK (status IN ('scheduled','deferred','due','prompted',
                                       'taken','skipped','missed','cancelled')),
  taken_at         INTEGER,
  resolved_at      INTEGER,
  resolved_by_chat INTEGER,
  resolution_src   TEXT,
  nag_count        INTEGER NOT NULL DEFAULT 0,
  first_prompt_at  INTEGER,
  prompt_id        INTEGER,
  created_at       INTEGER NOT NULL
);

-- The "missed doses never stack" requirement, as a database constraint rather than a rule
-- some code path has to remember. Two ticks racing, a duplicated cron delivery, or a bug
-- in the planner cannot produce three pending prompts for the same medicine.
CREATE UNIQUE INDEX uq_dose_live ON doses(med_id)
  WHERE status IN ('scheduled','deferred','due','prompted');

CREATE INDEX idx_doses_live ON doses(effective_due_at)
  WHERE status IN ('scheduled','deferred','due','prompted');
CREATE INDEX idx_doses_med_hist ON doses(med_id, planned_due_at DESC);
CREATE INDEX idx_doses_day      ON doses(patient_id, local_day);
CREATE INDEX idx_doses_taken    ON doses(med_id, taken_at) WHERE taken_at IS NOT NULL;

CREATE TABLE day_counters (
  patient_id INTEGER NOT NULL,
  med_id     INTEGER NOT NULL,
  local_day  TEXT    NOT NULL,
  taken      INTEGER NOT NULL DEFAULT 0,
  missed     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (patient_id, med_id, local_day)
);

-- ---------------------------------------------------------------------------
-- Wake and meals
-- ---------------------------------------------------------------------------

CREATE TABLE wake_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('wake','sleep')),
  at         INTEGER NOT NULL,
  local_day  TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  by_chat    INTEGER
);

CREATE INDEX idx_wake_patient ON wake_events(patient_id, at DESC);

CREATE TABLE meal_defs (
  patient_id       INTEGER NOT NULL,
  meal             TEXT    NOT NULL,
  -- "30 minutes before breakfast" cannot be scheduled off a confirmation: by the time
  -- /ate arrives the window has gone. Before-doses fire against this prediction instead.
  typical_local    TEXT    NOT NULL,
  ask_after_local  TEXT    NOT NULL,
  presume_at_local TEXT,
  PRIMARY KEY (patient_id, meal)
);

CREATE TABLE meal_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  meal       TEXT    NOT NULL,
  local_day  TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  source     TEXT    NOT NULL CHECK (source IN ('confirmed','presumed','skipped')),
  UNIQUE (patient_id, meal, local_day)
);

-- ---------------------------------------------------------------------------
-- Prompts and their fan-out
-- ---------------------------------------------------------------------------

CREATE TABLE prompts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES patients(id),
  kind           TEXT    NOT NULL CHECK (kind IN ('dose','wake','sleep','meal','info')),
  state          TEXT    NOT NULL CHECK (state IN ('open','resolved','expired','cancelled')),
  body_json      TEXT    NOT NULL,
  nudge_count    INTEGER NOT NULL DEFAULT 0,
  last_nudge_at  INTEGER,
  -- How far up the escalation ladder this prompt has already been sent.
  escalated_tier INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);

CREATE INDEX idx_prompts_open ON prompts(patient_id) WHERE state = 'open';

CREATE TABLE prompt_messages (
  prompt_id  INTEGER NOT NULL REFERENCES prompts(id),
  chat_id    INTEGER NOT NULL,
  message_id INTEGER,
  send_state TEXT    NOT NULL DEFAULT 'queued'
               CHECK (send_state IN ('queued','sent','failed','deleted')),
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (prompt_id, chat_id)
);

-- ---------------------------------------------------------------------------
-- Safety and diagnostics
-- ---------------------------------------------------------------------------

-- Telegram redelivers a webhook update whenever it does not get a prompt 200, including
-- on any cold start that runs long. Without this table a redelivered "taken" is counted
-- twice, which quietly ends a course early.
CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  seen_at   INTEGER NOT NULL
);

CREATE INDEX idx_pu_gc ON processed_updates(seen_at);

-- Append-only. This is a medical record: retrospective corrections write a new row
-- carrying both the original and the revised value, and nothing is ever overwritten.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER,
  at          INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  med_id      INTEGER,
  dose_id     INTEGER,
  actor       TEXT,
  detail_json TEXT
);

CREATE INDEX idx_audit_patient ON audit_log(patient_id, at DESC);

CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- One row. Lets /health and the daily digest notice that the cron has stopped firing --
-- the cheapest possible detector for "the bot silently died".
CREATE TABLE heartbeat (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_tick_at INTEGER NOT NULL,
  ticks_today  INTEGER NOT NULL DEFAULT 0,
  local_day    TEXT
);
