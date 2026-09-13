-- Explicit order within a spacing group, when the prescription gives one.
--
-- Its own migration rather than an edit to 0004, which has already run: a changed
-- migration is one that never applies anywhere it has been seen before, so the column
-- would simply be missing on every existing deployment.
--
-- Order matters beyond tidiness here. The patient learns a sequence -- this drop, wait,
-- that drop -- and a sequence that reshuffles itself is one they will get wrong.
ALTER TABLE medications ADD COLUMN group_seq INTEGER;
