CREATE TABLE session_revocation_challenges (
  site_address TEXT PRIMARY KEY REFERENCES sites(address) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE site_media_uploads (
  id TEXT PRIMARY KEY,
  site_address TEXT NOT NULL REFERENCES sites(address) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'deleting'))
);

CREATE INDEX site_media_uploads_site_time ON site_media_uploads(site_address, created_at);
CREATE INDEX site_media_uploads_cleanup ON site_media_uploads(state, created_at);

CREATE UNIQUE INDEX site_unique_publish_target
  ON site_content_sources(repository, publish_ref) WHERE publish_ref IS NOT NULL;
