use std::collections::HashSet;
use std::path::PathBuf;

use rusqlite::{named_params, Connection};

use crate::db::{transaction, SyncMarkerStatus};
use crate::registries::upsert_marker_success;

use super::git::{ensure_mirror, MirrorConfig};
use super::git_exec::{git, GitError};
use super::scan::{scan_skills, ScannedSkill};

/// Inputs for syncing one registry.
#[derive(Debug, Clone)]
pub struct SyncRegistryConfig {
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
}

struct HistoryEntry {
    commit_sha: String,
    content_hash: String,
    committed_at: String,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// All commits that touched `skill_path`, oldest to newest, with the tree hash
/// at each. Rename and move commits appear in the path history without the path
/// existing at that revision, so they are skipped.
fn skill_history(
    mirror_path: &std::path::Path,
    skill_path: &str,
) -> Result<Vec<HistoryEntry>, GitError> {
    let log = git(
        mirror_path,
        &["log", "--reverse", "--format=%H%x09%cI", "--", skill_path],
    )?;
    let mut entries = Vec::new();
    for line in log.lines().filter(|line| !line.trim().is_empty()) {
        let mut parts = line.split('\t');
        let (Some(commit_sha), Some(committed_at)) = (parts.next(), parts.next()) else {
            continue;
        };
        let Ok(content_hash) = git(
            mirror_path,
            &["rev-parse", &format!("{commit_sha}:{skill_path}")],
        ) else {
            continue;
        };
        entries.push(HistoryEntry {
            commit_sha: commit_sha.to_string(),
            content_hash,
            committed_at: committed_at.to_string(),
        });
    }
    Ok(entries)
}

/// Persist a successful scan for one registry: upsert skills and head fields,
/// soft-delete absences within this registry only, append version history and
/// update this registry's success marker. Other registries are untouched.
pub fn write_scan_to_db(
    conn: &Connection,
    registry_id: &str,
    revision: &str,
    skills: &[ScannedSkill],
    mirror_path: &std::path::Path,
) -> Result<SyncWriteResult, GitError> {
    let at = now();
    let status = if skills.is_empty() {
        SyncMarkerStatus::Empty
    } else {
        SyncMarkerStatus::Ok
    };

    let mut histories = Vec::with_capacity(skills.len());
    for skill in skills {
        histories.push(skill_history(mirror_path, &skill.skill_path)?);
    }

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
        let mut upsert_version = conn.prepare(
            "INSERT INTO version (registry_id, folder_name, commit_sha, content_hash, committed_at)
             VALUES (:registry_id, :folder_name, :commit_sha, :content_hash, :committed_at)
             ON CONFLICT(registry_id, folder_name, commit_sha) DO UPDATE SET
               content_hash = excluded.content_hash,
               committed_at = excluded.committed_at",
        )?;

        for (skill, history) in skills.iter().zip(&histories) {
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
            for entry in history {
                upsert_version.execute(named_params! {
                    ":registry_id": registry_id,
                    ":folder_name": skill.id,
                    ":commit_sha": entry.commit_sha,
                    ":content_hash": entry.content_hash,
                    ":committed_at": entry.committed_at,
                })?;
            }
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
    })
}

/// Clone or fetch and hard-reset one registry's mirror, scan it and write the
/// result to SQLite. Blocking; call from a worker thread. On error the
/// last-good catalogue is untouched; the caller records the failure marker.
pub fn sync_registry(
    conn: &Connection,
    config: &SyncRegistryConfig,
) -> Result<SyncWriteResult, GitError> {
    let revision = ensure_mirror(&MirrorConfig {
        url: config.url.clone(),
        branch: config.branch.clone(),
        mirror_path: config.mirror_path.clone(),
    })?;
    let skills = scan_skills(&config.mirror_path);
    write_scan_to_db(
        conn,
        &config.registry_id,
        &revision,
        &skills,
        &config.mirror_path,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;
    use crate::mirror::test_support::{commit_all, git as run_git, make_repo, write_skill};
    use crate::registries::{get_marker, insert_registry, InsertRegistryInput};
    use std::fs;
    use std::path::Path;

    fn make_remote() -> tempfile::TempDir {
        let remote = make_repo();
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
        let url = remote.to_string_lossy().to_string();
        let registry_id = seed_registry(&conn, &url);
        let config = SyncRegistryConfig {
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

        let versions: i64 = fx
            .conn
            .query_row(
                "SELECT COUNT(DISTINCT folder_name) FROM version",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(versions, 2);
    }

    #[test]
    fn hard_resets_on_resync_and_soft_deletes_removed_skills() {
        let remote = make_remote();
        let fx = fixture(remote.path());
        sync_registry(&fx.conn, &fx.config).unwrap();

        fs::remove_dir_all(remote.path().join("skills/beta")).unwrap();
        commit_all(remote.path(), "remove beta");
        sync_registry(&fx.conn, &fx.config).unwrap();

        assert_eq!(folders(&fx.conn, 0), vec!["alpha"]);
        assert_eq!(folders(&fx.conn, 1), vec!["beta"]);
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
