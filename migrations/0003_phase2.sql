-- Phase 2: the durable send queue, the daily digest, and the liveness watchdog.

-- Outbound Telegram work, so a send that fails or runs out of subrequest budget is
-- retried on a later tick instead of being lost. Priority keeps a flood of cosmetic
-- messages from starving a real medicine reminder.
CREATE TABLE outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id   INTEGER,
  chat_id      INTEGER NOT NULL,
  method       TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  prompt_id    INTEGER,
  -- 0 = a critical medicine, 100 = an ordinary reminder, 200 = cosmetic.
  priority     INTEGER NOT NULL DEFAULT 100,
  -- Honours a 429 retry_after, and backs off after a failure.
  not_before   INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  dedupe_key   TEXT,
  state        TEXT    NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued','sent','failed','dropped')),
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_outbox_ready ON outbox(priority, not_before) WHERE state = 'queued';
-- One queued copy of any given logical message, so a retrying tick cannot double-send.
CREATE UNIQUE INDEX uq_outbox_dedupe ON outbox(dedupe_key) WHERE state = 'queued' AND dedupe_key IS NOT NULL;

-- The daily digest is the cheapest way for a human to notice the bot has stopped working
-- entirely. Recorded per local day so it fires once, whatever the tick cadence.
ALTER TABLE patients ADD COLUMN last_digest_day TEXT;

-- Per-medicine liveness. If a medicine has had no live dose for far longer than its own
-- cycle, something has gone wrong in a way no other check would catch.
ALTER TABLE patients ADD COLUMN last_watchdog_at INTEGER;
