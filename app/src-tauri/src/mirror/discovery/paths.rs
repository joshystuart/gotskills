use std::path::{Component, Path, PathBuf};

/// Lexically normalise a path, resolving `.` and `..` like Node's `path.normalize`.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(out.components().next_back(), Some(Component::Normal(_)));
                if can_pop {
                    out.pop();
                } else if !out.has_root() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// Join and normalise, like Node's `path.join`.
pub fn njoin(base: &Path, rel: impl AsRef<Path>) -> PathBuf {
    normalize(&base.join(rel))
}

/// Absolute, normalised form of `path` (relative paths resolve against the cwd).
pub fn resolve(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize(path)
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        normalize(&cwd.join(path))
    }
}

/// Whether `target` is inside (or equal to) `base`.
pub fn is_contained_in(target: &Path, base: &Path) -> bool {
    resolve(target).starts_with(resolve(base))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_dots_and_parents() {
        assert_eq!(normalize(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
        assert_eq!(
            njoin(Path::new("/a"), "./skills/x"),
            PathBuf::from("/a/skills/x")
        );
        assert_eq!(normalize(Path::new("/../a")), PathBuf::from("/a"));
    }

    #[test]
    fn containment_rejects_escapes() {
        assert!(is_contained_in(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(is_contained_in(Path::new("/a/b"), Path::new("/a/b")));
        assert!(!is_contained_in(Path::new("/a/b/../c"), Path::new("/a/b")));
        assert!(!is_contained_in(Path::new("/a/bc"), Path::new("/a/b")));
    }
}
