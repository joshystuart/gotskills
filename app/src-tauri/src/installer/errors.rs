//! Message redaction for user-visible install errors.

use regex::Regex;
use std::sync::OnceLock;

const MAX_LENGTH: usize = 280;

fn patterns() -> &'static [Regex; 3] {
    static PATTERNS: OnceLock<[Regex; 3]> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            Regex::new(r"/Users/[^\s:]+").expect("valid regex"),
            Regex::new(r"/home/[^\s:]+").expect("valid regex"),
            Regex::new(r"/var/folders/[^\s:]+").expect("valid regex"),
        ]
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
    fn limits_the_redacted_message_to_280_characters() {
        assert_eq!(redact_error(&"x".repeat(300)), "x".repeat(280));
    }
}
