CREATE TABLE sites (
  address TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE login_challenges (
  site_address TEXT PRIMARY KEY REFERENCES sites(address) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  site_address TEXT NOT NULL REFERENCES sites(address) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_by_expiry ON sessions (expires_at);

CREATE TABLE login_request_limits (
  client_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  requests INTEGER NOT NULL
);

CREATE INDEX login_limits_by_window ON login_request_limits (window_start);
