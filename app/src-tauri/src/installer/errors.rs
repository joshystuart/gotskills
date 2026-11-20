//! Message redaction for user-visible install errors.

use regex::Regex;
use std::sync::OnceLock;

const MAX_LENGTH: usize = 280;

fn patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let temp_dir = std::env::temp_dir();
        let temp_dir = regex::escape(temp_dir.to_string_lossy().trim_end_matches('/'));
        [
            "/Users/".to_string(),
            "/home/".to_string(),
            "/var/folders/".to_string(),
            "/tmp/".to_string(),
            format!("{temp_dir}/"),
        ]
        .iter()
        .map(|prefix| Regex::new(&format!(r"{prefix}[^\s:]+")).expect("valid regex"))
        .collect()
    })
}

/// Replace home and temporary paths with `~` and bound the length to 280 characters.
pub fn redact_error(message: &str) -> String {
    let mut text = message.to_string();
    for pattern in patterns() {
        text = pattern.replace_all(&text, "~").into_owned();
    }
    text.chars().take(MAX_LENGTH).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_supported_home_and_temporary_paths() {
        assert_eq!(
            redact_error(
                "failed /Users/alice/project/file.ts:12 /home/bob/private.txt /var/folders/xy/secret/item"
            ),
            "failed ~:12 ~ ~"
        );
    }

    #[test]
    fn redacts_linux_and_system_temporary_paths() {
        let system_temp = std::env::temp_dir().join("secret/item");
        assert_eq!(
            redact_error(&format!(
                "failed /tmp/.tmpAbC/secret {}",
                system_temp.display()
            )),
            "failed ~ ~"
        );
    }

    #[test]
    fn limits_the_redacted_message_to_280_characters() {
        assert_eq!(redact_error(&"x".repeat(300)), "x".repeat(280));
    }
}
