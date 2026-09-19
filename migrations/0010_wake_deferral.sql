-- "Ask me again in an hour" needs somewhere of its own to live.
--
-- It was being stored in expected_wake_at, which the planner also writes as its own
-- *prediction* of when someone will be up. Two different meanings in one column: a
-- prediction must not stop the bot asking when someone stirs, and an instruction must.
-- Worse, the deferral was enforced by parking patients.next_action_at an hour ahead,
-- which silenced that patient's medicine reminders for the hour as well.
ALTER TABLE patients ADD COLUMN wake_ask_after INTEGER;
