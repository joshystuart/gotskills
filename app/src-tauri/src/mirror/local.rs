use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use super::discovery::skills::{discover_skills, DiscoverSkillsOptions};
use super::scan::{locale_compare, ScannedSkill};
use crate::installer::copy::{copy_tree, paths_overlap};

/// A complete Local Registry snapshot and its content revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSnapshot {
    pub skills: Vec<ScannedSkill>,
    pub revision: String,
}

fn hash_field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}

fn hash_tree(root: &Path, directory: &Path, hash: &mut Sha256) -> io::Result<SystemTime> {
    let mut entries = fs::read_dir(directory)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut newest = SystemTime::UNIX_EPOCH;
    for entry in entries {
        let path = entry.path();
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            newest = newest.max(hash_tree(root, &path, hash)?);
        } else {
            let relative = path.strip_prefix(root).map_err(io::Error::other)?;
            hash_field(
                hash,
                relative.to_string_lossy().replace('\\', "/").as_bytes(),
            );
            hash.update(metadata.len().to_be_bytes());
            let mut file = fs::File::open(&path)?;
            let mut buffer = [0; 65536];
            loop {
                let length = file.read(&mut buffer)?;
                if length == 0 {
                    break;
                }
                hash.update(&buffer[..length]);
            }
            newest = newest.max(metadata.modified()?);
        }
    }
    Ok(newest)
}

/// Copy discovered skills into a last-good mirror without invoking Git.
pub fn snapshot_local(source: &Path, destination: &Path) -> io::Result<LocalSnapshot> {
    let source_path = fs::canonicalize(source)?;
    let source = source_path.as_path();
    fs::read_dir(source)?;
    if paths_overlap(source, destination) {
        return Err(io::Error::other("Snapshot source and destination overlap"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::other("Missing destination parent"))?;
    fs::create_dir_all(parent)?;
    let suffix = uuid::Uuid::new_v4();
    let staging = destination.with_extension(format!("snapshot-{suffix}"));
    let result = (|| {
        fs::create_dir(&staging)?;
        let discovered = discover_skills(source, None, DiscoverSkillsOptions::default())
            .map_err(io::Error::other)?;
        let mut skills = Vec::new();
        for skill in discovered {
            let relative = skill.path.strip_prefix(source).map_err(io::Error::other)?;
            let copied = staging.join(relative);
            copy_tree(&skill.path, &copied, true)?;
            let mut hash = Sha256::new();
            let updated = hash_tree(&copied, &copied, &mut hash)?;
            let content_hash = format!("{:x}", hash.finalize());
            skills.push(ScannedSkill {
                id: skill.name.clone(),
                skill_path: relative.to_string_lossy().replace('\\', "/"),
                name: skill.name,
                description: skill.description,
                provenance_sha: content_hash[..7].to_string(),
                content_hash,
                updated_at: chrono::DateTime::<chrono::Utc>::from(updated)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                plugin_name: skill.plugin_name,
            });
        }
        skills.sort_by(|a, b| locale_compare(&a.id, &b.id));
        let mut revision = Sha256::new();
        let mut by_path: Vec<_> = skills.iter().collect();
        by_path.sort_by(|a, b| a.skill_path.cmp(&b.skill_path));
        for skill in by_path {
            hash_field(&mut revision, skill.skill_path.as_bytes());
            hash_field(&mut revision, skill.content_hash.as_bytes());
        }
        let snapshot = LocalSnapshot {
            skills,
            revision: format!("{:x}", revision.finalize()),
        };
        if destination.exists() {
            let backup = destination.with_extension(format!("backup-{suffix}"));
            fs::rename(destination, &backup)?;
            if let Err(error) = fs::rename(&staging, destination) {
                fs::rename(&backup, destination)?;
                return Err(error);
            }
            let _ = fs::remove_dir_all(backup);
        } else {
            fs::rename(&staging, destination)?;
        }
        Ok(snapshot)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn write(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn skill(root: &Path, path: &str, name: &str) {
        write(
            root,
            &format!("{path}/SKILL.md"),
            &format!("---\nname: {name}\ndescription: Example\n---\nBody"),
        );
    }

    #[test]
    fn snapshots_nested_skills_without_git() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("mirror");
        skill(&source, "skills/alpha", "alpha");
        skill(&source, "skills/team/beta", "beta");
        write(&source, "skills/alpha/assets/example.txt", "example");
        let (result, count) = crate::mirror::git_exec::count_git_invocations(|| {
            snapshot_local(&source, &destination)
        });
        let snapshot = result.unwrap();
        assert_eq!(count, 0);
        assert_eq!(snapshot.skills.len(), 2);
        assert_eq!(snapshot.skills[0].id, "alpha");
        assert_eq!(snapshot.skills[0].skill_path, "skills/alpha");
        assert_eq!(snapshot.skills[0].description, "Example");
        assert_eq!(
            snapshot.skills[0].provenance_sha,
            snapshot.skills[0].content_hash[..7]
        );
        assert_eq!(
            fs::read_to_string(destination.join("skills/alpha/assets/example.txt")).unwrap(),
            "example"
        );
    }
    #[test]
    fn exclusions_do_not_change_the_hash_or_enter_the_copy() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("mirror");
        skill(&source, ".", "root");
        let before = snapshot_local(&source, &destination).unwrap();
        for path in [
            ".DS_Store",
            "assets/.DS_Store",
            ".git/config",
            "metadata.json",
            "__pycache__/a.pyc",
            "__pypackages__/a",
        ] {
            write(&source, path, "ignored");
        }
        let after = snapshot_local(&source, &destination).unwrap();
        assert_eq!(before.revision, after.revision);
        assert_eq!(before.skills[0].content_hash, after.skills[0].content_hash);
        for path in [
            ".DS_Store",
            "assets/.DS_Store",
            ".git",
            "metadata.json",
            "__pycache__",
            "__pypackages__",
        ] {
            assert!(!destination.join(path).exists(), "{path}");
        }
    }

    #[test]
    fn updated_date_uses_the_newest_copied_file_time() {
        use std::time::Duration;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("mirror");
        skill(&source, ".", "root");
        write(&source, "assets/file.txt", "data");
        write(&source, ".DS_Store", "ignored");
        for (path, seconds) in [
            ("SKILL.md", 1_700_000_000),
            ("assets/file.txt", 1_700_000_100),
        ] {
            fs::File::options()
                .write(true)
                .open(source.join(path))
                .unwrap()
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
                )
                .unwrap();
        }
        let snapshot = snapshot_local(&source, &destination).unwrap();
        assert_eq!(snapshot.skills[0].skill_path, "");
        assert_eq!(snapshot.skills[0].updated_at, "2023-11-14T22:15:00.000Z");
    }

    #[test]
    fn content_and_paths_define_revisions_while_timestamps_do_not() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("mirror");
        skill(&source, "skills/alpha", "alpha");
        let first = snapshot_local(&source, &destination).unwrap();
        assert_eq!(
            snapshot_local(&source, &destination).unwrap().revision,
            first.revision
        );
        let file = fs::File::options()
            .write(true)
            .open(source.join("skills/alpha/SKILL.md"))
            .unwrap();
        file.set_times(fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
            .unwrap();
        assert_eq!(
            snapshot_local(&source, &destination).unwrap().revision,
            first.revision
        );
        write(&source, "skills/alpha/real.txt", "one");
        let added = snapshot_local(&source, &destination).unwrap();
        assert_ne!(added.skills[0].content_hash, first.skills[0].content_hash);
        assert_ne!(added.revision, first.revision);
        write(&source, "skills/alpha/real.txt", "two");
        let edited = snapshot_local(&source, &destination).unwrap();
        assert_ne!(edited.revision, added.revision);
        fs::rename(
            source.join("skills/alpha/real.txt"),
            source.join("skills/alpha/moved.txt"),
        )
        .unwrap();
        let renamed_file = snapshot_local(&source, &destination).unwrap();
        assert_ne!(renamed_file.revision, edited.revision);
        fs::rename(source.join("skills/alpha"), source.join("skills/renamed")).unwrap();
        let renamed_skill = snapshot_local(&source, &destination).unwrap();
        assert_eq!(
            renamed_skill.skills[0].content_hash,
            renamed_file.skills[0].content_hash
        );
        assert_ne!(renamed_skill.revision, renamed_file.revision);
        fs::remove_dir_all(source.join("skills/renamed")).unwrap();
        assert_ne!(
            snapshot_local(&source, &destination).unwrap().revision,
            renamed_skill.revision
        );
        assert!(!destination.join("skills/renamed").exists());
    }

    #[cfg(unix)]
    #[test]
    fn follows_file_and_directory_symlinks_and_skips_broken_links() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("mirror");
        skill(&source, ".", "root");
        write(root.path(), "external/data.txt", "linked content");
        symlink(
            root.path().join("external/data.txt"),
            source.join("linked.txt"),
        )
        .unwrap();
        symlink(root.path().join("external"), source.join("linked-dir")).unwrap();
        symlink(root.path().join("external"), source.join(".git")).unwrap();
        let before = snapshot_local(&source, &destination).unwrap();
        symlink(root.path().join("absent"), source.join("broken")).unwrap();
        let after = snapshot_local(&source, &destination).unwrap();
        assert_eq!(before.revision, after.revision);
        for path in ["linked.txt", "linked-dir/data.txt"] {
            assert_eq!(
                fs::read_to_string(destination.join(path)).unwrap(),
                "linked content"
            );
            assert!(!fs::symlink_metadata(destination.join(path))
                .unwrap()
                .file_type()
                .is_symlink());
        }
        assert!(!destination.join("broken").exists());
        assert!(!destination.join(".git").exists());
    }

    #[test]
    fn missing_source_keeps_the_last_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("mirror");
        skill(&source, ".", "root");
        snapshot_local(&source, &destination).unwrap();
        let before = fs::read(destination.join("SKILL.md")).unwrap();
        fs::remove_dir_all(&source).unwrap();
        assert!(snapshot_local(&source, &destination).is_err());
        assert_eq!(fs::read(destination.join("SKILL.md")).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_source_or_failed_copy_keeps_the_last_snapshot() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("mirror");
        skill(&source, ".", "root");
        snapshot_local(&source, &destination).unwrap();
        let before = fs::read(destination.join("SKILL.md")).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o000)).unwrap();
        let result = snapshot_local(&source, &destination);
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read(destination.join("SKILL.md")).unwrap(), before);
        write(&source, "new.txt", "not copied");
        fs::set_permissions(source.join("new.txt"), fs::Permissions::from_mode(0o000)).unwrap();
        let result = snapshot_local(&source, &destination);
        fs::set_permissions(source.join("new.txt"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read(destination.join("SKILL.md")).unwrap(), before);
        assert!(!destination.join("new.txt").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }
}
