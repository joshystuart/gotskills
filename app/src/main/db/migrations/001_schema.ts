/** Migration 001 — accepted local cache schema (ticket 011). */
export const MIGRATION_001_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE sync_marker (
  url                 TEXT    NOT NULL,
  branch              TEXT    NOT NULL,
  last_sync_revision  TEXT,
  last_sync_at        TEXT,
  last_sync_status    TEXT    NOT NULL DEFAULT 'never'
                      CHECK (last_sync_status IN ('never','ok','offline','empty','auth_required')),
  PRIMARY KEY (url, branch)
);

CREATE TABLE skill (
  id                    TEXT    PRIMARY KEY,
  name                  TEXT    NOT NULL,
  description           TEXT    NOT NULL,
  head_content_hash     TEXT,
  head_provenance_sha   TEXT,
  head_updated_at       TEXT,
  soft_deleted          INTEGER NOT NULL DEFAULT 0
                        CHECK (soft_deleted IN (0,1)),
  last_seen_revision    TEXT,
  last_seen_at          TEXT
);

CREATE INDEX idx_skill_active ON skill (soft_deleted);

CREATE TABLE version (
  skill_id      TEXT    NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  commit_sha    TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  committed_at  TEXT    NOT NULL,
  PRIMARY KEY (skill_id, commit_sha)
);

CREATE INDEX idx_version_skill_date ON version (skill_id, committed_at DESC);

CREATE TABLE install_record (
  skill_id       TEXT    NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  target         TEXT    NOT NULL CHECK (target IN ('claude-code','cursor')),
  content_hash   TEXT    NOT NULL,
  provenance_sha TEXT    NOT NULL,
  method         TEXT    NOT NULL CHECK (method IN ('symlink','copy')),
  paths          TEXT    NOT NULL DEFAULT '[]',
  cli_version    TEXT    NOT NULL,
  installed_at   TEXT    NOT NULL,
  PRIMARY KEY (skill_id, target)
);

CREATE INDEX idx_install_target ON install_record (target);
`
