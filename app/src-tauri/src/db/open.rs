use std::path::Path;

use rusqlite::Connection;

use super::migrations::{migrate_to, SCHEMA_VERSION};

fn configure_and_migrate(conn: Connection) -> rusqlite::Result<Connection> {
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    conn.execute_batch("PRAGMA foreign_keys = ON")?;
    migrate_to(&conn, SCHEMA_VERSION)?;
    Ok(conn)
}

/// Open (or create) the cache database at `path`, enabling WAL and foreign
/// keys and applying pending migrations. Existing files open unchanged.
pub fn open_database(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    configure_and_migrate(Connection::open(path)?)
}

/// A fully migrated in-memory database (tests).
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    configure_and_migrate(Connection::open_in_memory()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_settings::{get_auto_download_app_updates, set_auto_download_app_updates};
    use crate::db::migrations::{migrate_to, user_version, MIGRATIONS};
    use crate::registries::list_registries;
    use rusqlite::params;

    fn legacy(path: &Path, version: i64) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate_to(&conn, version).unwrap();
        conn
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn folder_status_migration_preserves_existing_markers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let previous = legacy(&path, 12);
        for status in ["never", "ok", "offline", "empty", "access_required"] {
            previous
                .execute(
                    "INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at)
                 VALUES (?1, 'https://example.test/skills', 'main', ?1, 'created', 'updated')",
                    [status],
                )
                .unwrap();
            previous
                .execute(
                    "INSERT INTO registry_sync_marker VALUES (?1, 'revision', 'synced-at', ?1, 1)",
                    [status],
                )
                .unwrap();
        }
        assert!(previous.execute("UPDATE registry_sync_marker SET last_sync_status = 'folder_not_found' WHERE registry_id = 'ok'", []).is_err());
        drop(previous);
        let db = open_database(&path).unwrap();
        for status in ["never", "ok", "offline", "empty", "access_required"] {
            let marker = crate::registries::get_marker(&db, status).unwrap().unwrap();
            assert_eq!(marker.status.encode(), status);
            assert_eq!(marker.last_sync_revision.as_deref(), Some("revision"));
            assert_eq!(marker.last_sync_at.as_deref(), Some("synced-at"));
            assert!(marker.stale);
        }
        for status in [
            crate::db::SyncMarkerStatus::FolderNotFound,
            crate::db::SyncMarkerStatus::FolderUnreadable,
            crate::db::SyncMarkerStatus::FolderChanged,
            crate::db::SyncMarkerStatus::SnapshotFailed,
        ] {
            crate::registries::record_marker_failure(&db, "ok", status).unwrap();
            assert_eq!(
                crate::registries::get_marker(&db, "ok")
                    .unwrap()
                    .unwrap()
                    .status,
                status
            );
        }
        assert_eq!(
            count(&db, "SELECT count(*) FROM pragma_foreign_key_check"),
            0
        );
    }

    #[test]
    fn upgrading_schema_10_drops_history_and_preserves_the_catalogue() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let previous = legacy(&path, 10);
        previous.execute_batch(
            "INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at)
             VALUES ('saved', 'https://example.test/saved', 'main', 'saved', '2026-01-01', '2026-01-01');
             INSERT INTO skill (registry_id, folder_name, name, description)
             VALUES ('saved', 'alpha', 'Alpha', 'Retained skill');
             INSERT INTO version (registry_id, folder_name, commit_sha, content_hash, committed_at)
             VALUES ('saved', 'alpha', 'sha', 'hash', '2026-01-01');"
        ).unwrap();
        drop(previous);
        let db = open_database(&path).unwrap();
        assert_eq!(
            count(
                &db,
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='version'"
            ),
            0
        );
        assert_eq!(
            count(&db, "SELECT count(*) FROM registry WHERE id='saved'"),
            1
        );
        let skill: (String, String) = db
            .query_row(
                "SELECT name, description FROM skill WHERE registry_id='saved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(skill, ("Alpha".into(), "Retained skill".into()));
    }

    #[test]
    fn fresh_database_has_the_final_schema_and_pragmas() {
        let dir = tempfile::tempdir().unwrap();
        let db = open_database(&dir.path().join("cache.sqlite")).unwrap();
        assert_eq!(user_version(&db).unwrap(), 14);
        assert_eq!(count(&db, "PRAGMA foreign_keys"), 1);
        let mode: String = db
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        for table in [
            "registry",
            "registry_sync_marker",
            "skill",
            "install_record",
            "telemetry_event",
            "app_setting",
        ] {
            let found = count(
                &db,
                &format!(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='{table}'"
                ),
            );
            assert_eq!(found, 1, "{table}");
        }
        db.execute(
            "INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at)
             VALUES ('r1', 'https://example.test/skills.git', 'main', 'git:example', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO skill (registry_id, folder_name, name, description) VALUES ('r1', 'alpha', 'Alpha', 'd')", [])
            .unwrap();
    }

    #[test]
    fn app_update_preference_persists_across_opens_defaulting_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let db = open_database(&path).unwrap();
        assert!(get_auto_download_app_updates(&db));
        set_auto_download_app_updates(&db, false).unwrap();
        drop(db);
        let reopened = open_database(&path).unwrap();
        assert!(!get_auto_download_app_updates(&reopened));
        set_auto_download_app_updates(&reopened, true).unwrap();
        assert!(get_auto_download_app_updates(&reopened));
    }

    #[test]
    fn opens_an_existing_version_7_wal_database_without_changing_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let previous = legacy(&path, 7);
        previous
            .execute_batch(
                "INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at)
                 VALUES ('saved', 'https://example.test/saved.git', 'main', 'saved', '2026-01-01', '2026-01-01');
                 INSERT INTO skill (registry_id, folder_name, name, description) VALUES ('saved', 'alpha', 'Alpha', 'Retained skill');
                 INSERT INTO install_record (target, folder_name, registry_id, content_hash, provenance_sha, method, paths, cli_version, installed_at)
                 VALUES ('~/.agents/skills', 'alpha', 'saved', 'hash', 'sha', 'copy', '[\"/saved\"]', '1.7.0', '2026-01-01');
                 INSERT INTO telemetry_event (event_id, occurred_at_utc, installation_id, session_id, event_type, schema_version, app_version)
                 VALUES ('saved-event', '2026-01-01', 'installation', 'session', 'session_started', 2, '0.0.5');",
            )
            .unwrap();
        drop(previous);
        let db = open_database(&path).unwrap();
        assert_eq!(user_version(&db).unwrap(), 14);
        let (branch, colour, name): (String, Option<String>, Option<String>) = db
            .query_row(
                "SELECT branch, colour, name FROM registry WHERE id = 'saved'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((branch.as_str(), colour, name), ("main", None, None));
        let target: String = db
            .query_row("SELECT target FROM install_record", [], |r| r.get(0))
            .unwrap();
        assert_eq!(target, "~/.agents/skills");
        assert_eq!(count(&db, "SELECT count(*) FROM telemetry_event"), 1);
        assert_eq!(count(&db, "SELECT count(*) FROM skill"), 1);
    }

    #[test]
    fn moves_schema_6_targets_to_install_target_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let previous = legacy(&path, 6);
        previous
            .execute_batch(
                "INSERT INTO install_record (target, folder_name, registry_id, content_hash, provenance_sha, method, paths, cli_version, installed_at)
                 VALUES ('claude-code', 'alpha', 'r1', 'h1', 's1', 'symlink', '[\"/a\"]', '1.7.0', '2026-01-01'),
                        ('cursor', 'alpha', 'r1', 'h2', 's2', 'copy', '[\"/b\"]', '1.7.0', '2026-01-02');
                 INSERT INTO telemetry_event (event_id, occurred_at_utc, installation_id, session_id, event_type, schema_version, app_version, action, targets, target_app, outcome)
                 VALUES ('e1', '2026-01-01', 'i', 's', 'install_requested', 2, '0.0.4', 'install', '[\"claude-code\",\"cursor\"]', NULL, NULL),
                        ('e2', '2026-01-01', 'i', 's', 'install_target_completed', 2, '0.0.4', 'install', NULL, 'cursor', 'success');",
            )
            .unwrap();
        drop(previous);
        let db = open_database(&path).unwrap();
        let mut stmt = db
            .prepare("SELECT target, method FROM install_record ORDER BY installed_at")
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            rows,
            vec![
                ("~/.claude/skills".into(), "symlink".into()),
                ("~/.agents/skills".into(), "copy".into())
            ]
        );
        let targets: String = db
            .query_row(
                "SELECT targets FROM telemetry_event WHERE event_id = 'e1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(targets, "[\"~/.claude/skills\",\"~/.agents/skills\"]");
        let app: String = db
            .query_row(
                "SELECT target_app FROM telemetry_event WHERE event_id = 'e2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(app, "~/.agents/skills");
    }

    #[test]
    fn preserves_registries_from_schema_5_with_auto_update_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let previous = legacy(&path, 5);
        previous
            .execute_batch(
                "INSERT INTO registry (id, url, branch, canonical_key, enabled, created_at, updated_at)
                 VALUES ('a', 'https://example.test/a', 'main', 'a', 1, '2026-01-01', '2026-01-01'),
                        ('b', 'https://example.test/b', 'dev', 'b', 0, '2026-01-01', '2026-01-01');",
            )
            .unwrap();
        drop(previous);
        let db = open_database(&path).unwrap();
        let listed = list_registries(&db, false).unwrap();
        let summary: Vec<_> = listed
            .iter()
            .map(|r| (r.id.as_str(), r.branch.as_str(), r.enabled, r.auto_update))
            .collect();
        assert_eq!(
            summary,
            vec![("a", "main", true, false), ("b", "dev", false, false)]
        );
    }

    #[test]
    fn opening_a_migrated_database_again_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let first = open_database(&path).unwrap();
        first
            .execute(
                "INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at)
                 VALUES ('r1', 'https://example.test/skills.git', 'main', 'git:example', '2026-01-01', '2026-01-01')",
                [],
            )
            .unwrap();
        drop(first);
        let second = open_database(&path).unwrap();
        assert_eq!(user_version(&second).unwrap(), 14);
        assert_eq!(
            count(&second, "SELECT count(*) FROM registry WHERE id = 'r1'"),
            1
        );
    }

    #[test]
    fn rebuilds_registry_scoped_tables_on_upgrade_while_preserving_telemetry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let v3 = legacy(&path, 3);
        v3.execute(
            "INSERT INTO skill (id, name, description) VALUES ('legacy', 'Legacy', 'old')",
            [],
        )
        .unwrap();
        v3.execute(
            "INSERT INTO telemetry_event (event_id, occurred_at_utc, installation_id, session_id, event_type, schema_version, app_version)
             VALUES ('event-a', '2026-07-10T12:06:00.000Z', 'install-a', 'session-a', 'session_started', 1, '0.0.1')",
            [],
        )
        .unwrap();
        drop(v3);
        let db = open_database(&path).unwrap();
        assert_eq!(user_version(&db).unwrap(), 14);
        let installation: String = db
            .query_row(
                "SELECT installation_id FROM telemetry_event WHERE event_id = 'event-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(installation, "install-a");
        let mut stmt = db.prepare("PRAGMA table_info(skill)").unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |r| r.get(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for expected in ["registry_id", "folder_name", "skill_path"] {
            assert!(columns.iter().any(|c| c == expected), "{expected}");
        }
    }

    #[test]
    fn rolls_back_a_failed_migration_and_its_version_advance_together() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let v1 = legacy(&path, 1);
        v1.execute(
            "INSERT INTO skill (id, name, description) VALUES ('keep', 'Keep', 'd')",
            [],
        )
        .unwrap();
        v1.execute_batch("CREATE INDEX idx_telemetry_occurred ON skill (name)")
            .unwrap();
        drop(v1);

        assert!(open_database(&path).is_err());

        let inspected = Connection::open(&path).unwrap();
        assert_eq!(user_version(&inspected).unwrap(), 1);
        assert_eq!(
            count(
                &inspected,
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='telemetry_event'"
            ),
            0
        );
        let name: String = inspected
            .query_row(
                "SELECT name FROM skill WHERE id = ?1",
                params!["keep"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "Keep");
    }

    #[test]
    fn migrations_are_numbered_contiguously() {
        let versions: Vec<i64> = MIGRATIONS.iter().map(|(v, _)| *v).collect();
        assert_eq!(versions, (1..=14).collect::<Vec<_>>());
    }
}
