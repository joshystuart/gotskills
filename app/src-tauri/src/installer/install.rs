//! Install a Skill from the local mirror into targets.

use std::fs;
use std::path::Path;

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension};

use crate::env::Environment;
use crate::error::{AppError, AppResult, Occupant};
use crate::types::{
    skill_id, InstallMethod, InstallRecord, InstallRequest, InstallResult, TargetOutcome,
    TargetResult,
};

use super::copy::{install_copy, is_safe_folder_name};
use super::errors::redact_error;
use super::records::{read_occupancy, upsert_install_record};
use super::targets::target_install_path;

/// Recorded as `cli_version`: the vendored `skills` CLI release whose copy
/// behaviour [`super::copy`] reproduces.
pub const INSTALLER_VERSION: &str = "1.7.0";

pub const REVISION_REFUSED_MESSAGE: &str = "Catalogue changed since you selected this skill. Refresh and re-select to install the current version.";

/// Everything an install needs besides the request.
pub struct InstallDeps<'a> {
    pub conn: &'a Connection,
    pub registry_id: &'a str,
    pub mirror_path: &'a Path,
    pub environment: &'a Environment,
    /// Current mirror HEAD SHA (the caller validates it under the mirror lock).
    pub current_revision: &'a str,
}

struct SkillHead {
    content_hash: String,
    provenance_sha: String,
    skill_path: Option<String>,
}

fn read_skill_head(deps: &InstallDeps, folder_name: &str) -> AppResult<SkillHead> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = deps
        .conn
        .query_row(
            "SELECT head_content_hash, head_provenance_sha, skill_path
             FROM skill WHERE registry_id = ?1 AND folder_name = ?2 AND soft_deleted = 0",
            (deps.registry_id, folder_name),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match row {
        Some((Some(content_hash), Some(provenance_sha), skill_path))
            if !content_hash.is_empty() && !provenance_sha.is_empty() =>
        {
            Ok(SkillHead {
                content_hash,
                provenance_sha,
                skill_path,
            })
        }
        _ => Err(AppError::not_found(format!(
            "Skill \"{folder_name}\" is not in the catalogue"
        ))),
    }
}

fn assert_no_collision(deps: &InstallDeps, folder_name: &str, target: &str) -> AppResult<()> {
    let occupant = read_occupancy(deps.conn, target, folder_name)?;
    let collision = |message: String, occupant: Occupant| AppError::InstallationCollision {
        message,
        occupant,
        folder_name: folder_name.to_string(),
        target: target.to_string(),
    };
    match occupant {
        Some(record) if record.registry_id != deps.registry_id => Err(collision(
            format!(
                "\"{folder_name}\" is already installed for {target} from another registry. Uninstall it first."
            ),
            Occupant::Managed,
        )),
        None if target_install_path(&deps.environment.home, target, folder_name).exists() => {
            Err(collision(
                format!("\"{folder_name}\" already exists for {target} outside this app. Remove it first."),
                Occupant::External,
            ))
        }
        _ => Ok(()),
    }
}

fn install_one_target(
    deps: &InstallDeps,
    skill_dir: &Path,
    folder_name: &str,
    target: &str,
) -> TargetResult {
    let path = target_install_path(&deps.environment.home, target, folder_name);
    let failed = |error: String, present: bool| TargetResult {
        target: target.to_string(),
        outcome: TargetOutcome::Failed,
        method: InstallMethod::Copy,
        paths: if present {
            vec![path.to_string_lossy().into_owned()]
        } else {
            Vec::new()
        },
        error: Some(redact_error(&error)),
    };
    match install_copy(skill_dir, &path) {
        Ok(_) if path.exists() => TargetResult {
            target: target.to_string(),
            outcome: TargetOutcome::Installed,
            method: InstallMethod::Copy,
            paths: vec![path.to_string_lossy().into_owned()],
            error: None,
        },
        Ok(_) => failed("install failed".to_string(), false),
        Err(error) => failed(error.to_string(), path.exists()),
    }
}

/// Install a Skill from the local mirror into the requested targets. The caller
/// holds the mirror lock and supplies the current HEAD revision. Targets are
/// independent: one may fail while others succeed.
pub fn install_skill(deps: &InstallDeps, request: &InstallRequest) -> AppResult<InstallResult> {
    if request.mirror_revision != deps.current_revision {
        return Err(AppError::failed(REVISION_REFUSED_MESSAGE));
    }
    if !is_safe_folder_name(&request.folder_name) {
        return Err(AppError::invalid(
            "Invalid skill name: potential path traversal detected",
        ));
    }
    let head = read_skill_head(deps, &request.folder_name)?;
    for target in &request.targets {
        assert_no_collision(deps, &request.folder_name, target)?;
    }

    let skill_dir = match &head.skill_path {
        Some(path) if !path.is_empty() => path
            .split('/')
            .fold(deps.mirror_path.to_path_buf(), |dir, part| dir.join(part)),
        _ => deps.mirror_path.join("skills").join(&request.folder_name),
    };
    if !fs::metadata(&skill_dir)
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        return Err(AppError::not_found(format!(
            "Skill \"{}\" is missing from the local mirror",
            request.folder_name
        )));
    }

    let installed_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut per_target = Vec::new();
    for target in &request.targets {
        let result = install_one_target(deps, &skill_dir, &request.folder_name, target);
        if result.outcome == TargetOutcome::Installed {
            upsert_install_record(
                deps.conn,
                &InstallRecord {
                    registry_id: deps.registry_id.to_string(),
                    folder_name: request.folder_name.clone(),
                    target: target.clone(),
                    content_hash: head.content_hash.clone(),
                    provenance_sha: head.provenance_sha.clone(),
                    method: result.method,
                    paths: result.paths.clone(),
                    cli_version: INSTALLER_VERSION.to_string(),
                    installed_at: installed_at.clone(),
                },
            )?;
        }
        per_target.push(result);
    }

    Ok(InstallResult {
        registry_id: deps.registry_id.to_string(),
        folder_name: request.folder_name.clone(),
        skill_id: skill_id(deps.registry_id, &request.folder_name),
        mirror_revision: request.mirror_revision.clone(),
        content_hash: head.content_hash,
        provenance_sha: head.provenance_sha,
        cli_version: INSTALLER_VERSION.to_string(),
        per_target,
        installed_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::installer::records::{read_install_records, InstallRecordFilter};
    use crate::installer::test_support::*;

    struct Fixture {
        home: tempfile::TempDir,
        mirror: tempfile::TempDir,
        conn: Connection,
        env: Environment,
    }

    fn fixture() -> Fixture {
        let home = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let conn = database();
        add_skill(&conn, REGISTRY, "alpha", "h1", false);
        write_mirror_skill(mirror.path(), "alpha", "alpha body");
        let env = Environment::fake_home(home.path());
        Fixture {
            home,
            mirror,
            conn,
            env,
        }
    }

    impl Fixture {
        fn deps(&self) -> InstallDeps<'_> {
            InstallDeps {
                conn: &self.conn,
                registry_id: REGISTRY,
                mirror_path: self.mirror.path(),
                environment: &self.env,
                current_revision: "rev1",
            }
        }

        fn request(&self, targets: &[&str]) -> InstallRequest {
            InstallRequest {
                registry_id: REGISTRY.into(),
                folder_name: "alpha".into(),
                targets: targets.iter().map(|t| t.to_string()).collect(),
                mirror_revision: "rev1".into(),
                acknowledge_stale: None,
            }
        }
    }

    #[test]
    fn installs_a_real_copy_into_each_target_and_records_it() {
        let f = fixture();
        let result = install_skill(
            &f.deps(),
            &f.request(&["~/.claude/skills", "~/.agents/skills"]),
        )
        .unwrap();

        let claude = f.home.path().join(".claude/skills/alpha");
        let shared = f.home.path().join(".agents/skills/alpha");
        assert_eq!(result.skill_id, "reg-a/alpha");
        assert_eq!(result.cli_version, "1.7.0");
        assert_eq!(result.content_hash, "h1");
        assert_eq!(result.provenance_sha, "sha-h1");
        assert_eq!(
            result.per_target,
            vec![
                TargetResult {
                    target: "~/.claude/skills".into(),
                    outcome: TargetOutcome::Installed,
                    method: InstallMethod::Copy,
                    paths: vec![claude.to_string_lossy().into_owned()],
                    error: None,
                },
                TargetResult {
                    target: "~/.agents/skills".into(),
                    outcome: TargetOutcome::Installed,
                    method: InstallMethod::Copy,
                    paths: vec![shared.to_string_lossy().into_owned()],
                    error: None,
                },
            ]
        );
        for dir in [&claude, &shared] {
            assert!(fs::symlink_metadata(dir).unwrap().is_dir());
            assert_eq!(
                fs::read_to_string(dir.join("SKILL.md")).unwrap(),
                "alpha body"
            );
        }
        assert!(!f.home.path().join(".cursor/skills/alpha").exists());

        let records = read_install_records(&f.conn, &InstallRecordFilter::default()).unwrap();
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|r| r.cli_version == "1.7.0"
            && r.registry_id == REGISTRY
            && r.content_hash == "h1"
            && r.method == InstallMethod::Copy));
    }

    #[test]
    fn refuses_a_changed_revision() {
        let f = fixture();
        let mut request = f.request(&["~/.claude/skills"]);
        request.mirror_revision = "other".into();
        let error = install_skill(&f.deps(), &request).unwrap_err();
        assert_eq!(error.message(), REVISION_REFUSED_MESSAGE);
        assert!(!f.home.path().join(".claude").exists());
    }

    #[test]
    fn rejects_unknown_skills_and_unsafe_names() {
        let f = fixture();
        let mut request = f.request(&["~/.claude/skills"]);
        request.folder_name = "ghost".into();
        assert!(matches!(
            install_skill(&f.deps(), &request),
            Err(AppError::NotFound { .. })
        ));
        request.folder_name = "../escape".into();
        assert!(matches!(
            install_skill(&f.deps(), &request),
            Err(AppError::InvalidInput { .. })
        ));
    }

    #[test]
    fn soft_deleted_skills_cannot_be_installed() {
        let f = fixture();
        add_skill(&f.conn, REGISTRY, "gone", "h2", true);
        let mut request = f.request(&["~/.claude/skills"]);
        request.folder_name = "gone".into();
        assert!(install_skill(&f.deps(), &request).is_err());
    }

    #[test]
    fn nested_layout_installs_by_folder_name_from_skill_path() {
        let f = fixture();
        f.conn
            .execute(
                "UPDATE skill SET folder_name = 'code-review', skill_path = 'skills/engineering/code-review' WHERE folder_name = 'alpha'",
                [],
            )
            .unwrap();
        let nested = f.mirror.path().join("skills/engineering/code-review");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("SKILL.md"), "nested").unwrap();
        let mut request = f.request(&["~/.claude/skills"]);
        request.folder_name = "code-review".into();

        let result = install_skill(&f.deps(), &request).unwrap();

        assert_eq!(result.per_target[0].outcome, TargetOutcome::Installed);
        let installed = f.home.path().join(".claude/skills/code-review/SKILL.md");
        assert_eq!(fs::read_to_string(installed).unwrap(), "nested");
    }

    #[test]
    fn an_outside_skill_blocks_only_its_own_target() {
        for (outside, blocked, allowed, allowed_dir) in [
            (
                ".claude/skills",
                "~/.claude/skills",
                "~/.agents/skills",
                ".agents/skills",
            ),
            (
                ".agents/skills",
                "~/.agents/skills",
                "~/.claude/skills",
                ".claude/skills",
            ),
        ] {
            let f = fixture();
            let existing = f.home.path().join(outside).join("alpha");
            fs::create_dir_all(&existing).unwrap();
            fs::write(existing.join("SKILL.md"), "outside this app").unwrap();

            let error = install_skill(&f.deps(), &f.request(&[blocked])).unwrap_err();
            match &error {
                AppError::InstallationCollision {
                    occupant,
                    folder_name,
                    target,
                    ..
                } => {
                    assert_eq!(*occupant, Occupant::External);
                    assert_eq!(folder_name, "alpha");
                    assert_eq!(target, blocked);
                }
                other => panic!("{other:?}"),
            }
            assert!(error.message().contains("outside this app"));

            let result = install_skill(&f.deps(), &f.request(&[allowed])).unwrap();
            assert_eq!(result.per_target[0].outcome, TargetOutcome::Installed);
            assert!(f
                .home
                .path()
                .join(allowed_dir)
                .join("alpha/SKILL.md")
                .exists());
            assert_eq!(
                fs::read_to_string(existing.join("SKILL.md")).unwrap(),
                "outside this app"
            );
        }
    }

    #[test]
    fn another_registrys_install_is_a_managed_collision() {
        let f = fixture();
        add_registry(&f.conn, "reg-b", true, false);
        upsert_install_record(
            &f.conn,
            &crate::installer::records::fixtures::record("~/.claude/skills", "alpha", "reg-b"),
        )
        .unwrap();
        let error = install_skill(&f.deps(), &f.request(&["~/.claude/skills"])).unwrap_err();
        assert!(matches!(
            error,
            AppError::InstallationCollision {
                occupant: Occupant::Managed,
                ..
            }
        ));
        assert!(error.message().contains("another registry"));
    }

    #[test]
    fn reinstalling_over_our_own_record_replaces_the_copy() {
        let f = fixture();
        install_skill(&f.deps(), &f.request(&["~/.claude/skills"])).unwrap();
        let installed = f.home.path().join(".claude/skills/alpha");
        fs::write(installed.join("stale.txt"), "stale").unwrap();
        fs::write(f.mirror.path().join("skills/alpha/SKILL.md"), "v2").unwrap();

        let result = install_skill(&f.deps(), &f.request(&["~/.claude/skills"])).unwrap();

        assert_eq!(result.per_target[0].outcome, TargetOutcome::Installed);
        assert_eq!(
            fs::read_to_string(installed.join("SKILL.md")).unwrap(),
            "v2"
        );
        assert!(!installed.join("stale.txt").exists());
    }

    #[test]
    fn one_target_can_fail_while_another_succeeds() {
        let f = fixture();
        fs::write(f.home.path().join("blocker"), "a file, not a folder").unwrap();

        let result = install_skill(
            &f.deps(),
            &f.request(&["~/.claude/skills", "~/blocker/skills"]),
        )
        .unwrap();

        assert_eq!(result.per_target[0].outcome, TargetOutcome::Installed);
        assert_eq!(result.per_target[1].outcome, TargetOutcome::Failed);
        assert!(result.per_target[1].error.is_some());
        let records = read_install_records(&f.conn, &InstallRecordFilter::default()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].target, "~/.claude/skills");
    }
}
