-- The admin dashboard: one account, single-use invites, and sessions.
--
-- The deployment is a family group. The admin account is the family organiser and can
-- read everyone's schedule; everybody else exists only in Telegram. Accounts are never
-- created from the web -- the only way in is an invite code redeemed through the bot.

-- Exactly one admin, enforced by the primary key check. Created during /setup with a
-- generated password that is shown once and never recoverable.
CREATE TABLE admin_users (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  username            TEXT    NOT NULL,
  display_name        TEXT    NOT NULL,
  -- PBKDF2-HMAC-SHA256. Parameters are stored per-row so they can be raised later
  -- without invalidating the existing password.
  password_hash       TEXT    NOT NULL,
  password_salt       TEXT    NOT NULL,
  iterations          INTEGER NOT NULL,
  must_change         INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  password_changed_at INTEGER,
  last_login_at       INTEGER
);

-- Only the SHA-256 of the cookie value is stored, so a copy of the database does not
-- hand over live sessions.
CREATE TABLE sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES admin_users(id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);

CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Single-use, expiring invitations. These replace the old fixed join code: one leaked
-- static password would otherwise let anyone into the family group forever.
CREATE TABLE invites (
  code              TEXT    PRIMARY KEY,
  kind              TEXT    NOT NULL CHECK (kind IN ('enrol','caregiver')),
  -- For a caregiver invite: which patient the redeemer will be linked to.
  patient_id        INTEGER REFERENCES patients(id),
  label             TEXT,
  escalate_after_ms INTEGER,
  created_at        INTEGER NOT NULL,
  created_by        TEXT    NOT NULL,
  expires_at        INTEGER NOT NULL,
  used_at           INTEGER,
  used_by_chat      INTEGER
);

CREATE INDEX idx_invites_live ON invites(expires_at) WHERE used_at IS NULL;

-- Login throttling. An online guessing attack is the realistic threat here, and this is
-- the defence that actually matters for it -- the work factor on the hash is capped by
-- the Worker CPU budget.
CREATE TABLE login_attempts (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  at   INTEGER NOT NULL,
  ok   INTEGER NOT NULL,
  ip   TEXT
);

CREATE INDEX idx_login_attempts_at ON login_attempts(at);
