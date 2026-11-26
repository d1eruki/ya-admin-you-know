ALTER TABLE site_content_sources ADD COLUMN publish_ref TEXT;
ALTER TABLE site_content_drafts ADD COLUMN base_values TEXT NOT NULL DEFAULT '{}';

CREATE TABLE site_content_publications (
  id TEXT PRIMARY KEY,
  site_address TEXT NOT NULL REFERENCES sites(address) ON DELETE CASCADE,
  draft_revision INTEGER NOT NULL,
  repository TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  created_at INTEGER NOT NULL,
  workflow_run TEXT,
  message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX site_content_publications_latest ON site_content_publications (site_address, created_at DESC);
CREATE UNIQUE INDEX site_content_one_active_publication ON site_content_publications (site_address)
  WHERE status IN ('queued', 'running');
