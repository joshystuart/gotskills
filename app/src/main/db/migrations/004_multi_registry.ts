/**
 * Migration 004 — rebuild the cache schema for multiple Registries (ADR 0001).
 *
 * Skill identity is now (registry_id, folder_name); installation occupancy is
 * (target, folder_name) with the supplying Registry kept only as provenance.
 * There is no pre-v1 data to preserve, so the single-registry tables are
 * dropped and recreated. Telemetry (002/003) is untouched.
 */
export const MIGRATION_004_SQL = `
PRAGMA foreign_keys = ON;

DROP INDEX IF EXISTS idx_install_target;
DROP INDEX IF EXISTS idx_version_skill_date;
DROP INDEX IF EXISTS idx_skill_active;
DROP TABLE IF EXISTS install_record;
DROP TABLE IF EXISTS version;
DROP TABLE IF EXISTS skill;
DROP TABLE IF EXISTS sync_marker;

CREATE TABLE registry (
  id             TEXT    PRIMARY KEY,
  url            TEXT    NOT NULL,
  branch         TEXT    NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  github_owner   TEXT,
  github_repo    TEXT,
  canonical_key  TEXT    NOT NULL,
  removed_at     TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- Only active Registries compete for a GitHub owner/repo. Soft-removed rows
-- may keep their canonical_key while Orphaned Installations still depend on
-- them, so a later re-add of the same repo must be allowed.
CREATE UNIQUE INDEX idx_registry_canonical ON registry (canonical_key)
  WHERE removed_at IS NULL;

CREATE TABLE registry_sync_marker (
  registry_id         TEXT    PRIMARY KEY REFERENCES registry(id) ON DELETE CASCADE,
  last_sync_revision  TEXT,
  last_sync_at        TEXT,
  last_sync_status    TEXT    NOT NULL DEFAULT 'never'
                      CHECK (last_sync_status IN ('never','ok','offline','empty','access_required')),
  stale               INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1))
);

CREATE TABLE skill (
  registry_id           TEXT    NOT NULL REFERENCES registry(id) ON DELETE CASCADE,
  folder_name           TEXT    NOT NULL,
  name                  TEXT    NOT NULL,
  description           TEXT    NOT NULL,
  head_content_hash     TEXT,
  head_provenance_sha   TEXT,
  head_updated_at       TEXT,
  soft_deleted          INTEGER NOT NULL DEFAULT 0
                        CHECK (soft_deleted IN (0,1)),
  last_seen_revision    TEXT,
  last_seen_at          TEXT,
  PRIMARY KEY (registry_id, folder_name)
);

CREATE INDEX idx_skill_active ON skill (soft_deleted);

CREATE TABLE version (
  registry_id   TEXT    NOT NULL,
  folder_name   TEXT    NOT NULL,
  commit_sha    TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  committed_at  TEXT    NOT NULL,
  PRIMARY KEY (registry_id, folder_name, commit_sha),
  FOREIGN KEY (registry_id, folder_name)
    REFERENCES skill(registry_id, folder_name) ON DELETE CASCADE
);

CREATE INDEX idx_version_skill_date ON version (registry_id, folder_name, committed_at DESC);

-- Occupancy is (target, folder_name): only one Skill can occupy an agent folder.
-- Provenance (registry_id) is recorded but intentionally has no FK so an install
-- survives its Registry being removed (Orphaned Installation).
CREATE TABLE install_record (
  target         TEXT    NOT NULL CHECK (target IN ('claude-code','cursor')),
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

CREATE INDEX idx_install_provenance ON install_record (registry_id, folder_name);
`
