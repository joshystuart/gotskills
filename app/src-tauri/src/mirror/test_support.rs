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
