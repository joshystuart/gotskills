//! Ported from vercel-labs/skills@1.7.0 (MIT License), read-only subset.
//! See UPSTREAM.md in this directory for maintenance notes.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

const LOCAL_LOCK_FILE: &str = "skills-lock.json";
const CURRENT_VERSION: f64 = 1.0;

/// Path of the project-scoped lock file inside `cwd`.
pub fn local_lock_path(cwd: &Path) -> PathBuf {
    cwd.join(LOCAL_LOCK_FILE)
}

/// Names of the skills recorded in the project lock file. A missing, corrupt or
/// outdated lock file yields an empty set.
pub fn read_local_lock_skill_names(cwd: &Path) -> BTreeSet<String> {
    let Ok(content) = std::fs::read_to_string(local_lock_path(cwd)) else {
        return BTreeSet::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&content) else {
        return BTreeSet::new();
    };
    let version = parsed.get("version").and_then(Value::as_f64);
    let skills = parsed.get("skills").and_then(Value::as_object);
    match (version, skills) {
        (Some(version), Some(skills)) if version >= CURRENT_VERSION => {
            skills.keys().cloned().collect()
        }
        _ => BTreeSet::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, content: &str) {
        std::fs::write(local_lock_path(dir), content).unwrap();
    }

    #[test]
    fn reads_skill_names_from_a_valid_lock() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), r#"{"version":1,"skills":{"b":{},"a":{}}}"#);
        let names: Vec<_> = read_local_lock_skill_names(dir.path())
            .into_iter()
            .collect();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn ignores_missing_corrupt_and_outdated_locks() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_local_lock_skill_names(dir.path()).is_empty());
        write(dir.path(), "<<<<<<< merge conflict");
        assert!(read_local_lock_skill_names(dir.path()).is_empty());
        write(dir.path(), r#"{"version":0,"skills":{"a":{}}}"#);
        assert!(read_local_lock_skill_names(dir.path()).is_empty());
        write(dir.path(), r#"{"version":1}"#);
        assert!(read_local_lock_skill_names(dir.path()).is_empty());
    }
}
