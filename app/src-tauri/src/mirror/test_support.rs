use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

pub fn make_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-b", "main"]);
    git(dir.path(), &["config", "user.email", "test@example.com"]);
    git(dir.path(), &["config", "user.name", "Test"]);
    dir
}

pub fn commit_all(root: &Path, message: &str) {
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", message]);
}

pub fn write_skill(root: &Path, relative_dir: &str, frontmatter: Option<&str>) {
    let dir: PathBuf = root.join(relative_dir);
    fs::create_dir_all(&dir).unwrap();
    let content = match frontmatter {
        Some(frontmatter) => format!("---\n{frontmatter}\n---\n\n# Skill\n"),
        None => "# Skill\n".to_string(),
    };
    fs::write(dir.join("SKILL.md"), content).unwrap();
}

/// Last commit date, optionally limited to a path, as the scanner formats it, whatever git's ISO style.
pub fn last_commit_date(cwd: &Path, path: Option<&str>) -> String {
    let mut args = vec!["log", "-1", "--format=%cI"];
    if let Some(path) = path {
        args.extend(["--", path]);
    }
    chrono::DateTime::parse_from_rfc3339(&git(cwd, &args))
        .expect("strict ISO commit date")
        .format("%Y-%m-%dT%H:%M:%S%:z")
        .to_string()
}
