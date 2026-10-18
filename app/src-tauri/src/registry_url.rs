use regex::Regex;
use std::sync::OnceLock;
use url::Url;

use crate::error::AppError;

/// A validated, canonicalised Registry Git URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalRegistry {
    pub url: String,
    pub canonical_key: String,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
    pub label: String,
    pub is_github: bool,
}

fn invalid(message: &str) -> AppError {
    AppError::RegistryUrlInvalid {
        message: message.to_string(),
    }
}

fn scp_like() -> &'static Regex {
    static SCP: OnceLock<Regex> = OnceLock::new();
    SCP.get_or_init(|| Regex::new(r"^([^@\s]+)@([^:/\s]+):(.+)$").unwrap())
}

fn strip_repo_suffix(segment: &str) -> String {
    let lower = segment.to_ascii_lowercase();
    if lower.ends_with(".git") {
        segment[..segment.len() - 4].to_string()
    } else {
        segment.to_string()
    }
}

fn trim_slashes(value: &str) -> &str {
    value.trim_matches('/')
}

fn to_owner_repo(pathname: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = trim_slashes(pathname)
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() != 2 {
        return None;
    }
    let repo = strip_repo_suffix(parts[1]);
    if parts[0].is_empty() || repo.is_empty() {
        return None;
    }
    Some((parts[0].to_string(), repo))
}

fn github_result(owner: String, repo: String, url: &str) -> CanonicalRegistry {
    CanonicalRegistry {
        url: url.to_string(),
        canonical_key: format!("github:{}/{}", owner.to_lowercase(), repo.to_lowercase()),
        label: format!("{owner}/{repo}"),
        github_owner: Some(owner),
        github_repo: Some(repo),
        is_github: true,
    }
}

fn generic_result(url: &str, body: &str, label: String) -> CanonicalRegistry {
    CanonicalRegistry {
        url: url.to_string(),
        canonical_key: format!("git:{body}"),
        github_owner: None,
        github_repo: None,
        label,
        is_github: false,
    }
}

fn trim_trailing_slashes(value: &str) -> &str {
    value.trim_end_matches('/')
}

/// Validate and canonicalise a Registry Git URL (ADR 0001). Rejects embedded
/// credentials without echoing them.
pub fn canonicalize_registry_url(input: &str) -> Result<CanonicalRegistry, AppError> {
    let url = input.trim();
    if url.is_empty() {
        return Err(invalid("Registry URL is required"));
    }

    if let Some(captures) = scp_like().captures(url) {
        if !url.contains("://") {
            let (user, host, path) = (&captures[1], &captures[2], &captures[3]);
            if user.contains(':') {
                return Err(invalid(
                    "Registry URL must not contain embedded credentials",
                ));
            }
            if host.eq_ignore_ascii_case("github.com") {
                let (owner, repo) = to_owner_repo(path)
                    .ok_or_else(|| invalid("GitHub registry URL must be a bare owner/repo"))?;
                return Ok(github_result(owner, repo, url));
            }
            let body = format!("{host}/{}", strip_repo_suffix(trim_trailing_slashes(path)));
            return Ok(generic_result(url, &body, body.clone()));
        }
    }

    let parsed = match Url::parse(url) {
        Ok(parsed) => parsed,
        Err(_) => {
            if url.starts_with('/') || url.starts_with("file:") {
                let body = strip_repo_suffix(trim_trailing_slashes(url));
                return Ok(generic_result(url, &body, url.to_string()));
            }
            return Err(invalid("Registry URL is not a valid Git URL"));
        }
    };

    if parsed.password().is_some() {
        return Err(invalid(
            "Registry URL must not contain embedded credentials",
        ));
    }
    let is_http = matches!(parsed.scheme(), "http" | "https");
    if !parsed.username().is_empty() && is_http {
        return Err(invalid(
            "Registry URL must not contain embedded credentials",
        ));
    }

    let hostname = parsed.host_str().unwrap_or("").to_string();
    if hostname.eq_ignore_ascii_case("github.com") {
        let (owner, repo) = to_owner_repo(parsed.path())
            .ok_or_else(|| invalid("GitHub registry URL must be a bare owner/repo"))?;
        return Ok(github_result(owner, repo, url));
    }

    let host = match parsed.port() {
        Some(port) => format!("{hostname}:{port}"),
        None => hostname,
    };
    let normalized_path = strip_repo_suffix(trim_trailing_slashes(parsed.path()));
    let body = format!(
        "{}://{}{normalized_path}",
        parsed.scheme(),
        host.to_lowercase()
    );
    let label = format!("{host}{normalized_path}");
    Ok(generic_result(url, &body, label))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_embedded_credentials_without_leaking_them() {
        for url in [
            "https://user:pass@github.com/anthropics/skills",
            "https://ghp_token123@github.com/anthropics/skills",
            "https://x-access-token:secret@example.com/team/skills.git",
            "ssh://git:hunter2@github.com/anthropics/skills",
        ] {
            let error = canonicalize_registry_url(url).unwrap_err();
            assert!(
                matches!(error, AppError::RegistryUrlInvalid { .. }),
                "{url}"
            );
            assert!(!error.message().contains("hunter2") && !error.message().contains("secret"));
        }
        assert!(canonicalize_registry_url("   ").is_err());
    }

    #[test]
    fn maps_github_spellings_to_one_owner_repo() {
        for (url, owner, repo) in [
            (
                "https://github.com/anthropics/skills",
                "anthropics",
                "skills",
            ),
            (
                "https://github.com/anthropics/skills.git",
                "anthropics",
                "skills",
            ),
            (
                "https://github.com/anthropics/skills/",
                "anthropics",
                "skills",
            ),
            (
                "git@github.com:anthropics/skills.git",
                "anthropics",
                "skills",
            ),
            (
                "ssh://git@github.com/anthropics/skills.git",
                "anthropics",
                "skills",
            ),
            (
                "https://GitHub.com/Anthropics/Skills",
                "Anthropics",
                "Skills",
            ),
        ] {
            let result = canonicalize_registry_url(url).unwrap();
            assert_eq!(result.github_owner.as_deref(), Some(owner), "{url}");
            assert_eq!(result.github_repo.as_deref(), Some(repo), "{url}");
            assert!(result.is_github);
        }
        let a = canonicalize_registry_url("https://github.com/anthropics/skills").unwrap();
        let b = canonicalize_registry_url("git@github.com:Anthropics/Skills.git").unwrap();
        assert_eq!(a.canonical_key, "github:anthropics/skills");
        assert_eq!(a.canonical_key, b.canonical_key);
        assert_eq!(a.label, "anthropics/skills");
    }

    #[test]
    fn rejects_non_bare_github_urls() {
        assert!(
            canonicalize_registry_url("https://github.com/anthropics/skills/tree/main").is_err()
        );
        assert!(canonicalize_registry_url("https://github.com/anthropics").is_err());
    }

    #[test]
    fn preserves_generic_urls_and_canonicalises_spellings_together() {
        let a = canonicalize_registry_url("https://git.example.com/team/skills.git").unwrap();
        assert!(!a.is_github);
        assert_eq!(a.github_owner, None);
        assert_eq!(a.url, "https://git.example.com/team/skills.git");
        assert_eq!(a.canonical_key, "git:https://git.example.com/team/skills");
        let b = canonicalize_registry_url("https://git.example.com/team/skills/").unwrap();
        assert_eq!(a.canonical_key, b.canonical_key);
    }

    #[test]
    fn accepts_local_paths() {
        let result = canonicalize_registry_url("/tmp/local-registry").unwrap();
        assert!(!result.is_github);
        assert_eq!(result.url, "/tmp/local-registry");
        assert_eq!(result.canonical_key, "git:/tmp/local-registry");
    }
}
