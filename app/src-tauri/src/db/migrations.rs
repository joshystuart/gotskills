use rusqlite::Connection;

use super::transaction::transaction;

/// Numbered migrations applied in order via `PRAGMA user_version`.
pub const MIGRATIONS: [(i64, &str); 11] = [
    (1, include_str!("migrations/001_schema.sql")),
    (2, include_str!("migrations/002_telemetry.sql")),
    (3, include_str!("migrations/003_telemetry_targets.sql")),
    (4, include_str!("migrations/004_multi_registry.sql")),
    (5, include_str!("migrations/005_skill_path.sql")),
    (6, include_str!("migrations/006_registry_auto_update.sql")),
    (7, include_str!("migrations/007_install_target_ids.sql")),
    (8, include_str!("migrations/008_app_setting.sql")),
    (9, include_str!("migrations/009_registry_colour.sql")),
    (10, include_str!("migrations/010_registry_name.sql")),
    (11, include_str!("migrations/011_drop_version.sql")),
];

/// The schema version of a fully migrated database.
pub const SCHEMA_VERSION: i64 = 11;

/// The stored `user_version`.
pub fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

/// Apply every migration newer than the stored version, up to and including
/// `target`. Each step and its version bump commit or roll back together.
pub fn migrate_to(conn: &Connection, target: i64) -> rusqlite::Result<()> {
    let current = user_version(conn)?;
    for (version, sql) in MIGRATIONS {
        if current >= version || version > target {
            continue;
        }
        transaction(conn, || {
            conn.execute_batch(sql)?;
            conn.execute_batch(&format!("PRAGMA user_version = {version}"))
        })?;
    }
    Ok(())
}
