//! `install_record` persistence.

use rusqlite::{named_params, Connection, Row};

use crate::error::{AppError, AppResult};
use crate::types::{InstallMethod, InstallRecord};

const COLUMNS: &str =
    "target, folder_name, registry_id, content_hash, provenance_sha, method, paths, cli_version, installed_at";

fn method_text(method: InstallMethod) -> &'static str {
    match method {
        InstallMethod::Symlink => "symlink",
        InstallMethod::Copy => "copy",
    }
}

fn parse_method(text: &str) -> AppResult<InstallMethod> {
    match text {
        "symlink" => Ok(InstallMethod::Symlink),
        "copy" => Ok(InstallMethod::Copy),
        other => Err(AppError::failed(format!("unknown install method {other}"))),
    }
}

fn read_row(row: &Row<'_>) -> rusqlite::Result<(InstallRecord, String, String)> {
    let method: String = row.get("method")?;
    let paths: String = row.get("paths")?;
    let record = InstallRecord {
        registry_id: row.get("registry_id")?,
        folder_name: row.get("folder_name")?,
        target: row.get("target")?,
        content_hash: row.get("content_hash")?,
        provenance_sha: row.get("provenance_sha")?,
        method: InstallMethod::Copy,
        paths: Vec::new(),
        cli_version: row.get("cli_version")?,
        installed_at: row.get("installed_at")?,
    };
    Ok((record, method, paths))
}

/// Persist an install occupancy row. The primary key is `(target, folder_name)`;
/// the supplying Registry is stored as provenance so a later Registry removal
/// can leave the install in place as an Orphaned Installation.
pub fn upsert_install_record(conn: &Connection, record: &InstallRecord) -> AppResult<()> {
    conn.execute(
        "INSERT INTO install_record (
           target, folder_name, registry_id, content_hash, provenance_sha, method, paths, cli_version, installed_at
         ) VALUES (
           :target, :folder_name, :registry_id, :content_hash, :provenance_sha, :method, :paths, :cli_version, :installed_at
         )
         ON CONFLICT(target, folder_name) DO UPDATE SET
           registry_id = excluded.registry_id,
           content_hash = excluded.content_hash,
           provenance_sha = excluded.provenance_sha,
           method = excluded.method,
           paths = excluded.paths,
           cli_version = excluded.cli_version,
           installed_at = excluded.installed_at",
        named_params! {
            ":target": record.target,
            ":folder_name": record.folder_name,
            ":registry_id": record.registry_id,
            ":content_hash": record.content_hash,
            ":provenance_sha": record.provenance_sha,
            ":method": method_text(record.method),
            ":paths": serde_json::to_string(&record.paths)?,
            ":cli_version": record.cli_version,
            ":installed_at": record.installed_at,
        },
    )?;
    Ok(())
}

/// Optional narrowing of [`read_install_records`].
#[derive(Debug, Clone, Default)]
pub struct InstallRecordFilter {
    pub registry_id: Option<String>,
    pub folder_name: Option<String>,
    pub target: Option<String>,
}

/// Read install records matching `filter`.
pub fn read_install_records(
    conn: &Connection,
    filter: &InstallRecordFilter,
) -> AppResult<Vec<InstallRecord>> {
    let mut clauses = Vec::new();
    let mut values: Vec<(&str, &str)> = Vec::new();
    if let Some(value) = &filter.registry_id {
        clauses.push("registry_id = :registry_id");
        values.push((":registry_id", value));
    }
    if let Some(value) = &filter.folder_name {
        clauses.push("folder_name = :folder_name");
        values.push((":folder_name", value));
    }
    if let Some(value) = &filter.target {
        clauses.push("target = :target");
        values.push((":target", value));
    }
    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let sql = format!("SELECT {COLUMNS} FROM install_record {where_clause}");
    let params: Vec<(&str, &dyn rusqlite::ToSql)> = values
        .iter()
        .map(|(name, value)| (*name, value as &dyn rusqlite::ToSql))
        .collect();
    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map(params.as_slice(), read_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(mut record, method, paths)| {
            record.method = parse_method(&method)?;
            record.paths = serde_json::from_str(&paths)?;
            Ok(record)
        })
        .collect()
}

/// The record occupying `(target, folder_name)`, if any.
pub fn read_occupancy(
    conn: &Connection,
    target: &str,
    folder_name: &str,
) -> AppResult<Option<InstallRecord>> {
    let filter = InstallRecordFilter {
        target: Some(target.to_string()),
        folder_name: Some(folder_name.to_string()),
        ..Default::default()
    };
    Ok(read_install_records(conn, &filter)?.into_iter().next())
}

/// Delete the record for `(target, folder_name)`.
pub fn delete_install_record(conn: &Connection, target: &str, folder_name: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM install_record WHERE target = ?1 AND folder_name = ?2",
        (target, folder_name),
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn record(target: &str, folder: &str, registry: &str) -> InstallRecord {
        InstallRecord {
            registry_id: registry.into(),
            folder_name: folder.into(),
            target: target.into(),
            content_hash: "hash".into(),
            provenance_sha: "sha".into(),
            method: InstallMethod::Copy,
            paths: Vec::new(),
            cli_version: "1.7.0".into(),
            installed_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::record;
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn upsert_round_trips_and_replaces_by_primary_key() {
        let conn = open_in_memory().unwrap();
        let mut first = record("/elsewhere", "alpha", "reg-a");
        first.paths = vec!["/elsewhere/alpha".into()];
        upsert_install_record(&conn, &first).unwrap();
        assert_eq!(
            read_install_records(&conn, &InstallRecordFilter::default()).unwrap(),
            vec![first.clone()]
        );

        let mut second = first.clone();
        second.registry_id = "reg-b".into();
        second.method = InstallMethod::Symlink;
        upsert_install_record(&conn, &second).unwrap();
        let all = read_install_records(&conn, &InstallRecordFilter::default()).unwrap();
        assert_eq!(all, vec![second]);
    }

    #[test]
    fn filters_and_deletes() {
        let conn = open_in_memory().unwrap();
        upsert_install_record(&conn, &record("~/.a", "alpha", "reg-a")).unwrap();
        upsert_install_record(&conn, &record("~/.b", "alpha", "reg-b")).unwrap();
        upsert_install_record(&conn, &record("~/.a", "beta", "reg-a")).unwrap();

        let by_registry = InstallRecordFilter {
            registry_id: Some("reg-a".into()),
            ..Default::default()
        };
        assert_eq!(read_install_records(&conn, &by_registry).unwrap().len(), 2);
        assert_eq!(
            read_occupancy(&conn, "~/.b", "alpha")
                .unwrap()
                .unwrap()
                .registry_id,
            "reg-b"
        );
        assert!(read_occupancy(&conn, "~/.b", "beta").unwrap().is_none());

        delete_install_record(&conn, "~/.a", "alpha").unwrap();
        let rest = read_install_records(&conn, &InstallRecordFilter::default()).unwrap();
        assert_eq!(rest.len(), 2);
    }
}
