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

fn sparse_paths(path: &Path, revision: &str) -> Result<Vec<String>, GitError> {
    let tree = git(path, &["ls-tree", "-r", "--name-only", "-z", revision])?;
    if tree.split('\0').any(|file| file == "SKILL.md") {
        return Ok(tree
            .split('\0')
            .filter_map(|file| {
                file.split_once('/')
                    .map(|(directory, _)| directory.to_string())
            })
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect());
    }
    let mut paths = std::collections::BTreeSet::new();
    for file in tree.split('\0') {
        let components: Vec<_> = file.split('/').collect();
        if components.last() == Some(&"SKILL.md") {
            let parent = components[..components.len() - 1].join("/");
            paths.insert(parent);
        }
        if let Some(index) = components.iter().position(|part| *part == ".claude-plugin") {
            paths.insert(components[..=index].join("/"));
        }
    }
    Ok(paths.into_iter().collect())
}

fn apply_sparse_paths(path: &Path, revision: &str) -> Result<(), GitError> {
    let paths = sparse_paths(path, revision)?;
    let mut args = vec!["sparse-checkout", "set", "--cone", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(path, &args)?;
    Ok(())
}

/// Whether a mirror has both blob filtering and sparse checkout enabled.
pub fn is_partial_sparse_mirror(path: &Path) -> bool {
    let config = ["config", "config.worktree"]
        .iter()
        .filter_map(|name| fs::read_to_string(path.join(".git").join(name)).ok())
        .collect::<Vec<_>>()
        .join("\n");
    config.lines().any(|line| {
        line.trim()
            .eq_ignore_ascii_case("partialclonefilter = blob:none")
    }) && config
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("sparseCheckout = true"))
}

fn unsupported_partial_clone(error: &GitError) -> bool {
    let message = error.message.to_lowercase();
    (message.contains("unknown option")
        || message.contains("unknown switch")
        || message.contains("is not a git command"))
        && (message.contains("filter") || message.contains("sparse"))
}

fn clone_mirror(config: &MirrorConfig, path: &Path) -> Result<(), GitError> {
    clone_mirror_with(config, path, |cwd, args| match cwd {
        Some(cwd) => git(cwd, args),
        None => git_global(args),
    })
}

fn clone_mirror_with(
    config: &MirrorConfig,
    path: &Path,
    mut run: impl FnMut(Option<&Path>, &[&str]) -> Result<String, GitError>,
) -> Result<(), GitError> {
    let path_text = path.to_string_lossy();
    let partial = run(
        None,
        &[
            "clone",
            "--filter=blob:none",
            "--sparse",
            "--no-checkout",
            "--branch",
            &config.branch,
            "--single-branch",
            &config.url,
            &path_text,
        ],
    )
    .and_then(|_| {
        let paths = sparse_paths(path, "HEAD")?;
        let mut args = vec!["sparse-checkout", "set", "--cone", "--"];
        args.extend(paths.iter().map(String::as_str));
        run(Some(path), &args)
    });
    match partial {
        Ok(_) => {
            run(Some(path), &["reset", "--hard", "HEAD"])?;
            Ok(())
        }
        Err(error) if unsupported_partial_clone(&error) => {
            if path.exists() {
                fs::remove_dir_all(path)?;
            }
            run(
                None,
                &[
                    "clone",
                    "--branch",
                    &config.branch,
                    "--single-branch",
                    &config.url,
                    &path_text,
                ],
            )?;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn replace_mirror(config: &MirrorConfig) -> Result<(), GitError> {
    let path = &config.mirror_path;
    let suffix = uuid::Uuid::new_v4();
    let temporary = path.with_extension(format!("clone-{suffix}"));
    if let Err(error) = clone_mirror(config, &temporary) {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }
    if path.exists() {
        let backup = path.with_extension(format!("backup-{suffix}"));
        fs::rename(path, &backup)?;
        if let Err(error) = fs::rename(&temporary, path) {
            fs::rename(&backup, path)?;
            return Err(error.into());
        }
        fs::remove_dir_all(backup)?;
    } else {
        fs::rename(temporary, path)?;
    }
    Ok(())
}

/// Clone or fetch a registry, keeping only skill and manifest folders checked out.
/// Full mirrors are replaced only after a replacement clone succeeds.
pub fn ensure_mirror(config: &MirrorConfig) -> Result<String, GitError> {
    let path = &config.mirror_path;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if !path.exists() || !is_partial_sparse_mirror(path) {
        replace_mirror(config)?;
    } else {
        git(path, &["remote", "set-url", "origin", &config.url])?;
        let refspec = format!(
            "+refs/heads/{}:refs/remotes/origin/{}",
            config.branch, config.branch
        );
        git(path, &["fetch", "origin", &refspec])?;
        let origin_branch = format!("origin/{}", config.branch);
        apply_sparse_paths(path, &origin_branch)?;
        git(path, &["checkout", "-B", &config.branch, &origin_branch])?;
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
        run_git(dir.path(), &["config", "uploadpack.allowFilter", "true"]);
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
            url: format!("file://{}", remote.path().display()),
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
    fn replaces_a_full_mirror_only_after_a_successful_clone() {
        let remote = init_remote();
        fs::create_dir_all(remote.path().join("app")).unwrap();
        fs::write(remote.path().join("app/main.rs"), "app source").unwrap();
        run_git(remote.path(), &["add", "."]);
        run_git(remote.path(), &["commit", "-m", "add app"]);
        let work = tempfile::tempdir().unwrap();
        let path = work.path().join("mirror");
        git_global(&[
            "clone",
            remote.path().to_str().unwrap(),
            path.to_str().unwrap(),
        ])
        .unwrap();
        assert!(path.join("app/main.rs").exists());
        let mut config = MirrorConfig {
            url: format!("file://{}", work.path().join("missing").display()),
            branch: "main".into(),
            mirror_path: path.clone(),
        };
        assert!(ensure_mirror(&config).is_err());
        assert_eq!(
            fs::read_to_string(path.join("app/main.rs")).unwrap(),
            "app source"
        );
        assert!(!is_partial_sparse_mirror(&path));
        config.url = format!("file://{}", remote.path().display());
        ensure_mirror(&config).unwrap();
        assert!(is_partial_sparse_mirror(&path));
        assert!(!path.join("app/main.rs").exists());
        assert_eq!(fs::read_to_string(path.join("a.txt")).unwrap(), "one");
    }

    #[test]
    fn falls_back_to_full_clone_when_git_lacks_partial_clone_support() {
        let remote = init_remote();
        for (unsupported_command, message) in [
            ("clone", "error: unknown option `filter=blob:none'"),
            (
                "sparse-checkout",
                "git: 'sparse-checkout' is not a git command",
            ),
        ] {
            let work = tempfile::tempdir().unwrap();
            let config = MirrorConfig {
                url: format!("file://{}", remote.path().display()),
                branch: "main".into(),
                mirror_path: work.path().join("mirror"),
            };
            let mut rejected = false;
            clone_mirror_with(&config, &config.mirror_path, |cwd, args| {
                if args[0] == unsupported_command && !rejected {
                    rejected = true;
                    return Err(GitError::new(message));
                }
                match cwd {
                    Some(cwd) => git(cwd, args),
                    None => git_global(args),
                }
            })
            .unwrap();
            assert!(rejected);
            assert!(!is_partial_sparse_mirror(&config.mirror_path));
            assert_eq!(
                fs::read_to_string(config.mirror_path.join("a.txt")).unwrap(),
                "one"
            );
            assert_eq!(
                run_git(
                    &config.mirror_path,
                    &["config", "--get", "remote.origin.fetch"]
                ),
                "+refs/heads/main:refs/remotes/origin/main"
            );
        }
    }

    #[test]
    fn root_skills_keep_their_entire_directory() {
        let remote = init_remote();
        fs::write(remote.path().join("SKILL.md"), "root skill").unwrap();
        fs::create_dir_all(remote.path().join("scripts/nested")).unwrap();
        fs::write(remote.path().join("scripts/nested/run.sh"), "echo root").unwrap();
        run_git(remote.path(), &["add", "."]);
        run_git(remote.path(), &["commit", "-m", "root skill"]);
        let work = tempfile::tempdir().unwrap();
        let config = MirrorConfig {
            url: format!("file://{}", remote.path().display()),
            branch: "main".into(),
            mirror_path: work.path().join("mirror"),
        };
        ensure_mirror(&config).unwrap();
        assert_eq!(
            fs::read_to_string(config.mirror_path.join("scripts/nested/run.sh")).unwrap(),
            "echo root"
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
