-- Meals adapt to the day, instead of being assumed.
--
-- The first design gave each meal a typical clock time and asked, after that time had
-- passed, whether it had happened. Two things wrong with that. It assumes breakfast is at
-- half past eight, which for someone on bed rest who woke at noon it is not. And it can
-- never schedule "half an hour before breakfast", because by the time you confirm you
-- have eaten, the window has gone.
--
-- So the bot asks *when* you are going to eat, and works backwards from the answer.

-- When to first ask about this meal, measured from waking rather than from the clock.
ALTER TABLE meal_defs ADD COLUMN after_wake_ms INTEGER;
-- And at least this long after the previous meal, so the questions do not bunch up.
ALTER TABLE meal_defs ADD COLUMN min_gap_after_prev_ms INTEGER NOT NULL DEFAULT 10800000;
-- Ordering, so "the previous meal" means something.
ALTER TABLE meal_defs ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

-- meal_events.source needs a 'planned' value, and SQLite cannot alter a CHECK, so the
-- table is rebuilt. It holds one row per meal per day, so this is cheap.
CREATE TABLE meal_events_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  meal       TEXT    NOT NULL,
  local_day  TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  source     TEXT    NOT NULL CHECK (source IN ('planned','confirmed','presumed','skipped')),
  -- When they said they would eat, kept alongside when they actually did, so a
  -- before-meal dose can be judged against the plan it was scheduled from.
  planned_at INTEGER,
  asked_at   INTEGER,
  UNIQUE (patient_id, meal, local_day)
);

INSERT INTO meal_events_new (id, patient_id, meal, local_day, at, source)
  SELECT id, patient_id, meal, local_day, at, source FROM meal_events;

DROP TABLE meal_events;
ALTER TABLE meal_events_new RENAME TO meal_events;
