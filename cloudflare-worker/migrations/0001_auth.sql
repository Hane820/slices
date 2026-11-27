-- 地球online Phase Auth：应用自有邮箱验证码 + Session 所需表
-- 使用 wrangler d1 migrations apply AUTH_DB 执行（需先在 wrangler.toml 绑定真实 D1）。
-- 只新增表，不改动/删除任何既有业务数据。

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  email_norm      TEXT NOT NULL UNIQUE,
  space_key       TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  email_verified_at INTEGER,
  last_login_at   INTEGER
);

CREATE TABLE IF NOT EXISTS email_codes (
  id            TEXT PRIMARY KEY,
  email_norm    TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER,
  ip_hash       TEXT
);
CREATE INDEX IF NOT EXISTS idx_codes_email ON email_codes(email_norm, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  token_hash          TEXT NOT NULL UNIQUE,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at          INTEGER,
  ua_hash             TEXT,
  ip_hash             TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
