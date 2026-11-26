CREATE TABLE site_content_sources (
  site_address TEXT PRIMARY KEY REFERENCES sites(address) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  source_ref TEXT NOT NULL
);

CREATE TABLE site_content_drafts (
  site_address TEXT PRIMARY KEY REFERENCES sites(address) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  edits TEXT NOT NULL
);
