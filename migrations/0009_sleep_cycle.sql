-- The sleep/wake cycle stops being a clock and becomes a conversation.
--
-- The configured morning and evening times were treated as facts: the bot decided someone
-- was asleep at 01:00 because 01:00 had arrived, and awake at 09:00 for the same reason.
-- They are only a reference for where to start asking. What the bot actually needs is an
-- *expected* bedtime it can negotiate ("still turning in at one? +1 hour?") and an
-- expected wake time it keeps checking rather than assuming.
ALTER TABLE patients ADD COLUMN expected_sleep_at INTEGER;
ALTER TABLE patients ADD COLUMN expected_wake_at INTEGER;
ALTER TABLE patients ADD COLUMN last_wake_check_at INTEGER;

-- How far ahead of the expected bedtime the two "still turning in?" prompts go out.
ALTER TABLE patients ADD COLUMN bed_lead_first_ms INTEGER NOT NULL DEFAULT 3600000;
ALTER TABLE patients ADD COLUMN bed_lead_second_ms INTEGER NOT NULL DEFAULT 1800000;
-- How long outstanding reminders keep going after the expected bedtime.
ALTER TABLE patients ADD COLUMN post_bed_grace_ms INTEGER NOT NULL DEFAULT 3600000;
-- How often to ask whether they are up, once the minimum sleep has elapsed.
ALTER TABLE patients ADD COLUMN wake_check_every_ms INTEGER NOT NULL DEFAULT 3600000;

