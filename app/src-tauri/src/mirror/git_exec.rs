use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::AppError;

/// Environment overrides that force non-interactive git: never prompt on a
/// terminal, never invoke a credential helper or askpass GUI.
const NON_INTERACTIVE_ENV: [(&str, &str); 4] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_ASKPASS", ""),
    ("SSH_ASKPASS", ""),
    ("GIT_SSH_COMMAND", "ssh -oBatchMode=yes"),
];

/// Config flags that neutralise any interactive credential helper or askpass.
const NON_INTERACTIVE_ARGS: [&str; 4] = ["-c", "credential.helper=", "-c", "core.askPass="];

/// A failed git invocation or a failed mirror operation. `message` is the raw,
/// unredacted text (for [`crate::mirror::git_errors::classify_git_error`]).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GitError {
    pub message: String,
}

impl GitError {
    pub fn new(message: impl Into<String>) -> Self {
        GitError {
            message: message.into(),
        }
    }
}

impl From<rusqlite::Error> for GitError {
    fn from(error: rusqlite::Error) -> Self {
        GitError::new(error.to_string())
    }
}

impl From<std::io::Error> for GitError {
    fn from(error: std::io::Error) -> Self {
        GitError::new(error.to_string())
    }
}

impl From<GitError> for AppError {
    fn from(error: GitError) -> Self {
        AppError::failed(error.message)
    }
}

#[cfg(test)]
thread_local! {
    static INVOCATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub fn count_git_invocations<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    INVOCATIONS.with(|count| count.set(0));
    let result = operation();
    (result, INVOCATIONS.with(|count| count.get()))
}

fn run(cwd: Option<&Path>, args: &[&str]) -> Result<String, GitError> {
    #[cfg(test)]
    INVOCATIONS.with(|count| count.set(count.get() + 1));
    let mut command = Command::new("git");
    command.args(NON_INTERACTIVE_ARGS).args(args);
    for (key, value) in NON_INTERACTIVE_ENV {
        command.env(key, value);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command.stdin(Stdio::null()).output().map_err(|error| {
        GitError::new(format!("Command failed: git {}\n{error}", args.join(" ")))
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitError::new(format!(
            "Command failed: git {}\n{}",
            args.join(" "),
            stderr.trim_end()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Run a git subcommand in `cwd`; errors on non-zero exit.
pub fn git(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    run(Some(cwd), args).map(|output| output.trim().to_string())
}

/// Run git while preserving output delimiters and trailing whitespace.
pub(crate) fn git_output(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    run(Some(cwd), args)
}

/// Run git without a working tree (e.g. clone into a new path).
pub fn git_global(args: &[&str]) -> Result<String, GitError> {
    run(None, args).map(|output| output.trim().to_string())
}
