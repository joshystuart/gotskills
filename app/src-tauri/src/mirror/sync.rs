use crate::types::RegistrySource;
use std::collections::HashSet;
use std::path::PathBuf;

use rusqlite::{named_params, Connection};

use crate::db::{transaction, SyncMarkerStatus};
use crate::registries::{get_marker, upsert_marker_success};

use super::git::{ensure_mirror_since, MirrorConfig};
use super::git_exec::GitError;
use super::scan::{scan_skills, ScannedSkill};

/// Inputs for syncing one registry.
#[derive(Debug, Clone)]
pub struct SyncRegistryConfig {
    pub source: RegistrySource,
    pub registry_id: String,
    pub url: String,
    pub branch: String,
    /// Independent mirror path (`mirrors/<registryId>`), never shared.
    pub mirror_path: PathBuf,
}

/// What a successful sync wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncWriteResult {
    pub revision: String,
    pub visible_skill_count: u32,
    /// `Ok` or `Empty`.
    pub status: SyncMarkerStatus,
    pub skipped: bool,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Persist a successful scan for one registry: upsert skills and head fields,
/// soft-delete absences within this registry only and
/// update this registry's success marker. Other registries are untouched.
pub fn write_scan_to_db(
    conn: &Connection,
    registry_id: &str,
    revision: &str,
    skills: &[ScannedSkill],
) -> Result<SyncWriteResult, GitError> {
    let at = now();
    let status = if skills.is_empty() {
        SyncMarkerStatus::Empty
    } else {
        SyncMarkerStatus::Ok
    };

    transaction(conn, || -> Result<(), rusqlite::Error> {
        let mut upsert_skill = conn.prepare(
            "INSERT INTO skill (
               registry_id, folder_name, name, description, skill_path,
               head_content_hash, head_provenance_sha, head_updated_at,
               soft_deleted, last_seen_revision, last_seen_at
             ) VALUES (
               :registry_id, :folder_name, :name, :description, :skill_path,
               :head_content_hash, :head_provenance_sha, :head_updated_at,
               0, :last_seen_revision, :last_seen_at
             )
             ON CONFLICT(registry_id, folder_name) DO UPDATE SET
               name = excluded.name,
               description = excluded.description,
               skill_path = excluded.skill_path,
               head_content_hash = excluded.head_content_hash,
               head_provenance_sha = excluded.head_provenance_sha,
               head_updated_at = excluded.head_updated_at,
               soft_deleted = 0,
               last_seen_revision = excluded.last_seen_revision,
               last_seen_at = excluded.last_seen_at",
        )?;
        for skill in skills {
            upsert_skill.execute(named_params! {
                ":registry_id": registry_id,
                ":folder_name": skill.id,
                ":name": skill.name,
                ":description": skill.description,
                ":skill_path": skill.skill_path,
                ":head_content_hash": skill.content_hash,
                ":head_provenance_sha": skill.provenance_sha,
                ":head_updated_at": skill.updated_at,
                ":last_seen_revision": revision,
                ":last_seen_at": at,
            })?;
        }

        let present: HashSet<&str> = skills.iter().map(|skill| skill.id.as_str()).collect();
        if present.is_empty() {
            conn.execute(
                "UPDATE skill SET soft_deleted = 1 WHERE registry_id = ?1 AND soft_deleted = 0",
                [registry_id],
            )?;
        } else {
            let folders = serde_json::to_string(&present.into_iter().collect::<Vec<_>>())
                .unwrap_or_else(|_| "[]".into());
            conn.execute(
                "UPDATE skill SET soft_deleted = 1
                 WHERE registry_id = :registry_id
                   AND soft_deleted = 0
                   AND folder_name NOT IN (SELECT value FROM json_each(:folders))",
                named_params! { ":registry_id": registry_id, ":folders": folders },
            )?;
        }
        Ok(())
    })?;

    upsert_marker_success(conn, registry_id, revision, &at, status)?;

    Ok(SyncWriteResult {
        revision: revision.to_string(),
        visible_skill_count: skills.len() as u32,
        status,
        skipped: false,
    })
}

/// Clone or fetch and hard-reset one registry's mirror, scan it and write the
/// result to SQLite. Blocking; call from a worker thread. On error the
/// last-good catalogue is untouched; the caller records the failure marker.
pub fn sync_registry(
    conn: &Connection,
    config: &SyncRegistryConfig,
) -> Result<SyncWriteResult, GitError> {
    if config.source == RegistrySource::Local {
        let snapshot =
            super::local::snapshot_local(std::path::Path::new(&config.url), &config.mirror_path)?;
        let marker = get_marker(conn, &config.registry_id).map_err(|error| GitError {
            message: error.to_string(),
        })?;
        if let Some(marker) = marker.filter(|marker| {
            !marker.stale
                && marker.last_sync_revision.as_deref() == Some(&snapshot.revision)
                && matches!(
                    marker.status,
                    SyncMarkerStatus::Ok | SyncMarkerStatus::Empty
                )
        }) {
            upsert_marker_success(
                conn,
                &config.registry_id,
                &snapshot.revision,
                &now(),
                marker.status,
            )?;
            return Ok(SyncWriteResult {
                revision: snapshot.revision,
                visible_skill_count: snapshot.skills.len() as u32,
                status: marker.status,
                skipped: true,
            });
        }
        return write_scan_to_db(
            conn,
            &config.registry_id,
            &snapshot.revision,
            &snapshot.skills,
        );
    }
    let marker = get_marker(conn, &config.registry_id)
        .map_err(|error| GitError::new(error.to_string()))?
        .filter(|marker| {
            !marker.stale
                && matches!(
                    marker.status,
                    SyncMarkerStatus::Ok | SyncMarkerStatus::Empty
                )
        });
    let (revision, skipped) = ensure_mirror_since(
        &MirrorConfig {
            url: config.url.clone(),
            branch: config.branch.clone(),
            mirror_path: config.mirror_path.clone(),
        },
        marker
            .as_ref()
            .and_then(|marker| marker.last_sync_revision.as_deref()),
    )?;
    if skipped {
        let status = marker
            .expect("skipping requires a successful marker")
            .status;
        let visible_skill_count = conn.query_row(
            "SELECT COUNT(*) FROM skill WHERE registry_id = ?1 AND soft_deleted = 0",
            [&config.registry_id],
            |row| row.get(0),
        )?;
        upsert_marker_success(conn, &config.registry_id, &revision, &now(), status)?;
        return Ok(SyncWriteResult {
            revision,
            visible_skill_count,
            status,
            skipped,
        });
    }
    let skills = scan_skills(&config.mirror_path)?;
    write_scan_to_db(conn, &config.registry_id, &revision, &skills)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;
    use crate::mirror::test_support::{
        commit_all, git as run_git, last_commit_date, make_repo, write_skill,
    };
    use crate::registries::{get_marker, insert_registry, InsertRegistryInput};
    use std::fs;
    use std::path::Path;

    fn make_remote() -> tempfile::TempDir {
        let remote = make_repo();
        run_git(remote.path(), &["config", "uploadpack.allowFilter", "true"]);
        write_skill(
            remote.path(),
            "skills/alpha",
            Some("name: alpha\ndescription: First skill"),
        );
        write_skill(
            remote.path(),
            "skills/beta",
            Some("name: beta\ndescription: Second skill"),
        );
        write_skill(remote.path(), "skills/broken", None);
        commit_all(remote.path(), "seed");
        remote
    }

    fn seed_registry(conn: &Connection, url: &str) -> String {
        insert_registry(
            conn,
            &InsertRegistryInput {
                source: RegistrySource::Git,
                url: url.to_string(),
                branch: "main".into(),
                enabled: true,
                auto_update: false,
                github_owner: None,
                github_repo: None,
                canonical_key: format!("git:{url}"),
            },
        )
        .unwrap()
        .id
    }

    struct Fixture {
        _work: tempfile::TempDir,
        conn: Connection,
        config: SyncRegistryConfig,
    }

    fn fixture(remote: &Path) -> Fixture {
        let work = tempfile::tempdir().unwrap();
        let conn = open_database(&work.path().join("cache.sqlite")).unwrap();
        let url = format!("file://{}", remote.display());
        let registry_id = seed_registry(&conn, &url);
        let config = SyncRegistryConfig {
            source: RegistrySource::Git,
            registry_id,
            url,
            branch: "main".into(),
            mirror_path: work.path().join("mirror"),
        };
        Fixture {
            _work: work,
            conn,
            config,
        }
    }

    fn folders(conn: &Connection, soft_deleted: i64) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT folder_name FROM skill WHERE soft_deleted = ?1 ORDER BY folder_name")
            .unwrap();
        stmt.query_map([soft_deleted], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn mark_skills_seen(conn: &Connection) {
        conn.execute("UPDATE skill SET last_seen_at = 'sentinel'", [])
            .unwrap();
    }

    fn count_unrefreshed(conn: &Connection) -> u32 {
        conn.query_row(
            "SELECT COUNT(*) FROM skill WHERE last_seen_at = 'sentinel'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn unchanged_sync_preserves_skill_rows_with_three_git_calls() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();
        mark_skills_seen(&fx.conn);
        let (result, calls) = crate::mirror::git_exec::count_git_invocations(|| {
            sync_registry(&fx.conn, &fx.config).unwrap()
        });
        assert_eq!(result.visible_skill_count, 2);
        assert!(calls <= 3, "unchanged sync used {calls} git calls");
        assert_eq!(count_unrefreshed(&fx.conn), 2);
    }

    #[test]
    fn non_skill_commits_rescan_without_changing_skill_hashes() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        let first = sync_registry(&fx.conn, &fx.config).unwrap();
        let hashes = || -> Vec<String> {
            fx.conn
                .prepare("SELECT head_content_hash FROM skill ORDER BY folder_name")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        let before = hashes();
        mark_skills_seen(&fx.conn);
        fs::write(
            remote.path().join("README.md"),
            "only documentation changed",
        )
        .unwrap();
        commit_all(remote.path(), "docs");
        let next = sync_registry(&fx.conn, &fx.config).unwrap();
        assert!(!next.skipped);
        assert_ne!(first.revision, next.revision);
        assert_eq!(hashes(), before);
        assert_eq!(count_unrefreshed(&fx.conn), 0);
    }

    #[test]
    fn unchanged_head_rescans_after_a_failed_sync() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();
        let broken = SyncRegistryConfig {
            source: RegistrySource::Git,
            url: format!("file://{}", fx._work.path().join("missing").display()),
            ..fx.config.clone()
        };
        assert!(sync_registry(&fx.conn, &broken).is_err());
        crate::mirror::catalogue::record_sync_failure(
            &fx.conn,
            &fx.config.registry_id,
            SyncMarkerStatus::Offline,
        )
        .unwrap();
        mark_skills_seen(&fx.conn);
        let result = sync_registry(&fx.conn, &fx.config).unwrap();
        assert!(!result.skipped);
        assert_eq!(count_unrefreshed(&fx.conn), 0);
        assert!(
            !get_marker(&fx.conn, &fx.config.registry_id)
                .unwrap()
                .unwrap()
                .stale
        );
    }

    #[test]
    fn unchanged_full_mirror_converts_and_rescans() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        let first = sync_registry(&fx.conn, &fx.config).unwrap();
        fs::remove_dir_all(&fx.config.mirror_path).unwrap();
        crate::mirror::git_exec::git_global(&[
            "clone",
            &fx.config.url,
            fx.config.mirror_path.to_str().unwrap(),
        ])
        .unwrap();
        mark_skills_seen(&fx.conn);
        let result = sync_registry(&fx.conn, &fx.config).unwrap();
        assert!(!result.skipped);
        assert_eq!(result.revision, first.revision);
        assert!(crate::mirror::git::is_partial_sparse_mirror(
            &fx.config.mirror_path
        ));
        assert_eq!(count_unrefreshed(&fx.conn), 0);
    }

    #[test]
    fn sparse_sync_downloads_skills_but_not_app_blobs() {
        let remote = make_remote();
        fs::create_dir_all(remote.path().join("app")).unwrap();
        fs::write(
            remote.path().join("app/main.rs"),
            "unrelated application source",
        )
        .unwrap();
        commit_all(remote.path(), "add app");
        let blob = run_git(remote.path(), &["rev-parse", "HEAD:app/main.rs"]);
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();
        assert!(!fx.config.mirror_path.join("app/main.rs").exists());
        let objects = run_git(
            &fx.config.mirror_path,
            &[
                "cat-file",
                "--batch-all-objects",
                "--batch-check=%(objectname)",
            ],
        );
        assert!(!objects.lines().any(|object| object == blob));
        assert!(fx.config.mirror_path.join("skills/alpha/SKILL.md").exists());
    }

    #[test]
    fn resync_materializes_new_skill_folders_and_their_files() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();
        write_skill(
            remote.path(),
            "skills/categories/tools/new",
            Some("name: new\ndescription: Newly added"),
        );
        fs::write(
            remote.path().join("skills/categories/tools/new/helper.txt"),
            "helper",
        )
        .unwrap();
        commit_all(remote.path(), "add new skill");
        let expected_commit = run_git(remote.path(), &["rev-parse", "HEAD"]);
        let expected_date = last_commit_date(remote.path(), None);
        sync_registry(&fx.conn, &fx.config).unwrap();
        assert_eq!(folders(&fx.conn, 0), vec!["alpha", "beta", "new"]);
        assert_eq!(
            fs::read_to_string(
                fx.config
                    .mirror_path
                    .join("skills/categories/tools/new/helper.txt")
            )
            .unwrap(),
            "helper"
        );
        let provenance: (String, String) = fx
            .conn
            .query_row(
                "SELECT head_provenance_sha, head_updated_at FROM skill WHERE folder_name = 'new'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(provenance, (expected_commit, expected_date));
    }

    #[test]
    fn retains_nested_plugin_manifests_and_groupings() {
        let remote = make_repo();
        run_git(remote.path(), &["config", "uploadpack.allowFilter", "true"]);
        fs::create_dir_all(remote.path().join(".claude-plugin")).unwrap();
        fs::write(remote.path().join(".claude-plugin/marketplace.json"), r#"{"plugins":[{"source":"./plugins/demo","name":"demo","skills":["./skills/review"]}]}"#).unwrap();
        fs::create_dir_all(remote.path().join("plugins/demo/.claude-plugin")).unwrap();
        fs::write(
            remote
                .path()
                .join("plugins/demo/.claude-plugin/plugin.json"),
            r#"{"name":"demo","skills":["./skills/review"]}"#,
        )
        .unwrap();
        write_skill(
            remote.path(),
            "plugins/demo/skills/review",
            Some("name: review\ndescription: Review"),
        );
        commit_all(remote.path(), "nested plugin");
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();
        assert!(fx
            .config
            .mirror_path
            .join("plugins/demo/.claude-plugin/plugin.json")
            .exists());
        let skills = scan_skills(&fx.config.mirror_path).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].plugin_name.as_deref(), Some("demo"));
    }

    #[test]
    fn installs_and_browses_files_from_a_partial_mirror() {
        use crate::env::Environment;
        use crate::installer::install::{install_skill, InstallDeps};
        use crate::mirror::skill_files::{list_skill_files, read_skill_file, SkillFilesDeps};
        use crate::types::{InstallRequest, SkillFileReadRequest, SkillFileRequest, TargetOutcome};

        let remote = make_remote();
        fs::write(
            remote.path().join("skills/alpha/helper.txt"),
            "helper contents",
        )
        .unwrap();
        commit_all(remote.path(), "add helper");
        let fx = fixture(remote.path());
        let synced = sync_registry(&fx.conn, &fx.config).unwrap();
        assert!(crate::mirror::git::is_partial_sparse_mirror(
            &fx.config.mirror_path
        ));
        let home = tempfile::tempdir().unwrap();
        let environment = Environment::fake_home(home.path());
        let installed = install_skill(
            &InstallDeps {
                conn: &fx.conn,
                registry_id: &fx.config.registry_id,
                mirror_path: &fx.config.mirror_path,
                environment: &environment,
                current_revision: &synced.revision,
            },
            &InstallRequest {
                registry_id: fx.config.registry_id.clone(),
                folder_name: "alpha".into(),
                targets: vec!["~/.agents/skills".into()],
                mirror_revision: synced.revision.clone(),
                acknowledge_stale: None,
            },
        )
        .unwrap();
        assert_eq!(installed.per_target[0].outcome, TargetOutcome::Installed);
        assert_eq!(
            fs::read_to_string(home.path().join(".agents/skills/alpha/helper.txt")).unwrap(),
            "helper contents"
        );
        let mirror = |_: &str| fx.config.mirror_path.clone();
        let deps = SkillFilesDeps {
            conn: &fx.conn,
            mirror_path_for: &mirror,
        };
        let files = list_skill_files(
            &deps,
            &SkillFileRequest {
                registry_id: fx.config.registry_id.clone(),
                folder_name: "alpha".into(),
            },
        )
        .unwrap();
        assert!(files.files.iter().any(|file| file.path == "helper.txt"));
        let content = read_skill_file(
            &deps,
            &SkillFileReadRequest {
                registry_id: fx.config.registry_id.clone(),
                folder_name: "alpha".into(),
                path: "helper.txt".into(),
            },
        )
        .unwrap();
        assert_eq!(content.content.as_deref(), Some("helper contents"));
    }

    #[test]
    fn clones_scans_and_writes_sqlite_skipping_malformed() {
        let remote = make_remote();
        let fx = fixture(remote.path());

        let result = sync_registry(&fx.conn, &fx.config).unwrap();
        assert_eq!(result.status, SyncMarkerStatus::Ok);
        assert_eq!(result.visible_skill_count, 2);
        assert_eq!(
            result.revision,
            run_git(remote.path(), &["rev-parse", "HEAD"])
        );
        assert_eq!(folders(&fx.conn, 0), vec!["alpha", "beta"]);

        let marker = get_marker(&fx.conn, &fx.config.registry_id)
            .unwrap()
            .unwrap();
        assert_eq!(marker.status, SyncMarkerStatus::Ok);
        assert_eq!(
            marker.last_sync_revision.as_deref(),
            Some(result.revision.as_str())
        );
    }

    #[test]
    fn hard_resets_on_resync_and_soft_deletes_removed_skills() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();

        fs::remove_file(remote.path().join("skills/beta/SKILL.md")).unwrap();
        fs::write(
            remote.path().join("skills/beta/leftover.txt"),
            "no longer a skill",
        )
        .unwrap();
        commit_all(remote.path(), "remove beta");
        sync_registry(&fx.conn, &fx.config).unwrap();

        assert_eq!(folders(&fx.conn, 0), vec!["alpha"]);
        assert_eq!(folders(&fx.conn, 1), vec!["beta"]);
        assert!(!fx.config.mirror_path.join("skills/beta").exists());
    }

    #[test]
    fn restoring_a_removed_skill_clears_its_soft_delete() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();
        fs::remove_dir_all(remote.path().join("skills/beta")).unwrap();
        commit_all(remote.path(), "remove beta");
        sync_registry(&fx.conn, &fx.config).unwrap();
        write_skill(
            remote.path(),
            "skills/beta",
            Some("name: beta\ndescription: Back"),
        );
        commit_all(remote.path(), "restore beta");
        sync_registry(&fx.conn, &fx.config).unwrap();

        assert_eq!(folders(&fx.conn, 0), vec!["alpha", "beta"]);
    }

    #[test]
    fn an_empty_remote_soft_deletes_everything_and_marks_empty() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();
        fs::remove_dir_all(remote.path().join("skills")).unwrap();
        fs::write(remote.path().join("README.md"), "empty").unwrap();
        commit_all(remote.path(), "empty");

        let result = sync_registry(&fx.conn, &fx.config).unwrap();
        assert_eq!(result.status, SyncMarkerStatus::Empty);
        assert!(folders(&fx.conn, 0).is_empty());
    }

    #[test]
    fn preserves_the_last_good_catalogue_when_a_later_sync_fails() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();

        let broken = SyncRegistryConfig {
            source: RegistrySource::Git,
            url: fx
                .config
                .mirror_path
                .join("does-not-exist")
                .to_string_lossy()
                .to_string(),
            ..fx.config.clone()
        };
        assert!(sync_registry(&fx.conn, &broken).is_err());
        assert_eq!(folders(&fx.conn, 0), vec!["alpha", "beta"]);

        crate::mirror::catalogue::record_sync_failure(
            &fx.conn,
            &fx.config.registry_id,
            SyncMarkerStatus::Offline,
        )
        .unwrap();
        let marker = get_marker(&fx.conn, &fx.config.registry_id)
            .unwrap()
            .unwrap();
        assert_eq!(marker.status, SyncMarkerStatus::Offline);
        assert!(marker.stale);
        assert!(marker.last_sync_revision.is_some());
    }

    #[test]
    fn persists_skill_path_for_nested_layouts() {
        let remote = make_repo();
        run_git(remote.path(), &["config", "uploadpack.allowFilter", "true"]);
        write_skill(
            remote.path(),
            "skills/engineering/code-review",
            Some("name: code-review\ndescription: Review code"),
        );
        commit_all(remote.path(), "nested seed");
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();

        let path: String = fx
            .conn
            .query_row(
                "SELECT skill_path FROM skill WHERE folder_name = 'code-review'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(path, "skills/engineering/code-review");
    }

    #[test]
    fn syncs_nested_skills_after_a_category_folder_move() {
        let remote = make_repo();
        run_git(remote.path(), &["config", "uploadpack.allowFilter", "true"]);
        write_skill(
            remote.path(),
            "skills/productivity/teach",
            Some("name: teach\ndescription: Teach things"),
        );
        commit_all(remote.path(), "add teach");
        fs::create_dir_all(remote.path().join("skills/in-progress")).unwrap();
        run_git(
            remote.path(),
            &[
                "mv",
                "skills/productivity/teach",
                "skills/in-progress/teach",
            ],
        );
        run_git(remote.path(), &["commit", "-m", "move teach"]);
        run_git(
            remote.path(),
            &[
                "mv",
                "skills/in-progress/teach",
                "skills/productivity/teach",
            ],
        );
        run_git(remote.path(), &["commit", "-m", "move teach back"]);
        let fx = fixture(remote.path());

        let result = sync_registry(&fx.conn, &fx.config).unwrap();
        assert_eq!(result.status, SyncMarkerStatus::Ok);
        assert_eq!(result.visible_skill_count, 1);
        assert_eq!(folders(&fx.conn, 0), vec!["teach"]);
    }
}

#[cfg(test)]
mod local_sync_tests {
    use super::*;

    #[test]
    fn unchanged_local_sync_skips_without_git_and_preserves_catalogue_dates() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir_all(&source).unwrap();
        crate::mirror::test_support::write_skill(
            &source,
            "alpha",
            Some("name: alpha\ndescription: Draft"),
        );
        let conn = crate::db::open_database(&root.path().join("db.sqlite")).unwrap();
        let registry = crate::registries::insert_registry(
            &conn,
            &crate::registries::InsertRegistryInput {
                source: RegistrySource::Local,
                url: source.to_string_lossy().into_owned(),
                branch: String::new(),
                enabled: true,
                auto_update: false,
                github_owner: None,
                github_repo: None,
                canonical_key: "local:test".into(),
            },
        )
        .unwrap();
        let config = SyncRegistryConfig {
            source: RegistrySource::Local,
            registry_id: registry.id,
            url: source.to_string_lossy().into_owned(),
            branch: String::new(),
            mirror_path: root.path().join("mirror"),
        };
        let first = sync_registry(&conn, &config).unwrap();
        conn.execute("UPDATE skill SET last_seen_at = 'sentinel'", [])
            .unwrap();
        let skill = source.join("alpha/SKILL.md");
        let contents = std::fs::read(&skill).unwrap();
        std::fs::write(skill, contents).unwrap();
        let (next, calls) = crate::mirror::git_exec::count_git_invocations(|| {
            sync_registry(&conn, &config).unwrap()
        });
        assert!(next.skipped);
        assert_eq!(next.revision, first.revision);
        assert_eq!(calls, 0);
        assert_eq!(
            conn.query_row("SELECT last_seen_at FROM skill", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "sentinel"
        );
    }
}
