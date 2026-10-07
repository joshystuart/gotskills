export const MIGRATION_007_SQL = `
CREATE TABLE install_record_007 (
  target         TEXT    NOT NULL,
  folder_name    TEXT    NOT NULL,
  registry_id    TEXT    NOT NULL,
  content_hash   TEXT    NOT NULL,
  provenance_sha TEXT    NOT NULL,
  method         TEXT    NOT NULL CHECK (method IN ('symlink','copy')),
  paths          TEXT    NOT NULL DEFAULT '[]',
  cli_version    TEXT    NOT NULL,
  installed_at   TEXT    NOT NULL,
  PRIMARY KEY (target, folder_name)
);

INSERT INTO install_record_007
SELECT
  CASE target
    WHEN 'claude-code' THEN '~/.claude/skills'
    WHEN 'cursor' THEN '~/.agents/skills'
    ELSE target
  END,
  folder_name, registry_id, content_hash, provenance_sha, method, paths, cli_version, installed_at
FROM install_record;

DROP INDEX IF EXISTS idx_install_provenance;
DROP TABLE install_record;
ALTER TABLE install_record_007 RENAME TO install_record;
CREATE INDEX idx_install_provenance ON install_record (registry_id, folder_name);

CREATE TABLE telemetry_event_007 (
  event_id              TEXT    PRIMARY KEY,
  occurred_at_utc       TEXT    NOT NULL,
  installation_id       TEXT    NOT NULL,
  session_id            TEXT    NOT NULL,
  event_type            TEXT    NOT NULL
                        CHECK (event_type IN (
                          'session_started',
                          'sync_completed',
                          'install_requested',
                          'install_target_completed'
                        )),
  schema_version        INTEGER NOT NULL,
  app_version           TEXT    NOT NULL,
  operation_id          TEXT,
  skill_id              TEXT,
  commit_sha            TEXT,
  content_hash          TEXT,
  action                TEXT
                        CHECK (action IS NULL OR action IN ('install','update','remove')),
  target_app            TEXT,
  outcome               TEXT
                        CHECK (outcome IS NULL OR outcome IN ('success','failure','skipped')),
  duration_ms           INTEGER,
  error_category        TEXT
                        CHECK (error_category IS NULL OR error_category IN (
                          'link_failed','cli_failed','revision_mismatch','unknown'
                        )),
  registry_revision     TEXT,
  visible_skill_count   INTEGER,
  targets               TEXT
);

INSERT INTO telemetry_event_007
SELECT
  event_id, occurred_at_utc, installation_id, session_id, event_type, schema_version,
  app_version, operation_id, skill_id, commit_sha, content_hash, action,
  CASE target_app
    WHEN 'claude-code' THEN '~/.claude/skills'
    WHEN 'cursor' THEN '~/.agents/skills'
    ELSE target_app
  END,
  outcome, duration_ms, error_category, registry_revision, visible_skill_count,
  REPLACE(REPLACE(targets, '"claude-code"', '"~/.claude/skills"'), '"cursor"', '"~/.agents/skills"')
FROM telemetry_event;

DROP INDEX IF EXISTS idx_telemetry_occurred;
DROP INDEX IF EXISTS idx_telemetry_operation;
DROP INDEX IF EXISTS idx_telemetry_type;
DROP TABLE telemetry_event;
ALTER TABLE telemetry_event_007 RENAME TO telemetry_event;
CREATE INDEX idx_telemetry_occurred ON telemetry_event (occurred_at_utc);
CREATE INDEX idx_telemetry_operation ON telemetry_event (operation_id);
CREATE INDEX idx_telemetry_type ON telemetry_event (event_type);
`
