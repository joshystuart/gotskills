use regex::Regex;
use std::sync::OnceLock;

use crate::types::SyncFailureReason;

const MAX_MESSAGE_LENGTH: usize = 280;

/// Human-facing message for an access-required failure (no auth claim).
pub const ACCESS_REQUIRED_MESSAGE: &str = "Repository not found or access required";

fn access_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)Authentication failed|could not read Username|Invalid username or password|terminal prompts disabled|403|401|Repository not found|repository not found|access denied|Permission denied \(publickey\)",
        )
        .expect("valid access pattern")
    })
}

fn credential_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(https?://|ssh://|git://)[^@\s/]+(?::[^@\s/]+)?@")
            .expect("valid credential pattern")
    })
}

fn path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"/Users/[^\s:]+|/home/[^\s:]+|/var/folders/[^\s:]+")
            .expect("valid path pattern")
    })
}

/// Classify a git failure into a registry [`SyncFailureReason`].
///
/// GitHub cannot distinguish "missing" from "no access": a private or
/// non-existent repo both surface as not-found or auth failures. That whole
/// ambiguous class maps to `AccessRequired`; genuine connectivity failures map
/// to `Offline`.
pub fn classify_git_error(message: &str) -> SyncFailureReason {
    if access_pattern().is_match(message) {
        SyncFailureReason::AccessRequired
    } else {
        SyncFailureReason::Offline
    }
}

/// Redact a raw git error before it is surfaced: strip embedded credentials
/// from remote URLs and absolute user paths, then bound the length.
pub fn redact_git_error(message: &str) -> String {
    let without_credentials = credential_pattern().replace_all(message, "$1");
    let redacted = path_pattern().replace_all(&without_credentials, "~");
    redacted.chars().take(MAX_MESSAGE_LENGTH).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_github_access_ambiguity_to_access_required() {
        for message in [
            "fatal: Authentication failed for \"https://github.com/org/repo\"",
            "could not read Username for https://github.com",
            "remote: Repository not found.",
            "fatal: repository not found",
            "terminal prompts disabled",
            "The requested URL returned error: 403",
            "The requested URL returned error: 401",
        ] {
            assert_eq!(
                classify_git_error(message),
                SyncFailureReason::AccessRequired,
                "{message}"
            );
        }
    }

    #[test]
    fn maps_connectivity_failures_to_offline() {
        for message in [
            "fatal: unable to access: Could not resolve host: github.com",
            "ssh: connect to host github.com port 22: Operation timed out",
            "fatal: unable to access: Failed to connect",
        ] {
            assert_eq!(
                classify_git_error(message),
                SyncFailureReason::Offline,
                "{message}"
            );
        }
    }

    #[test]
    fn strips_embedded_credentials_from_a_remote_url() {
        let redacted = redact_git_error(
            "fatal: unable to access https://x-access-token:ghp_secret@github.com/org/repo.git/",
        );
        assert!(!redacted.contains("ghp_secret"));
        assert!(!redacted.contains("x-access-token"));
        assert!(redacted.contains("https://github.com/org/repo.git/"));
    }

    #[test]
    fn redacts_absolute_user_paths() {
        assert!(!redact_git_error("error at /Users/someone/secret/mirror").contains("someone"));
    }

    #[test]
    fn bounds_the_message_length() {
        assert!(redact_git_error(&"x".repeat(1000)).chars().count() <= 280);
    }
}
