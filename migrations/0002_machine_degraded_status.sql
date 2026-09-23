PRAGMA foreign_keys = OFF;

CREATE TABLE machines_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  connector_version TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'degraded', 'unknown')),
  UNIQUE(project_id, name)
);

INSERT INTO machines_v2 (id, project_id, name, platform, connector_version, created_at, last_seen_at, status)
SELECT id, project_id, name, platform, connector_version, created_at, last_seen_at, status FROM machines;

DROP TABLE machines;
ALTER TABLE machines_v2 RENAME TO machines;

CREATE INDEX IF NOT EXISTS idx_machines_project ON machines(project_id);
PRAGMA foreign_keys = ON;
