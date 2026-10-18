//! Read-only reconciliation of install records against disk and the mirror.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{SecondsFormat, Utc};
use rusqlite::Connection;

use crate::env::Environment;
use crate::error::AppResult;
use crate::short_sha::short_sha;
use crate::types::{
    skill_id, DiskProbe, InstallRecord, PerTargetState, ReconcileEntry, ReconcileReport,
    ReconcileState,
};

use super::agents::AgentDirectory;
use super::records::read_install_records;
use super::targets::{detect_install_targets, target_install_path};

fn probe_path(path: &Path) -> DiskProbe {
    let display = path.to_string_lossy().into_owned();
    if !path.exists() {
        return DiskProbe {
            path: display,
            exists: false,
            is_symlink: false,
            resolves: false,
            content_hash: None,
        };
    }
    let (is_symlink, resolves) = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => (true, fs::canonicalize(path).is_ok()),
        Ok(_) => (false, true),
        Err(_) => (false, false),
    };
    DiskProbe {
        path: display,
        exists: true,
        is_symlink,
        resolves,
        content_hash: None,
    }
}

fn disk_present(probes: &[DiskProbe]) -> bool {
    probes.iter().any(|p| p.exists && p.resolves)
}

fn disk_broken(probes: &[DiskProbe]) -> bool {
    probes.iter().any(|p| p.exists && !p.resolves)
}

/// Advisory corroboration from the CLI's `~/.agents/.skill-lock.json`. It is
/// never product truth; a missing or unreadable lock agrees.
pub fn lock_agrees(home: &Path, folder_name: &str, has_record: bool) -> bool {
    if !has_record {
        return true;
    }
    let lock_path = home.join(".agents").join(".skill-lock.json");
    if !lock_path.exists() {
        return true;
    }
    let text = fs::read_to_string(&lock_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| serde_json::to_string(&value).ok());
    match text {
        Some(text) => {
            text.contains(&format!("\"{folder_name}\""))
                || text.contains(&format!("/{folder_name}"))
        }
        None => true,
    }
}

struct DeriveInput<'a> {
    soft_deleted: bool,
    updates_unavailable: bool,
    record: Option<&'a InstallRecord>,
    occupied_by_other: bool,
    mirror_hash: Option<&'a str>,
    probes: &'a [DiskProbe],
}

fn derive_state(input: &DeriveInput) -> ReconcileState {
    let present = disk_present(input.probes);
    let broken = disk_broken(input.probes);

    if let Some(record) = input.record {
        if input.updates_unavailable {
            return if !present || broken {
                ReconcileState::NeedsRepair
            } else {
                ReconcileState::Installed
            };
        }
        if input.soft_deleted {
            return ReconcileState::RemovedFromRegistry;
        }
        if !present || broken {
            return ReconcileState::NeedsRepair;
        }
        return match input.mirror_hash {
            Some(hash) if !hash.is_empty() && record.content_hash != hash => {
                ReconcileState::UpdateAvailable
            }
            _ => ReconcileState::Installed,
        };
    }
    if input.occupied_by_other {
        return ReconcileState::OtherRegistry;
    }
    if present {
        ReconcileState::External
    } else {
        ReconcileState::NotInstalled
    }
}

/// Inputs of [`reconcile`].
pub struct ReconcileDeps<'a> {
    pub conn: &'a Connection,
    pub environment: &'a Environment,
    pub agents: &'a dyn AgentDirectory,
    pub registry_id: Option<&'a str>,
    pub folder_name: Option<&'a str>,
}

struct SkillMeta {
    registry_id: String,
    folder_name: String,
    head_content_hash: Option<String>,
    soft_deleted: bool,
    registry_enabled: bool,
    registry_removed: bool,
}

fn read_skill_rows(deps: &ReconcileDeps) -> AppResult<Vec<SkillMeta>> {
    let mut statement = deps.conn.prepare(
        "SELECT s.registry_id, s.folder_name, s.head_content_hash, s.soft_deleted,
                r.enabled, CASE WHEN r.removed_at IS NULL THEN 0 ELSE 1 END
         FROM skill s JOIN registry r ON r.id = s.registry_id
         WHERE (?1 IS NULL OR s.registry_id = ?1) AND (?2 IS NULL OR s.folder_name = ?2)",
    )?;
    let rows = statement
        .query_map((deps.registry_id, deps.folder_name), |row| {
            Ok(SkillMeta {
                registry_id: row.get(0)?,
                folder_name: row.get(1)?,
                head_content_hash: row.get(2)?,
                soft_deleted: row.get::<_, i64>(3)? == 1,
                registry_enabled: row.get::<_, i64>(4)? != 0,
                registry_removed: row.get::<_, i64>(5)? == 1,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Read-only reconciliation scoped to a Registry (and optionally one folder).
/// SQLite is the truth, disk is probed, the CLI lock is advisory. Never writes.
pub fn reconcile(deps: &ReconcileDeps) -> AppResult<ReconcileReport> {
    let skill_rows = read_skill_rows(deps)?;
    let records = read_install_records(deps.conn, &Default::default())?;
    let occupancy: HashMap<(&str, &str), &InstallRecord> = records
        .iter()
        .map(|rec| ((rec.target.as_str(), rec.folder_name.as_str()), rec))
        .collect();
    let home = &deps.environment.home;
    let targets: Vec<String> = detect_install_targets(
        deps.environment,
        deps.agents,
        records.iter().map(|rec| rec.target.clone()),
    )
    .into_iter()
    .filter(|target| target.visible)
    .map(|target| target.id)
    .collect();

    let mut entries = Vec::new();
    for meta in &skill_rows {
        let updates_unavailable = !meta.registry_enabled || meta.registry_removed;
        let mirror_hash = meta.head_content_hash.as_deref();
        for target in &targets {
            let occupant = occupancy
                .get(&(target.as_str(), meta.folder_name.as_str()))
                .copied();
            let ours = occupant.filter(|rec| rec.registry_id == meta.registry_id);
            let occupied_by_other = occupant.is_some_and(|rec| rec.registry_id != meta.registry_id);
            let probes = vec![probe_path(&target_install_path(
                home,
                target,
                &meta.folder_name,
            ))];
            let state = derive_state(&DeriveInput {
                soft_deleted: meta.soft_deleted,
                updates_unavailable,
                record: ours,
                occupied_by_other,
                mirror_hash,
                probes: &probes,
            });
            entries.push(ReconcileEntry {
                registry_id: meta.registry_id.clone(),
                folder_name: meta.folder_name.clone(),
                skill_id: skill_id(&meta.registry_id, &meta.folder_name),
                target: target.clone(),
                state,
                installed_hash: ours.map(|rec| rec.content_hash.clone()),
                mirror_hash: meta.head_content_hash.clone(),
                disk: probes,
                lock_agrees: lock_agrees(home, &meta.folder_name, ours.is_some()),
            });
        }
    }

    Ok(ReconcileReport {
        scanned_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        entries,
    })
}

/// Map reconcile entries to [`PerTargetState`] for one Skill (catalogue merge).
pub fn per_target_from_reconcile(
    registry_id: &str,
    folder_name: &str,
    entries: &[ReconcileEntry],
    records: &HashMap<String, InstallRecord>,
) -> Vec<PerTargetState> {
    entries
        .iter()
        .filter(|entry| entry.registry_id == registry_id && entry.folder_name == folder_name)
        .map(|entry| PerTargetState {
            target: entry.target.clone(),
            state: entry.state,
            installed_version: short_sha(
                records
                    .get(&entry.target)
                    .map(|rec| rec.provenance_sha.as_str()),
            ),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::installer::install::{install_skill, InstallDeps};
    use crate::installer::records::{fixtures::record, upsert_install_record};
    use crate::installer::targets::fixtures::table;
    use crate::installer::test_support::*;
    use crate::installer::uninstall::{uninstall_skill, UninstallDeps};
    use crate::types::{InstallRequest, UninstallRequest};

    struct Fixture {
        home: tempfile::TempDir,
        mirror: tempfile::TempDir,
        conn: Connection,
        env: Environment,
        agents: Vec<crate::installer::AgentInfo>,
    }

    fn fixture(detected: &[&str]) -> Fixture {
        let home = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let conn = database();
        add_skill(&conn, REGISTRY, "alpha", "h1", false);
        write_mirror_skill(mirror.path(), "alpha", "body");
        let env = Environment::fake_home(home.path());
        let agents = table(home.path(), detected);
        Fixture {
            home,
            mirror,
            conn,
            env,
            agents,
        }
    }

    impl Fixture {
        fn install(&self, targets: &[&str]) {
            let deps = InstallDeps {
                conn: &self.conn,
                registry_id: REGISTRY,
                mirror_path: self.mirror.path(),
                environment: &self.env,
                current_revision: "rev",
            };
            let request = InstallRequest {
                registry_id: REGISTRY.into(),
                folder_name: "alpha".into(),
                targets: targets.iter().map(|t| t.to_string()).collect(),
                mirror_revision: "rev".into(),
                acknowledge_stale: None,
            };
            install_skill(&deps, &request).unwrap();
        }

        fn report(&self) -> ReconcileReport {
            reconcile(&ReconcileDeps {
                conn: &self.conn,
                environment: &self.env,
                agents: &self.agents,
                registry_id: Some(REGISTRY),
                folder_name: Some("alpha"),
            })
            .unwrap()
        }

        fn state(&self, target: &str) -> ReconcileState {
            self.report()
                .entries
                .iter()
                .find(|e| e.target == target)
                .unwrap_or_else(|| panic!("no entry for {target}"))
                .state
        }

        fn skill_dir(&self, rel: &str) -> std::path::PathBuf {
            self.home.path().join(rel).join("alpha")
        }
    }

    const CLAUDE: &str = "~/.claude/skills";
    const SHARED: &str = "~/.agents/skills";

    #[test]
    fn a_deleted_install_needs_repair_and_reconcile_writes_nothing() {
        let f = fixture(&["claude-code", "cursor"]);
        f.install(&[CLAUDE]);
        assert_eq!(f.state(CLAUDE), ReconcileState::Installed);

        fs::remove_dir_all(f.skill_dir(".claude/skills")).unwrap();
        assert_eq!(f.state(CLAUDE), ReconcileState::NeedsRepair);
        assert!(!f.skill_dir(".claude/skills").exists());

        f.install(&[CLAUDE]);
        assert_eq!(f.state(CLAUDE), ReconcileState::Installed);
    }

    #[test]
    fn a_changed_mirror_hash_is_an_update_until_reinstalled() {
        let f = fixture(&["claude-code"]);
        f.install(&[CLAUDE]);
        f.conn
            .execute(
                "UPDATE skill SET head_content_hash = 'h2', head_provenance_sha = 'sha-h2'",
                [],
            )
            .unwrap();
        assert_eq!(f.state(CLAUDE), ReconcileState::UpdateAvailable);

        f.install(&[CLAUDE]);
        assert_eq!(f.state(CLAUDE), ReconcileState::Installed);
    }

    #[test]
    fn uninstalling_one_target_leaves_the_other_installed() {
        for (removed, kept) in [(CLAUDE, SHARED), (SHARED, CLAUDE)] {
            let f = fixture(&["claude-code", "cursor"]);
            f.install(&[CLAUDE, SHARED]);
            let deps = UninstallDeps {
                conn: &f.conn,
                home: &f.env.home,
            };
            uninstall_skill(
                &deps,
                &UninstallRequest {
                    registry_id: REGISTRY.into(),
                    folder_name: "alpha".into(),
                    targets: vec![removed.into()],
                },
            )
            .unwrap();
            assert_eq!(f.state(kept), ReconcileState::Installed);
            assert_eq!(f.state(removed), ReconcileState::NotInstalled);
        }
    }

    #[test]
    fn a_soft_deleted_installed_skill_is_removed_from_registry() {
        let f = fixture(&["claude-code"]);
        f.install(&[CLAUDE]);
        f.conn
            .execute("UPDATE skill SET soft_deleted = 1", [])
            .unwrap();
        assert_eq!(f.state(CLAUDE), ReconcileState::RemovedFromRegistry);
    }

    #[test]
    fn disabled_or_removed_registries_keep_installs_manageable() {
        let f = fixture(&["claude-code"]);
        f.install(&[CLAUDE]);
        f.conn
            .execute(
                "UPDATE skill SET head_content_hash = 'h2', soft_deleted = 1",
                [],
            )
            .unwrap();
        f.conn
            .execute("UPDATE registry SET enabled = 0", [])
            .unwrap();
        assert_eq!(f.state(CLAUDE), ReconcileState::Installed);

        fs::remove_dir_all(f.skill_dir(".claude/skills")).unwrap();
        f.conn
            .execute("UPDATE registry SET enabled = 1, removed_at = 'x'", [])
            .unwrap();
        assert_eq!(f.state(CLAUDE), ReconcileState::NeedsRepair);
    }

    #[test]
    fn on_disk_skills_without_a_record_are_external_per_target() {
        let f = fixture(&["claude-code", "cursor"]);
        fs::create_dir_all(f.skill_dir(".agents/skills")).unwrap();
        fs::write(f.skill_dir(".agents/skills").join("SKILL.md"), "x").unwrap();
        assert_eq!(f.state(CLAUDE), ReconcileState::NotInstalled);
        assert_eq!(f.state(SHARED), ReconcileState::External);
    }

    #[test]
    fn another_registrys_record_is_other_registry() {
        let f = fixture(&["claude-code"]);
        add_registry(&f.conn, "reg-b", true, false);
        upsert_install_record(&f.conn, &record(CLAUDE, "alpha", "reg-b")).unwrap();
        assert_eq!(f.state(CLAUDE), ReconcileState::OtherRegistry);
    }

    #[cfg(unix)]
    #[test]
    fn a_broken_symlink_needs_repair_without_mutating_disk() {
        let f = fixture(&["claude-code"]);
        f.install(&[CLAUDE]);
        let path = f.skill_dir(".claude/skills");
        fs::remove_dir_all(&path).unwrap();
        std::os::unix::fs::symlink(f.home.path().join(".agents/skills/alpha-missing"), &path)
            .unwrap();
        let before = fs::symlink_metadata(&path).unwrap().modified().unwrap();

        let report = f.report();
        let entry = report.entries.iter().find(|e| e.target == CLAUDE).unwrap();

        assert_eq!(entry.state, ReconcileState::NeedsRepair);
        assert!(!entry.disk[0].exists);
        assert_eq!(
            fs::symlink_metadata(&path).unwrap().modified().unwrap(),
            before
        );
    }

    #[cfg(unix)]
    #[test]
    fn probes_report_symlinks_that_resolve() {
        let f = fixture(&[]);
        let real = f.home.path().join("real");
        fs::create_dir_all(&real).unwrap();
        let link = f.home.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let probe = probe_path(&link);
        assert!(probe.exists && probe.is_symlink && probe.resolves);
    }

    #[test]
    fn the_advisory_lock_only_disagrees_when_it_omits_the_skill() {
        let home = tempfile::tempdir().unwrap();
        assert!(lock_agrees(home.path(), "alpha", true));
        let lock = home.path().join(".agents/.skill-lock.json");
        fs::create_dir_all(lock.parent().unwrap()).unwrap();

        fs::write(&lock, r#"{"skills":{"alpha":{}}}"#).unwrap();
        assert!(lock_agrees(home.path(), "alpha", true));
        assert!(!lock_agrees(home.path(), "beta", true));
        assert!(lock_agrees(home.path(), "beta", false));

        fs::write(&lock, "not json").unwrap();
        assert!(lock_agrees(home.path(), "beta", true));
    }

    #[test]
    fn per_target_states_carry_the_short_installed_version() {
        let f = fixture(&["claude-code"]);
        f.install(&[CLAUDE]);
        let report = f.report();
        let records = read_install_records(&f.conn, &Default::default())
            .unwrap()
            .into_iter()
            .map(|r| (r.target.clone(), r))
            .collect();
        let states = per_target_from_reconcile(REGISTRY, "alpha", &report.entries, &records);
        let claude = states.iter().find(|s| s.target == CLAUDE).unwrap();
        assert_eq!(claude.state, ReconcileState::Installed);
        assert_eq!(claude.installed_version.as_deref(), Some("sha-h1"));
        assert!(per_target_from_reconcile(REGISTRY, "other", &report.entries, &records).is_empty());
    }
}
