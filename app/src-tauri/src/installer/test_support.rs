//! Shared fixtures for installer tests.

use std::fs;
use std::path::Path;

use rusqlite::Connection;

use crate::db::open_in_memory;

pub const REGISTRY: &str = "reg-a";

pub fn database() -> Connection {
    let conn = open_in_memory().unwrap();
    add_registry(&conn, REGISTRY, true, false);
    conn
}

pub fn add_registry(conn: &Connection, id: &str, enabled: bool, removed: bool) {
    conn.execute(
        "INSERT INTO registry (id, url, branch, enabled, canonical_key, removed_at, created_at, updated_at)
         VALUES (?1, ?2, 'main', ?3, ?1, ?4, 'now', 'now')",
        (id, format!("https://example.test/{id}"), enabled, removed.then_some("then")),
    )
    .unwrap();
}

pub fn add_skill(conn: &Connection, registry: &str, folder: &str, hash: &str, soft_deleted: bool) {
    conn.execute(
        "INSERT INTO skill (registry_id, folder_name, name, description, head_content_hash,
                            head_provenance_sha, soft_deleted, skill_path)
         VALUES (?1, ?2, ?2, 'd', ?3, ?4, ?5, ?6)",
        (
            registry,
            folder,
            hash,
            format!("sha-{hash}"),
            soft_deleted,
            format!("skills/{folder}"),
        ),
    )
    .unwrap();
}

pub fn write_mirror_skill(mirror: &Path, folder: &str, body: &str) {
    let dir = mirror.join("skills").join(folder);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), body).unwrap();
}
