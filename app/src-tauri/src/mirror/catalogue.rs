use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use crate::db::SyncMarkerStatus;
use crate::error::AppResult;
use crate::registries::{
    get_marker, list_registries, record_marker_failure, registry_label, StoredRegistry,
};
use crate::short_sha::short_sha;
use crate::types::{
    skill_id, CatalogueSnapshot, CatalogueSyncPhase, InstallRecord, PerTargetState, ReconcileEntry,
    ReconcileReport, RegistrySyncStatus, SkillSummary, SyncFailureReason, SyncPhase, SyncStatus,
};

/// Record a failed sync for one registry without clearing its last-good
/// snapshot (`Offline`, `AccessRequired` or `Empty`).
pub fn record_sync_failure(
    conn: &Connection,
    registry_id: &str,
    status: SyncMarkerStatus,
) -> rusqlite::Result<()> {
    record_marker_failure(conn, registry_id, status)
}

fn visible_skill_count(conn: &Connection, registry_id: &str) -> rusqlite::Result<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM skill WHERE registry_id = ?1 AND soft_deleted = 0",
        [registry_id],
        |row| row.get(0),
    )
}

/// Build a per-registry sync status from its persisted marker.
pub fn registry_sync_status_from_marker(
    conn: &Connection,
    registry_id: &str,
) -> AppResult<RegistrySyncStatus> {
    let marker = get_marker(conn, registry_id)?;
    let count = visible_skill_count(conn, registry_id)?;
    let Some(marker) = marker.filter(|marker| marker.status != SyncMarkerStatus::Never) else {
        return Ok(RegistrySyncStatus {
            registry_id: registry_id.to_string(),
            phase: SyncPhase::Synced,
            last_synced_at: None,
            reason: None,
            revision: None,
            visible_skill_count: Some(0),
            stale: None,
        });
    };
    let (phase, reason) = match marker.status {
        SyncMarkerStatus::Ok | SyncMarkerStatus::Never => (SyncPhase::Synced, None),
        SyncMarkerStatus::Offline => (SyncPhase::Failed, Some(SyncFailureReason::Offline)),
        SyncMarkerStatus::Empty => (SyncPhase::Failed, Some(SyncFailureReason::Empty)),
        SyncMarkerStatus::AccessRequired => {
            (SyncPhase::Failed, Some(SyncFailureReason::AccessRequired))
        }
    };
    Ok(RegistrySyncStatus {
        registry_id: registry_id.to_string(),
        phase,
        last_synced_at: marker.last_sync_at,
        reason,
        revision: marker.last_sync_revision,
        visible_skill_count: Some(count),
        stale: Some(marker.stale),
    })
}

/// Aggregate per-registry outcomes into a combined catalogue status. One
/// registry failing never fails the whole catalogue: mixed results become
/// `Partial`, and a shared reason is only surfaced when every registry failed
/// the same way.
pub fn aggregate_sync_status(registries: Vec<RegistrySyncStatus>) -> SyncStatus {
    if registries.is_empty() {
        return SyncStatus {
            phase: CatalogueSyncPhase::Synced,
            last_synced_at: None,
            reason: None,
            revision: None,
            visible_skill_count: None,
            registries,
        };
    }

    let last_synced_at = registries
        .iter()
        .filter_map(|registry| registry.last_synced_at.clone())
        .max();
    let total_visible: u32 = registries
        .iter()
        .map(|registry| registry.visible_skill_count.unwrap_or(0))
        .sum();

    let failed: Vec<&RegistrySyncStatus> = registries
        .iter()
        .filter(|registry| registry.phase == SyncPhase::Failed)
        .collect();

    let (phase, reason) = if registries
        .iter()
        .any(|registry| registry.phase == SyncPhase::Syncing)
    {
        (CatalogueSyncPhase::Syncing, None)
    } else if failed.is_empty() {
        (CatalogueSyncPhase::Synced, None)
    } else if failed.len() == registries.len() {
        let first = failed[0].reason;
        let shared = failed.iter().all(|registry| registry.reason == first);
        (
            CatalogueSyncPhase::Failed,
            if shared { first } else { None },
        )
    } else {
        (CatalogueSyncPhase::Partial, None)
    };

    SyncStatus {
        phase,
        last_synced_at,
        reason,
        revision: None,
        visible_skill_count: Some(total_visible),
        registries,
    }
}

struct SkillRow {
    registry_id: String,
    folder_name: String,
    name: String,
    description: String,
    head_provenance_sha: Option<String>,
    head_updated_at: Option<String>,
    soft_deleted: bool,
    enabled: bool,
    removed: bool,
}

struct Included {
    row: SkillRow,
    available: bool,
    orphaned: bool,
}

fn per_target_from_reconcile(
    registry_id: &str,
    folder_name: &str,
    entries: &[ReconcileEntry],
    records: &HashMap<&str, &InstallRecord>,
) -> Vec<PerTargetState> {
    entries
        .iter()
        .filter(|entry| entry.registry_id == registry_id && entry.folder_name == folder_name)
        .map(|entry| PerTargetState {
            target: entry.target.clone(),
            state: entry.state,
            installed_version: short_sha(
                records
                    .get(entry.target.as_str())
                    .map(|record| record.provenance_sha.as_str()),
            ),
        })
        .collect()
}

/// Combined Catalogue: the union of every enabled registry's available skills,
/// plus installed-only entries from disabled registries and Orphaned
/// Installations from removed registries. Same-folder skills from several
/// enabled registries all stay visible and are flagged as a Skill Conflict.
///
/// `report` is the installer's reconcile output and `install_records` the
/// current install records; both come from the installer module.
pub fn read_catalogue(
    conn: &Connection,
    report: &ReconcileReport,
    install_records: &[InstallRecord],
) -> AppResult<CatalogueSnapshot> {
    let registries = list_registries(conn, true)?;
    let by_id: HashMap<&str, &StoredRegistry> = registries
        .iter()
        .map(|registry| (registry.id.as_str(), registry))
        .collect();
    let mut marker_stale: HashMap<&str, bool> = HashMap::new();
    for registry in &registries {
        let stale = get_marker(conn, &registry.id)?
            .map(|marker| marker.stale)
            .unwrap_or(false);
        marker_stale.insert(registry.id.as_str(), stale);
    }

    let mut owned_installs: HashMap<(&str, &str), HashMap<&str, &InstallRecord>> = HashMap::new();
    for record in install_records {
        owned_installs
            .entry((record.registry_id.as_str(), record.folder_name.as_str()))
            .or_default()
            .insert(record.target.as_str(), record);
    }
    let installed_keys: HashSet<(&str, &str)> = owned_installs.keys().copied().collect();

    let mut stmt = conn.prepare(
        "SELECT s.registry_id, s.folder_name, s.name, s.description,
                s.head_provenance_sha, s.head_updated_at, s.soft_deleted,
                r.enabled, r.removed_at
         FROM skill s
         JOIN registry r ON r.id = s.registry_id
         ORDER BY s.name COLLATE NOCASE, s.registry_id",
    )?;
    let rows: Vec<SkillRow> = stmt
        .query_map([], |row| {
            Ok(SkillRow {
                registry_id: row.get(0)?,
                folder_name: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                head_provenance_sha: row.get(4)?,
                head_updated_at: row.get(5)?,
                soft_deleted: row.get::<_, i64>(6)? == 1,
                enabled: row.get::<_, i64>(7)? == 1,
                removed: row.get::<_, Option<String>>(8)?.is_some(),
            })
        })?
        .collect::<Result<_, _>>()?;

    let mut available_folder_counts: HashMap<String, usize> = HashMap::new();
    let mut included: Vec<Included> = Vec::new();

    for row in rows {
        let installed =
            installed_keys.contains(&(row.registry_id.as_str(), row.folder_name.as_str()));
        if row.removed {
            if installed {
                included.push(Included {
                    row,
                    available: false,
                    orphaned: true,
                });
            }
            continue;
        }
        if !row.enabled {
            if installed {
                included.push(Included {
                    row,
                    available: false,
                    orphaned: false,
                });
            }
            continue;
        }
        if !row.soft_deleted {
            *available_folder_counts
                .entry(row.folder_name.clone())
                .or_insert(0) += 1;
            included.push(Included {
                row,
                available: true,
                orphaned: false,
            });
        } else if installed {
            included.push(Included {
                row,
                available: false,
                orphaned: false,
            });
        }
    }

    let empty_records = HashMap::new();
    let skills = included
        .into_iter()
        .map(
            |Included {
                 row,
                 available,
                 orphaned,
             }| {
                let records = owned_installs
                    .get(&(row.registry_id.as_str(), row.folder_name.as_str()))
                    .unwrap_or(&empty_records);
                let conflict = available
                    && available_folder_counts
                        .get(&row.folder_name)
                        .copied()
                        .unwrap_or(0)
                        > 1;
                SkillSummary {
                    id: skill_id(&row.registry_id, &row.folder_name),
                    registry_label: by_id
                        .get(row.registry_id.as_str())
                        .map(|registry| registry_label(registry))
                        .unwrap_or_else(|| row.registry_id.clone()),
                    conflict,
                    stale: marker_stale
                        .get(row.registry_id.as_str())
                        .copied()
                        .unwrap_or(false),
                    orphaned,
                    latest_version: short_sha(row.head_provenance_sha.as_deref()),
                    updated_at: row.head_updated_at.clone(),
                    soft_deleted: row.soft_deleted,
                    per_target: per_target_from_reconcile(
                        &row.registry_id,
                        &row.folder_name,
                        &report.entries,
                        records,
                    ),
                    registry_id: row.registry_id,
                    folder_name: row.folder_name,
                    name: row.name,
                    description: row.description,
                }
            },
        )
        .collect();

    let mut enabled_statuses = Vec::new();
    for registry in registries
        .iter()
        .filter(|registry| registry.enabled && registry.removed_at.is_none())
    {
        enabled_statuses.push(registry_sync_status_from_marker(conn, &registry.id)?);
    }

    Ok(CatalogueSnapshot {
        skills,
        sync_status: aggregate_sync_status(enabled_statuses),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::registries::{
        insert_registry, soft_remove_registry, update_registry, upsert_marker_success,
        InsertRegistryInput, UpdateRegistryFields,
    };
    use crate::types::{InstallMethod, ReconcileState};

    fn ok(id: &str, at: &str, revision: &str) -> RegistrySyncStatus {
        RegistrySyncStatus {
            registry_id: id.into(),
            phase: SyncPhase::Synced,
            last_synced_at: Some(at.into()),
            reason: None,
            revision: Some(revision.into()),
            visible_skill_count: Some(2),
            stale: None,
        }
    }

    fn failed(id: &str, reason: SyncFailureReason) -> RegistrySyncStatus {
        RegistrySyncStatus {
            registry_id: id.into(),
            phase: SyncPhase::Failed,
            last_synced_at: None,
            reason: Some(reason),
            revision: None,
            visible_skill_count: Some(0),
            stale: None,
        }
    }

    #[test]
    fn aggregate_is_synced_with_a_null_timestamp_without_registries() {
        let status = aggregate_sync_status(Vec::new());
        assert_eq!(status.phase, CatalogueSyncPhase::Synced);
        assert_eq!(status.last_synced_at, None);
        assert!(status.registries.is_empty());
        assert_eq!(status.visible_skill_count, None);
    }

    #[test]
    fn aggregate_reports_the_most_recent_successful_timestamp() {
        let status = aggregate_sync_status(vec![
            ok("a", "2026-07-10T01:00:00.000Z", "rev-a"),
            ok("b", "2026-07-11T02:00:00.000Z", "rev-b"),
        ]);
        assert_eq!(status.phase, CatalogueSyncPhase::Synced);
        assert_eq!(
            status.last_synced_at.as_deref(),
            Some("2026-07-11T02:00:00.000Z")
        );
        assert_eq!(status.registries.len(), 2);
        assert_eq!(status.visible_skill_count, Some(4));
    }

    #[test]
    fn aggregate_is_syncing_when_any_registry_is_syncing() {
        let syncing = RegistrySyncStatus {
            registry_id: "b".into(),
            phase: SyncPhase::Syncing,
            last_synced_at: None,
            reason: None,
            revision: None,
            visible_skill_count: None,
            stale: None,
        };
        let status =
            aggregate_sync_status(vec![ok("a", "2026-07-10T01:00:00.000Z", "rev-a"), syncing]);
        assert_eq!(status.phase, CatalogueSyncPhase::Syncing);
    }

    #[test]
    fn aggregate_is_partial_when_some_fail_and_others_succeed() {
        let status = aggregate_sync_status(vec![
            ok("a", "2026-07-10T01:00:00.000Z", "rev-a"),
            failed("b", SyncFailureReason::Offline),
        ]);
        assert_eq!(status.phase, CatalogueSyncPhase::Partial);
        assert_eq!(status.reason, None);
    }

    #[test]
    fn aggregate_failed_has_a_reason_only_when_all_failed_the_same_way() {
        let same = aggregate_sync_status(vec![
            failed("a", SyncFailureReason::Offline),
            failed("b", SyncFailureReason::Offline),
        ]);
        assert_eq!(same.phase, CatalogueSyncPhase::Failed);
        assert_eq!(same.reason, Some(SyncFailureReason::Offline));

        let mixed = aggregate_sync_status(vec![
            failed("a", SyncFailureReason::Offline),
            failed("b", SyncFailureReason::AccessRequired),
        ]);
        assert_eq!(mixed.phase, CatalogueSyncPhase::Failed);
        assert_eq!(mixed.reason, None);
    }

    fn registry(conn: &Connection, key: &str) -> String {
        insert_registry(
            conn,
            &InsertRegistryInput {
                url: format!("https://github.com/o/{key}"),
                branch: "main".into(),
                enabled: true,
                auto_update: false,
                github_owner: Some("o".into()),
                github_repo: Some(key.into()),
                canonical_key: format!("github:o/{key}"),
            },
        )
        .unwrap()
        .id
    }

    fn skill(conn: &Connection, registry_id: &str, folder: &str, soft_deleted: i64) {
        conn.execute(
            "INSERT INTO skill (registry_id, folder_name, name, description, head_provenance_sha, soft_deleted)
             VALUES (?1, ?2, ?2, 'desc', 'abcdef0123456789', ?3)",
            rusqlite::params![registry_id, folder, soft_deleted],
        )
        .unwrap();
    }

    fn record(registry_id: &str, folder: &str, target: &str) -> InstallRecord {
        InstallRecord {
            registry_id: registry_id.into(),
            folder_name: folder.into(),
            target: target.into(),
            content_hash: "h".into(),
            provenance_sha: "1234567890abcdef".into(),
            method: InstallMethod::Copy,
            paths: vec![],
            cli_version: "1.7.0".into(),
            installed_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    fn report(
        registry_id: &str,
        folder: &str,
        target: &str,
        state: ReconcileState,
    ) -> ReconcileReport {
        ReconcileReport {
            scanned_at: "now".into(),
            entries: vec![ReconcileEntry {
                registry_id: registry_id.into(),
                folder_name: folder.into(),
                skill_id: skill_id(registry_id, folder),
                target: target.into(),
                state,
                installed_hash: None,
                mirror_hash: None,
                disk: vec![],
                lock_agrees: true,
            }],
        }
    }

    fn empty_report() -> ReconcileReport {
        ReconcileReport {
            scanned_at: "now".into(),
            entries: vec![],
        }
    }

    #[test]
    fn marker_status_never_reads_as_synced_with_no_skills() {
        let conn = open_in_memory().unwrap();
        let id = registry(&conn, "a");
        let status = registry_sync_status_from_marker(&conn, &id).unwrap();
        assert_eq!(status.phase, SyncPhase::Synced);
        assert_eq!(status.last_synced_at, None);
        assert_eq!(status.visible_skill_count, Some(0));
    }

    #[test]
    fn marker_status_reflects_success_and_failures() {
        let conn = open_in_memory().unwrap();
        let id = registry(&conn, "a");
        skill(&conn, &id, "alpha", 0);
        upsert_marker_success(
            &conn,
            &id,
            "rev1",
            "2026-01-01T00:00:00.000Z",
            SyncMarkerStatus::Ok,
        )
        .unwrap();
        let ok = registry_sync_status_from_marker(&conn, &id).unwrap();
        assert_eq!(ok.phase, SyncPhase::Synced);
        assert_eq!(ok.revision.as_deref(), Some("rev1"));
        assert_eq!(ok.visible_skill_count, Some(1));
        assert_eq!(ok.stale, Some(false));

        record_sync_failure(&conn, &id, SyncMarkerStatus::AccessRequired).unwrap();
        let failed = registry_sync_status_from_marker(&conn, &id).unwrap();
        assert_eq!(failed.phase, SyncPhase::Failed);
        assert_eq!(failed.reason, Some(SyncFailureReason::AccessRequired));
        assert_eq!(failed.stale, Some(true));
        assert_eq!(failed.revision.as_deref(), Some("rev1"));
    }

    #[test]
    fn catalogue_lists_available_skills_with_labels_and_short_versions() {
        let conn = open_in_memory().unwrap();
        let id = registry(&conn, "a");
        skill(&conn, &id, "alpha", 0);
        upsert_marker_success(
            &conn,
            &id,
            "rev1",
            "2026-01-01T00:00:00.000Z",
            SyncMarkerStatus::Ok,
        )
        .unwrap();
        let snapshot = read_catalogue(&conn, &empty_report(), &[]).unwrap();
        assert_eq!(snapshot.skills.len(), 1);
        let alpha = &snapshot.skills[0];
        assert_eq!(alpha.id, format!("{id}/alpha"));
        assert_eq!(alpha.registry_label, "o/a");
        assert_eq!(alpha.latest_version.as_deref(), Some("abcdef0"));
        assert!(!alpha.conflict && !alpha.orphaned && !alpha.soft_deleted);
        assert_eq!(snapshot.sync_status.visible_skill_count, Some(1));
    }

    #[test]
    fn same_folder_in_two_enabled_registries_is_a_conflict() {
        let conn = open_in_memory().unwrap();
        let a = registry(&conn, "a");
        let b = registry(&conn, "b");
        skill(&conn, &a, "shared", 0);
        skill(&conn, &b, "shared", 0);
        skill(&conn, &b, "solo", 0);
        let snapshot = read_catalogue(&conn, &empty_report(), &[]).unwrap();
        let conflicts: Vec<_> = snapshot
            .skills
            .iter()
            .map(|s| (s.folder_name.as_str(), s.conflict))
            .collect();
        assert_eq!(
            conflicts,
            vec![("shared", true), ("shared", true), ("solo", false)]
        );
    }

    #[test]
    fn soft_deleted_and_disabled_skills_show_only_when_installed() {
        let conn = open_in_memory().unwrap();
        let a = registry(&conn, "a");
        let b = registry(&conn, "b");
        skill(&conn, &a, "gone", 1);
        skill(&conn, &a, "gone-installed", 1);
        skill(&conn, &b, "off", 0);
        skill(&conn, &b, "off-installed", 0);
        update_registry(
            &conn,
            &b,
            UpdateRegistryFields {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        let records = vec![
            record(&a, "gone-installed", "claude-code"),
            record(&b, "off-installed", "claude-code"),
        ];

        let snapshot = read_catalogue(&conn, &empty_report(), &records).unwrap();
        let mut folders: Vec<_> = snapshot
            .skills
            .iter()
            .map(|s| s.folder_name.as_str())
            .collect();
        folders.sort();
        assert_eq!(folders, vec!["gone-installed", "off-installed"]);
        assert!(snapshot.skills.iter().all(|s| !s.orphaned));
        assert!(
            snapshot
                .skills
                .iter()
                .find(|s| s.folder_name == "gone-installed")
                .unwrap()
                .soft_deleted
        );
        assert_eq!(snapshot.sync_status.registries.len(), 1);
    }

    #[test]
    fn removed_registries_surface_orphaned_installations_only() {
        let conn = open_in_memory().unwrap();
        let a = registry(&conn, "a");
        skill(&conn, &a, "kept", 0);
        skill(&conn, &a, "plain", 0);
        soft_remove_registry(&conn, &a).unwrap();
        let records = vec![record(&a, "kept", "claude-code")];

        let snapshot = read_catalogue(&conn, &empty_report(), &records).unwrap();
        assert_eq!(snapshot.skills.len(), 1);
        assert_eq!(snapshot.skills[0].folder_name, "kept");
        assert!(snapshot.skills[0].orphaned);
        assert!(snapshot.sync_status.registries.is_empty());
    }

    #[test]
    fn per_target_states_carry_the_installed_short_version() {
        let conn = open_in_memory().unwrap();
        let a = registry(&conn, "a");
        skill(&conn, &a, "alpha", 0);
        let records = vec![record(&a, "alpha", "claude-code")];
        let reconcile = report(&a, "alpha", "claude-code", ReconcileState::UpdateAvailable);

        let snapshot = read_catalogue(&conn, &reconcile, &records).unwrap();
        assert_eq!(
            snapshot.skills[0].per_target,
            vec![PerTargetState {
                target: "claude-code".into(),
                state: ReconcileState::UpdateAvailable,
                installed_version: Some("1234567".into()),
            }]
        );
    }
}
