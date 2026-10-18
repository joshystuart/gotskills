//! Remove an installed Skill from targets.

use std::fs;
use std::io;
use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;
use crate::types::{
    skill_id, TargetOutcome, UninstallRequest, UninstallResult, UninstallTargetResult,
};

use super::copy::is_safe_folder_name;
use super::errors::redact_error;
use super::records::delete_install_record;
use super::targets::target_install_path;

/// Dependencies of [`uninstall_skill`].
pub struct UninstallDeps<'a> {
    pub conn: &'a Connection,
    pub home: &'a Path,
}

fn remove_if_present(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path).map(|_| true),
        Ok(_) => fs::remove_file(path).map(|_| true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Delete the install folder and record for each target. A target whose folder
/// cannot be removed is reported as failed and keeps its record. `outcome:
/// installed` means the target was handled, matching the renderer contract.
pub fn uninstall_skill(
    deps: &UninstallDeps,
    request: &UninstallRequest,
) -> AppResult<UninstallResult> {
    let mut per_target = Vec::new();
    for target in &request.targets {
        if !is_safe_folder_name(&request.folder_name) {
            per_target.push(UninstallTargetResult {
                target: target.clone(),
                outcome: TargetOutcome::Failed,
                paths: Vec::new(),
                error: Some("Invalid skill name: potential path traversal detected".to_string()),
            });
            continue;
        }
        let path = target_install_path(deps.home, target, &request.folder_name);
        match remove_if_present(&path) {
            Ok(existed) => {
                delete_install_record(deps.conn, target, &request.folder_name)?;
                per_target.push(UninstallTargetResult {
                    target: target.clone(),
                    outcome: TargetOutcome::Installed,
                    paths: if existed {
                        vec![path.to_string_lossy().into_owned()]
                    } else {
                        Vec::new()
                    },
                    error: None,
                });
            }
            Err(error) => per_target.push(UninstallTargetResult {
                target: target.clone(),
                outcome: TargetOutcome::Failed,
                paths: Vec::new(),
                error: Some(redact_error(&error.to_string())),
            }),
        }
    }
    Ok(UninstallResult {
        registry_id: request.registry_id.clone(),
        folder_name: request.folder_name.clone(),
        skill_id: skill_id(&request.registry_id, &request.folder_name),
        per_target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::installer::records::{
        fixtures::record, read_install_records, upsert_install_record, InstallRecordFilter,
    };
    use crate::installer::test_support::*;

    fn request(targets: &[&str]) -> UninstallRequest {
        UninstallRequest {
            registry_id: REGISTRY.into(),
            folder_name: "alpha".into(),
            targets: targets.iter().map(|t| t.to_string()).collect(),
        }
    }

    fn install_dir(home: &Path, rel: &str) {
        let dir = home.join(rel).join("alpha");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "body").unwrap();
    }

    #[test]
    fn removes_the_folder_and_record_of_one_target_only() {
        for (removed, removed_dir, kept, kept_dir) in [
            (
                "~/.claude/skills",
                ".claude/skills",
                "~/.agents/skills",
                ".agents/skills",
            ),
            (
                "~/.agents/skills",
                ".agents/skills",
                "~/.claude/skills",
                ".claude/skills",
            ),
        ] {
            let home = tempfile::tempdir().unwrap();
            let conn = database();
            for (target, dir) in [
                ("~/.claude/skills", ".claude/skills"),
                ("~/.agents/skills", ".agents/skills"),
            ] {
                install_dir(home.path(), dir);
                upsert_install_record(&conn, &record(target, "alpha", REGISTRY)).unwrap();
            }

            let deps = UninstallDeps {
                conn: &conn,
                home: home.path(),
            };
            let result = uninstall_skill(&deps, &request(&[removed])).unwrap();

            assert_eq!(result.skill_id, "reg-a/alpha");
            assert_eq!(result.per_target[0].outcome, TargetOutcome::Installed);
            assert_eq!(
                result.per_target[0].paths,
                vec![home
                    .path()
                    .join(removed_dir)
                    .join("alpha")
                    .to_string_lossy()
                    .into_owned()]
            );
            assert!(!home.path().join(removed_dir).join("alpha").exists());
            assert!(home.path().join(kept_dir).join("alpha/SKILL.md").exists());
            let targets: Vec<String> = read_install_records(&conn, &InstallRecordFilter::default())
                .unwrap()
                .into_iter()
                .map(|r| r.target)
                .collect();
            assert_eq!(targets, vec![kept.to_string()]);
        }
    }

    #[test]
    fn an_already_missing_folder_still_clears_the_record() {
        let home = tempfile::tempdir().unwrap();
        let conn = database();
        upsert_install_record(&conn, &record("~/.claude/skills", "alpha", REGISTRY)).unwrap();
        let deps = UninstallDeps {
            conn: &conn,
            home: home.path(),
        };

        let result = uninstall_skill(&deps, &request(&["~/.claude/skills"])).unwrap();

        assert_eq!(result.per_target[0].outcome, TargetOutcome::Installed);
        assert!(result.per_target[0].paths.is_empty());
        assert!(read_install_records(&conn, &InstallRecordFilter::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_unsafe_folder_names_without_touching_disk() {
        let home = tempfile::tempdir().unwrap();
        let conn = database();
        let deps = UninstallDeps {
            conn: &conn,
            home: home.path(),
        };
        let mut bad = request(&["~/.claude/skills"]);
        bad.folder_name = "..".into();
        let result = uninstall_skill(&deps, &bad).unwrap();
        assert_eq!(result.per_target[0].outcome, TargetOutcome::Failed);
    }
}
