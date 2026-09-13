-- Sleep has a minimum length.
--
-- Without one, going to bed at five in the morning meant the 06:30 "are you awake?" poll
-- fired after seventy minutes, and the 09:00 fallback started the whole day's dosing
-- after under four hours. Worse, any message sent after saying goodnight counted as
-- proof of being up: a patient who tapped /sleep and then sent one more line had their
-- day started a minute later, medicines scheduled, and two of them marked taken.
ALTER TABLE patients ADD COLUMN min_sleep_ms INTEGER NOT NULL DEFAULT 14400000;
