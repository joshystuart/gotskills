//! Native replacement for `skills add <dir> --skill X -g -a <agent> -y --copy`.
//!
//! Mirrors the vendored CLI (1.7.0) copy semantics: the destination is removed
//! and recreated, `metadata.json` files and `.git`, `__pycache__` and
//! `__pypackages__` directories are skipped, symlinks are dereferenced (broken
//! ones skipped) and file permissions are preserved. For a local source the
//! CLI wrote no global lock file, so none is written here.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

const EXCLUDED_FILES: [&str; 1] = ["metadata.json"];
const EXCLUDED_DIRS: [&str; 3] = [".git", "__pycache__", "__pypackages__"];

fn is_excluded(name: &str, is_dir: bool) -> bool {
    EXCLUDED_FILES.contains(&name) || (is_dir && EXCLUDED_DIRS.contains(&name))
}

/// Copy `src` into `dest`, creating `dest`. With `filter`, the CLI exclusions apply.
pub fn copy_tree(src: &Path, dest: &Path, filter: bool) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        let is_dir = entry.file_type()?.is_dir();
        if filter && is_excluded(&name_text, is_dir) {
            continue;
        }
        let from = entry.path();
        let to = dest.join(&name);
        let Ok(metadata) = fs::metadata(&from) else {
            continue;
        };
        if metadata.is_dir() {
            copy_tree(&from, &to, filter)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn remove_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn normalise(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether either path contains the other.
pub fn paths_overlap(a: &Path, b: &Path) -> bool {
    let (a, b) = (normalise(a), normalise(b));
    a.starts_with(&b) || b.starts_with(&a)
}

/// Whether `folder_name` is a single safe path segment.
pub fn is_safe_folder_name(folder_name: &str) -> bool {
    let mut components = Path::new(folder_name).components();
    matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    ) && !folder_name.contains('\\')
}

/// What [`install_copy`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyOutcome {
    Copied,
    SkippedOverlap,
}

/// Replace `dest` with a filtered copy of the skill at `skill_dir`. Source and
/// destination that contain one another are left untouched.
pub fn install_copy(skill_dir: &Path, dest: &Path) -> io::Result<CopyOutcome> {
    if paths_overlap(skill_dir, dest) {
        return Ok(CopyOutcome::SkippedOverlap);
    }
    remove_path(dest)?;
    copy_tree(skill_dir, dest, true)?;
    Ok(CopyOutcome::Copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn copies_files_and_skips_cli_exclusions() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        write(&src.join("SKILL.md"), "body");
        write(&src.join("sub/deep.txt"), "deep");
        write(&src.join("metadata.json"), "{}");
        write(&src.join("sub/metadata.json"), "{}");
        write(&src.join(".git/config"), "x");
        write(&src.join("__pycache__/a.pyc"), "x");
        let dest = root.path().join("dest");
        write(&dest.join("stale.txt"), "old");

        assert_eq!(install_copy(&src, &dest).unwrap(), CopyOutcome::Copied);

        assert_eq!(fs::read_to_string(dest.join("SKILL.md")).unwrap(), "body");
        assert_eq!(
            fs::read_to_string(dest.join("sub/deep.txt")).unwrap(),
            "deep"
        );
        for gone in [
            "stale.txt",
            "metadata.json",
            "sub/metadata.json",
            ".git",
            "__pycache__",
        ] {
            assert!(!dest.join(gone).exists(), "{gone}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn dereferences_symlinks_and_skips_broken_ones() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        write(&src.join("real.txt"), "real");
        fs::set_permissions(src.join("real.txt"), fs::Permissions::from_mode(0o750)).unwrap();
        symlink(src.join("real.txt"), src.join("link.txt")).unwrap();
        symlink(src.join("missing"), src.join("broken")).unwrap();
        let dest = root.path().join("dest");

        install_copy(&src, &dest).unwrap();

        let link = fs::symlink_metadata(dest.join("link.txt")).unwrap();
        assert!(link.is_file());
        assert_eq!(fs::read_to_string(dest.join("link.txt")).unwrap(), "real");
        assert!(!dest.join("broken").exists());
        let mode = fs::metadata(dest.join("real.txt"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o750);
    }

    #[test]
    fn overlapping_source_and_destination_are_left_alone() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("alpha");
        write(&src.join("SKILL.md"), "body");
        assert_eq!(
            install_copy(&src, &src).unwrap(),
            CopyOutcome::SkippedOverlap
        );
        assert!(src.join("SKILL.md").exists());
    }

    #[test]
    fn folder_names_must_be_a_single_segment() {
        assert!(is_safe_folder_name("alpha"));
        for bad in ["", "..", "a/b", "../x", "/abs", "a\\b", "."] {
            assert!(!is_safe_folder_name(bad), "{bad}");
        }
    }
}
