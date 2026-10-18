//! Startup migration of legacy symlink installs into independent copies.

use std::fs;
use std::io;
use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;
use crate::types::{InstallMethod, InstallRecord};

use super::copy::copy_tree;
use super::records::{read_install_records, read_occupancy, upsert_install_record};
use super::targets::{target_install_path, SHARED_TARGET};

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

fn resolves_to(link: &Path, target: &Path) -> bool {
    match (fs::canonicalize(link), fs::canonicalize(target)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn replace_link_with_copy(link: &Path) -> io::Result<()> {
    let mut staging = link.as_os_str().to_owned();
    staging.push(".gotskills-copy");
    let staging = std::path::PathBuf::from(staging);
    if is_symlink(link) {
        remove_tree(&staging)?;
        copy_tree(&fs::canonicalize(link)?, &staging, false)?;
        fs::remove_file(link)?;
    }
    if !link.exists() && staging.exists() {
        fs::rename(&staging, link)?;
    }
    Ok(())
}

fn copy_record(record: &InstallRecord, target: &str, path: &Path) -> InstallRecord {
    InstallRecord {
        target: target.to_string(),
        method: InstallMethod::Copy,
        paths: vec![path.to_string_lossy().into_owned()],
        ..record.clone()
    }
}

fn convert_own_folder(conn: &Connection, home: &Path, record: &InstallRecord) -> AppResult<()> {
    let own = target_install_path(home, &record.target, &record.folder_name);
    let shared = target_install_path(home, SHARED_TARGET, &record.folder_name);
    if resolves_to(&own, &shared)
        && read_occupancy(conn, SHARED_TARGET, &record.folder_name)?.is_none()
    {
        upsert_install_record(conn, &copy_record(record, SHARED_TARGET, &shared))?;
    }
    replace_link_with_copy(&own)?;
    upsert_install_record(conn, &copy_record(record, &record.target, &own))
}

fn convert_shared(conn: &Connection, home: &Path, record: &InstallRecord) -> AppResult<()> {
    let old_link = home
        .join(".cursor")
        .join("skills")
        .join(&record.folder_name);
    let shared = target_install_path(home, SHARED_TARGET, &record.folder_name);
    if is_symlink(&old_link) && resolves_to(&old_link, &shared) {
        fs::remove_file(&old_link)?;
    }
    upsert_install_record(conn, &copy_record(record, &record.target, &shared))
}

/// Turn every `symlink` install record into a real copy. Idempotent. Records
/// that cannot be converted are skipped and described in the returned warnings.
pub fn convert_symlink_installs(conn: &Connection, home: &Path) -> AppResult<Vec<String>> {
    let mut warnings = Vec::new();
    for record in read_install_records(conn, &Default::default())? {
        if record.method != InstallMethod::Symlink {
            continue;
        }
        let outcome = if record.target == SHARED_TARGET {
            convert_shared(conn, home, &record)
        } else {
            convert_own_folder(conn, home, &record)
        };
        if let Err(error) = outcome {
            warnings.push(format!(
                "could not convert {}@{}: {}",
                record.folder_name, record.target, error
            ));
        }
    }
    Ok(warnings)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::installer::records::InstallRecordFilter;
    use crate::installer::test_support::*;
    use std::os::unix::fs::symlink;

    fn skill_folder(dir: &Path, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    fn legacy(
        target: &str,
        folder: &str,
        registry: &str,
        paths: &[&Path],
        at: &str,
    ) -> InstallRecord {
        InstallRecord {
            registry_id: registry.into(),
            folder_name: folder.into(),
            target: target.into(),
            content_hash: format!("hash-{folder}"),
            provenance_sha: format!("sha-{folder}"),
            method: InstallMethod::Symlink,
            paths: paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            cli_version: "1.6.0".into(),
            installed_at: at.into(),
        }
    }

    fn sorted_records(conn: &Connection) -> Vec<InstallRecord> {
        let mut rows = read_install_records(conn, &InstallRecordFilter::default()).unwrap();
        rows.sort_by_key(|r| format!("{}/{}", r.target, r.folder_name));
        rows
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }

    #[test]
    fn turns_old_layout_symlink_installs_into_independent_copies() {
        let home = tempfile::tempdir().unwrap();
        let conn = database();
        let claude = home.path().join(".claude/skills");
        let shared = home.path().join(".agents/skills");
        let cursor = home.path().join(".cursor/skills");
        skill_folder(&shared.join("alpha"), "alpha body");
        skill_folder(&shared.join("beta"), "beta body");
        fs::create_dir_all(&claude).unwrap();
        fs::create_dir_all(&cursor).unwrap();
        symlink(shared.join("alpha"), claude.join("alpha")).unwrap();
        symlink(shared.join("beta"), cursor.join("beta")).unwrap();

        upsert_install_record(
            &conn,
            &legacy(
                "~/.claude/skills",
                "alpha",
                "reg-a",
                &[&claude.join("alpha"), &shared.join("alpha")],
                "2026-01-02T03:04:05.000Z",
            ),
        )
        .unwrap();
        upsert_install_record(
            &conn,
            &legacy(
                "~/.agents/skills",
                "beta",
                "reg-b",
                &[&cursor.join("beta"), &shared.join("beta")],
                "2026-02-03T04:05:06.000Z",
            ),
        )
        .unwrap();

        assert!(convert_symlink_installs(&conn, home.path())
            .unwrap()
            .is_empty());

        assert!(fs::symlink_metadata(claude.join("alpha")).unwrap().is_dir());
        assert_eq!(
            fs::read_to_string(claude.join("alpha/SKILL.md")).unwrap(),
            "alpha body"
        );
        assert_eq!(names(&claude), vec!["alpha"]);
        assert_eq!(names(&shared), vec!["alpha", "beta"]);
        assert!(names(&cursor).is_empty());

        let rows = sorted_records(&conn);
        let summary: Vec<_> = rows
            .iter()
            .map(|r| {
                (
                    r.target.as_str(),
                    r.folder_name.as_str(),
                    r.registry_id.as_str(),
                    r.method,
                    r.paths.clone(),
                    r.cli_version.as_str(),
                    r.installed_at.as_str(),
                )
            })
            .collect();
        let path = |p: &Path| vec![p.to_string_lossy().into_owned()];
        assert_eq!(
            summary,
            vec![
                (
                    "~/.agents/skills",
                    "alpha",
                    "reg-a",
                    InstallMethod::Copy,
                    path(&shared.join("alpha")),
                    "1.6.0",
                    "2026-01-02T03:04:05.000Z"
                ),
                (
                    "~/.agents/skills",
                    "beta",
                    "reg-b",
                    InstallMethod::Copy,
                    path(&shared.join("beta")),
                    "1.6.0",
                    "2026-02-03T04:05:06.000Z"
                ),
                (
                    "~/.claude/skills",
                    "alpha",
                    "reg-a",
                    InstallMethod::Copy,
                    path(&claude.join("alpha")),
                    "1.6.0",
                    "2026-01-02T03:04:05.000Z"
                ),
            ]
        );

        let before = sorted_records(&conn);
        assert!(convert_symlink_installs(&conn, home.path())
            .unwrap()
            .is_empty());
        assert_eq!(sorted_records(&conn), before);
        assert_eq!(names(&claude), vec!["alpha"]);
        assert!(!claude.join("alpha.gotskills-copy").exists());
    }
}
