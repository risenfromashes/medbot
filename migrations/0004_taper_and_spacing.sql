-- Two things a real post-operative eye prescription needs that the first design assumed
-- away.
--
-- 1. Drops that must be spaced apart but are NOT on the same schedule. The original model
--    folded a spacing group into one medicine with ordered steps, which forces every drop
--    onto one frequency. A real prescription had three drops -- one four times a day for
--    14 days, one four times a day for 7, and a lubricant every two hours indefinitely --
--    all needing 10 minutes between them. Folding them silently rewrote two of the three.
--
-- 2. Tapering courses. "4 times a day for 7 days, then 3 times a day for 7 days" is
--    routine in ophthalmology, and there was no way to say it at all: the second phase
--    simply vanished on import.

-- Spacing is now a constraint between independently-scheduled medicines, not a merge.
ALTER TABLE medications ADD COLUMN spacing_group TEXT;
ALTER TABLE medications ADD COLUMN spacing_ms INTEGER NOT NULL DEFAULT 0;

-- An ordered list of {schedule, days} phases. Null means a single-phase course, which is
-- still the common case.
ALTER TABLE medications ADD COLUMN phases_json TEXT;
ALTER TABLE medications ADD COLUMN phase_index INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_med_spacing ON medications(patient_id, spacing_group)
  WHERE spacing_group IS NOT NULL AND status = 'active';
