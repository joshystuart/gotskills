/** Migration 002 — append-only telemetry_event table (ticket 7 / decision 006). */
export const MIGRATION_002_SQL = `
CREATE TABLE telemetry_event (
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
  target_app            TEXT
                        CHECK (target_app IS NULL OR target_app IN ('claude-code','cursor')),
  outcome               TEXT
                        CHECK (outcome IS NULL OR outcome IN ('success','failure','skipped')),
  duration_ms           INTEGER,
  error_category        TEXT
                        CHECK (error_category IS NULL OR error_category IN (
                          'link_failed','cli_failed','revision_mismatch','unknown'
                        )),
  registry_revision     TEXT,
  visible_skill_count   INTEGER
);

CREATE INDEX idx_telemetry_occurred ON telemetry_event (occurred_at_utc);
CREATE INDEX idx_telemetry_operation ON telemetry_event (operation_id);
CREATE INDEX idx_telemetry_type ON telemetry_event (event_type);
`
