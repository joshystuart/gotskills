use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use regex::Regex;

use super::git_exec::{git, git_global, GitError};

/// True when a usable `git` binary is on PATH (Xcode CLT / Homebrew).
pub fn is_git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn default_branch_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?m)^ref:\s+refs/heads/(\S+)\s+HEAD$").expect("valid default branch pattern")
    })
}

/// Ask the remote for its default branch without cloning. Errors when the
/// remote is inaccessible so the caller can require an explicit branch.
pub fn detect_default_branch(url: &str) -> Result<String, GitError> {
    let out = git_global(&["ls-remote", "--symref", url, "HEAD"])?;
    default_branch_pattern()
        .captures(&out)
        .map(|captures| captures[1].to_string())
        .ok_or_else(|| GitError::new("Unable to determine the default branch for this registry"))
}

/// Where and what to mirror.
#[derive(Debug, Clone)]
pub struct MirrorConfig {
    pub url: String,
    pub branch: String,
    pub mirror_path: PathBuf,
}

/// Ensure a local working-tree mirror of `{url, branch}`: clone on first use,
/// thereafter fetch and hard-reset to `origin/<branch>` (never merge). An
/// existing mirror fetches with an explicit refspec because a `--single-branch`
/// clone of another branch has no `origin/<branch>` ref. Returns the HEAD sha.
pub fn ensure_mirror(config: &MirrorConfig) -> Result<String, GitError> {
    let MirrorConfig {
        url,
        branch,
        mirror_path,
    } = config;
    if let Some(parent) = mirror_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let path: &Path = mirror_path;
    let origin_branch = format!("origin/{branch}");

    if !path.exists() {
        fs::create_dir_all(path)?;
        let path_text = path.to_string_lossy();
        git_global(&[
            "clone",
            "--branch",
            branch,
            "--single-branch",
            url,
            &path_text,
        ])?;
        git(path, &["fetch", "origin", branch])?;
        git(path, &["reset", "--hard", &origin_branch])?;
    } else {
        git(path, &["remote", "set-url", "origin", url])?;
        let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
        git(path, &["fetch", "origin", &refspec])?;
        git(path, &["checkout", "-B", branch, &origin_branch])?;
        git(path, &["reset", "--hard", &origin_branch])?;
    }

    git(path, &["rev-parse", "HEAD"])
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn run_git(cwd: &Path, args: &[&str]) -> String {
        git(cwd, args).expect("git command")
    }

    fn init_remote() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run_git(dir.path(), &["init", "-b", "main"]);
        run_git(dir.path(), &["config", "user.email", "test@example.com"]);
        run_git(dir.path(), &["config", "user.name", "Test"]);
        fs::write(dir.path().join("a.txt"), "one").unwrap();
        run_git(dir.path(), &["add", "."]);
        run_git(dir.path(), &["commit", "-m", "seed"]);
        dir
    }

    #[test]
    fn git_is_available_in_the_test_environment() {
        assert!(is_git_available());
    }

    #[test]
    fn detects_the_default_branch_of_a_local_remote() {
        let remote = init_remote();
        let url = remote.path().to_string_lossy().to_string();
        assert_eq!(detect_default_branch(&url).unwrap(), "main");
    }

    #[test]
    fn clones_then_hard_resets_to_the_remote_head() {
        let remote = init_remote();
        let work = tempfile::tempdir().unwrap();
        let config = MirrorConfig {
            url: remote.path().to_string_lossy().to_string(),
            branch: "main".into(),
            mirror_path: work.path().join("mirror"),
        };
        let first = ensure_mirror(&config).unwrap();
        assert_eq!(first, run_git(remote.path(), &["rev-parse", "HEAD"]));

        fs::write(remote.path().join("a.txt"), "two").unwrap();
        run_git(remote.path(), &["commit", "-am", "second"]);

        let second = ensure_mirror(&config).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            fs::read_to_string(config.mirror_path.join("a.txt")).unwrap(),
            "two"
        );
    }

    #[test]
    fn fails_for_a_missing_remote() {
        let work = tempfile::tempdir().unwrap();
        let config = MirrorConfig {
            url: work.path().join("nope").to_string_lossy().to_string(),
            branch: "main".into(),
            mirror_path: work.path().join("mirror"),
        };
        assert!(ensure_mirror(&config).is_err());
    }
}
