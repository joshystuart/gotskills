use rusqlite::{named_params, Connection, OptionalExtension, Row};
use url::Url;
use uuid::Uuid;

use crate::db::{transaction, SyncMarkerStatus};
use crate::error::{AppError, AppResult};

/// In-memory shape of a Registry row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRegistry {
    pub id: String,
    pub url: String,
    pub branch: String,
    pub enabled: bool,
    pub auto_update: bool,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
    pub canonical_key: String,
    pub colour: Option<String>,
    pub name: Option<String>,
    pub removed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// In-memory shape of a per-Registry sync marker row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMarker {
    pub registry_id: String,
    pub last_sync_revision: Option<String>,
    pub last_sync_at: Option<String>,
    pub status: SyncMarkerStatus,
    pub stale: bool,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn stored_registry(row: &Row) -> rusqlite::Result<StoredRegistry> {
    Ok(StoredRegistry {
        id: row.get("id")?,
        url: row.get("url")?,
        branch: row.get("branch")?,
        enabled: row.get::<_, i64>("enabled")? == 1,
        auto_update: row.get::<_, i64>("auto_update")? == 1,
        github_owner: row.get("github_owner")?,
        github_repo: row.get("github_repo")?,
        canonical_key: row.get("canonical_key")?,
        colour: row.get("colour")?,
        name: row.get("name")?,
        removed_at: row.get("removed_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Active Registries by default (or all, with `include_removed`), oldest first.
pub fn list_registries(
    conn: &Connection,
    include_removed: bool,
) -> rusqlite::Result<Vec<StoredRegistry>> {
    let filter = if include_removed {
        ""
    } else {
        "WHERE removed_at IS NULL"
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT * FROM registry {filter} ORDER BY created_at ASC, rowid ASC"
    ))?;
    let rows = stmt.query_map([], stored_registry)?;
    rows.collect()
}

pub fn get_registry(conn: &Connection, id: &str) -> rusqlite::Result<Option<StoredRegistry>> {
    conn.query_row(
        "SELECT * FROM registry WHERE id = ?1",
        [id],
        stored_registry,
    )
    .optional()
}

/// Find an active Registry by canonical key (one per owner/repo).
pub fn find_by_canonical_key(
    conn: &Connection,
    canonical_key: &str,
) -> rusqlite::Result<Option<StoredRegistry>> {
    conn.query_row(
        "SELECT * FROM registry WHERE canonical_key = ?1 AND removed_at IS NULL",
        [canonical_key],
        stored_registry,
    )
    .optional()
}

#[derive(Debug, Clone)]
pub struct InsertRegistryInput {
    pub url: String,
    pub branch: String,
    pub enabled: bool,
    pub auto_update: bool,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
    pub canonical_key: String,
}

/// Insert a Registry and its `never` sync marker in one transaction.
pub fn insert_registry(
    conn: &Connection,
    input: &InsertRegistryInput,
) -> AppResult<StoredRegistry> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    transaction(conn, || -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO registry
               (id, url, branch, enabled, auto_update, github_owner, github_repo, canonical_key, removed_at, created_at, updated_at)
             VALUES (:id, :url, :branch, :enabled, :auto_update, :github_owner, :github_repo, :canonical_key, NULL, :now, :now)",
            named_params! {
                ":id": id,
                ":url": input.url,
                ":branch": input.branch,
                ":enabled": input.enabled as i64,
                ":auto_update": input.auto_update as i64,
                ":github_owner": input.github_owner,
                ":github_repo": input.github_repo,
                ":canonical_key": input.canonical_key,
                ":now": timestamp,
            },
        )?;
        conn.execute(
            "INSERT INTO registry_sync_marker (registry_id, last_sync_status, stale) VALUES (?1, 'never', 0)",
            [&id],
        )?;
        Ok(())
    })?;
    get_registry(conn, &id)?
        .ok_or_else(|| AppError::not_found(format!("Registry \"{id}\" not found")))
}

/// Fields to change; `None` leaves a column alone. For nullable columns the
/// inner `Option` sets or clears the value.
#[derive(Debug, Clone, Default)]
pub struct UpdateRegistryFields {
    pub url: Option<String>,
    pub branch: Option<String>,
    pub enabled: Option<bool>,
    pub auto_update: Option<bool>,
    pub github_owner: Option<Option<String>>,
    pub github_repo: Option<Option<String>>,
    pub canonical_key: Option<String>,
    pub colour: Option<String>,
    pub name: Option<Option<String>>,
}

pub fn update_registry(
    conn: &Connection,
    id: &str,
    fields: UpdateRegistryFields,
) -> AppResult<StoredRegistry> {
    let current = get_registry(conn, id)?
        .ok_or_else(|| AppError::not_found(format!("Registry \"{id}\" not found")))?;
    let next = StoredRegistry {
        url: fields.url.unwrap_or(current.url.clone()),
        branch: fields.branch.unwrap_or(current.branch.clone()),
        enabled: fields.enabled.unwrap_or(current.enabled),
        auto_update: fields.auto_update.unwrap_or(current.auto_update),
        github_owner: fields.github_owner.unwrap_or(current.github_owner.clone()),
        github_repo: fields.github_repo.unwrap_or(current.github_repo.clone()),
        canonical_key: fields
            .canonical_key
            .unwrap_or(current.canonical_key.clone()),
        colour: fields.colour.or(current.colour.clone()),
        name: fields.name.unwrap_or(current.name.clone()),
        updated_at: now(),
        ..current
    };
    conn.execute(
        "UPDATE registry SET
           url = :url, branch = :branch, enabled = :enabled, auto_update = :auto_update,
           github_owner = :github_owner, github_repo = :github_repo,
           canonical_key = :canonical_key, colour = :colour, name = :name, updated_at = :updated_at
         WHERE id = :id",
        named_params! {
            ":id": id,
            ":url": next.url,
            ":branch": next.branch,
            ":enabled": next.enabled as i64,
            ":auto_update": next.auto_update as i64,
            ":github_owner": next.github_owner,
            ":github_repo": next.github_repo,
            ":canonical_key": next.canonical_key,
            ":colour": next.colour,
            ":name": next.name,
            ":updated_at": next.updated_at,
        },
    )?;
    Ok(next)
}

/// Soft-remove: keep config, snapshot and mirror; hide from Settings/available.
pub fn soft_remove_registry(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let timestamp = now();
    conn.execute(
        "UPDATE registry SET removed_at = ?1, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![timestamp, id],
    )?;
    Ok(())
}

/// Hard-delete a Registry and its skills, versions and marker (cascade).
pub fn hard_delete_registry(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM registry WHERE id = ?1", [id])?;
    Ok(())
}

/// Registry Name: the friendly name when set, else the automatic name.
pub fn registry_label(registry: &StoredRegistry) -> String {
    registry
        .name
        .clone()
        .unwrap_or_else(|| automatic_registry_name(registry))
}

/// Automatic name: `owner/repo` for GitHub, else `host/path`.
pub fn automatic_registry_name(registry: &StoredRegistry) -> String {
    automatic_name(
        registry.github_owner.as_deref(),
        registry.github_repo.as_deref(),
        &registry.url,
    )
}

/// [`automatic_registry_name`] from raw parts.
pub fn automatic_name(github_owner: Option<&str>, github_repo: Option<&str>, url: &str) -> String {
    if let (Some(owner), Some(repo)) = (github_owner, github_repo) {
        if !owner.is_empty() && !repo.is_empty() {
            return format!("{owner}/{repo}");
        }
    }
    match Url::parse(url) {
        Ok(parsed) if parsed.host_str().is_some() => {
            let host = match parsed.port() {
                Some(port) => format!("{}:{port}", parsed.host_str().unwrap_or("")),
                None => parsed.host_str().unwrap_or("").to_string(),
            };
            format!("{host}{}", parsed.path().trim_end_matches('/'))
        }
        _ => url.to_string(),
    }
}

pub fn get_marker(conn: &Connection, registry_id: &str) -> AppResult<Option<StoredMarker>> {
    let row = conn
        .query_row(
            "SELECT registry_id, last_sync_revision, last_sync_at, last_sync_status, stale
             FROM registry_sync_marker WHERE registry_id = ?1",
            [registry_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(registry_id, last_sync_revision, last_sync_at, status, stale)| {
            Ok(StoredMarker {
                registry_id,
                last_sync_revision,
                last_sync_at,
                status: SyncMarkerStatus::decode(&status)
                    .map_err(|e| AppError::failed(e.to_string()))?,
                stale: stale == 1,
            })
        },
    )
    .transpose()
}

/// Record a successful sync (`Ok` or `Empty`) and clear the stale flag.
pub fn upsert_marker_success(
    conn: &Connection,
    registry_id: &str,
    revision: &str,
    at: &str,
    status: SyncMarkerStatus,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO registry_sync_marker (registry_id, last_sync_revision, last_sync_at, last_sync_status, stale)
         VALUES (:registry_id, :revision, :at, :status, 0)
         ON CONFLICT(registry_id) DO UPDATE SET
           last_sync_revision = excluded.last_sync_revision,
           last_sync_at = excluded.last_sync_at,
           last_sync_status = excluded.last_sync_status,
           stale = 0",
        named_params! {
            ":registry_id": registry_id,
            ":revision": revision,
            ":at": at,
            ":status": status.encode(),
        },
    )?;
    Ok(())
}

/// Record a failed sync without clearing the last-good marker; flags the
/// retained snapshot stale.
pub fn record_marker_failure(
    conn: &Connection,
    registry_id: &str,
    status: SyncMarkerStatus,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO registry_sync_marker (registry_id, last_sync_status, stale)
         VALUES (:registry_id, :status, 1)
         ON CONFLICT(registry_id) DO UPDATE SET
           last_sync_status = excluded.last_sync_status,
           stale = 1",
        named_params! { ":registry_id": registry_id, ":status": status.encode() },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn input(key: &str) -> InsertRegistryInput {
        InsertRegistryInput {
            url: format!("https://github.com/o/{key}"),
            branch: "main".into(),
            enabled: true,
            auto_update: false,
            github_owner: Some("o".into()),
            github_repo: Some(key.into()),
            canonical_key: format!("github:o/{key}"),
        }
    }

    #[test]
    fn insert_creates_a_never_marker_and_lists_oldest_first() {
        let db = open_in_memory().unwrap();
        let a = insert_registry(&db, &input("a")).unwrap();
        let b = insert_registry(&db, &input("b")).unwrap();
        let ids: Vec<_> = list_registries(&db, false)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec![a.id.clone(), b.id]);
        let marker = get_marker(&db, &a.id).unwrap().unwrap();
        assert_eq!(marker.status, SyncMarkerStatus::Never);
        assert!(!marker.stale);
    }

    #[test]
    fn canonical_key_is_unique_among_active_registries_only() {
        let db = open_in_memory().unwrap();
        let first = insert_registry(&db, &input("a")).unwrap();
        assert!(insert_registry(&db, &input("a")).is_err());
        soft_remove_registry(&db, &first.id).unwrap();
        assert!(find_by_canonical_key(&db, "github:o/a").unwrap().is_none());
        assert!(insert_registry(&db, &input("a")).is_ok());
        assert_eq!(list_registries(&db, true).unwrap().len(), 2);
        assert_eq!(list_registries(&db, false).unwrap().len(), 1);
    }

    #[test]
    fn update_changes_only_given_fields_and_can_clear_the_name() {
        let db = open_in_memory().unwrap();
        let r = insert_registry(&db, &input("a")).unwrap();
        let updated = update_registry(
            &db,
            &r.id,
            UpdateRegistryFields {
                branch: Some("dev".into()),
                colour: Some("#aabbcc".into()),
                name: Some(Some("Friendly".into())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            (updated.branch.as_str(), updated.url.as_str()),
            ("dev", "https://github.com/o/a")
        );
        assert_eq!(registry_label(&updated), "Friendly");
        let cleared = update_registry(
            &db,
            &r.id,
            UpdateRegistryFields {
                name: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(registry_label(&cleared), "o/a");
        assert_eq!(
            get_registry(&db, &r.id).unwrap().unwrap().colour.as_deref(),
            Some("#aabbcc")
        );
        assert!(update_registry(&db, "missing", UpdateRegistryFields::default()).is_err());
    }

    #[test]
    fn hard_delete_cascades_to_the_marker() {
        let db = open_in_memory().unwrap();
        let r = insert_registry(&db, &input("a")).unwrap();
        hard_delete_registry(&db, &r.id).unwrap();
        assert!(get_registry(&db, &r.id).unwrap().is_none());
        assert!(get_marker(&db, &r.id).unwrap().is_none());
    }

    #[test]
    fn automatic_name_falls_back_to_host_and_path_then_raw_url() {
        assert_eq!(
            automatic_name(None, None, "https://git.example.com/team/skills/"),
            "git.example.com/team/skills"
        );
        assert_eq!(automatic_name(None, None, "/tmp/local"), "/tmp/local");
        assert_eq!(automatic_name(Some("o"), Some("r"), "ignored"), "o/r");
    }

    #[test]
    fn marker_success_then_failure_keeps_revision_and_marks_stale() {
        let db = open_in_memory().unwrap();
        let r = insert_registry(&db, &input("a")).unwrap();
        upsert_marker_success(
            &db,
            &r.id,
            "abc",
            "2026-01-01T00:00:00.000Z",
            SyncMarkerStatus::Ok,
        )
        .unwrap();
        record_marker_failure(&db, &r.id, SyncMarkerStatus::AccessRequired).unwrap();
        let marker = get_marker(&db, &r.id).unwrap().unwrap();
        assert_eq!(marker.status, SyncMarkerStatus::AccessRequired);
        assert_eq!(marker.last_sync_revision.as_deref(), Some("abc"));
        assert!(marker.stale);
        let raw: String = db
            .query_row(
                "SELECT last_sync_status FROM registry_sync_marker WHERE registry_id = ?1",
                [&r.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw, "access_required");
        upsert_marker_success(
            &db,
            &r.id,
            "def",
            "2026-01-02T00:00:00.000Z",
            SyncMarkerStatus::Ok,
        )
        .unwrap();
        assert!(!get_marker(&db, &r.id).unwrap().unwrap().stale);
    }
}
