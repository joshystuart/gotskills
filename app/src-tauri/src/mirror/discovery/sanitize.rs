//! Ported from vercel-labs/skills@1.7.0 (MIT License).
//! See UPSTREAM.md in this directory for maintenance notes.

use regex::Regex;
use std::sync::OnceLock;

struct Patterns {
    csi: Regex,
    osc: Regex,
    dcs_pm_apc: Regex,
    simple_esc: Regex,
    c1: Regex,
    control: Regex,
    newlines: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        csi: Regex::new(r"\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]").unwrap(),
        osc: Regex::new(r"(?s)\x1b\].*?(?:\x07|\x1b\\)").unwrap(),
        dcs_pm_apc: Regex::new(r"(?s)\x1b[P^_].*?(?:\x1b\\)").unwrap(),
        simple_esc: Regex::new(r"\x1b[\x20-\x7e]").unwrap(),
        c1: Regex::new(r"[\x{80}-\x{9f}]").unwrap(),
        control: Regex::new(r"[\x00-\x06\x07\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]").unwrap(),
        newlines: Regex::new(r"[\r\n]+").unwrap(),
    })
}

/// Strip all terminal escape sequences and dangerous control characters
/// (everything except tab and newline) from an untrusted string. OSC is
/// stripped first because it is the longest match.
pub fn strip_terminal_escapes(input: &str) -> String {
    let p = patterns();
    let text = p.osc.replace_all(input, "");
    let text = p.dcs_pm_apc.replace_all(&text, "");
    let text = p.csi.replace_all(&text, "");
    let text = p.simple_esc.replace_all(&text, "");
    let text = p.c1.replace_all(&text, "");
    p.control.replace_all(&text, "").into_owned()
}

/// Sanitize a skill metadata string: strip escapes, collapse newlines into
/// single spaces and trim.
pub fn sanitize_metadata(input: &str) -> String {
    let stripped = strip_terminal_escapes(input);
    patterns()
        .newlines
        .replace_all(&stripped, " ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_colour_and_title_sequences() {
        assert_eq!(strip_terminal_escapes("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_terminal_escapes("a\x1b]0;title\x07b"), "ab");
        assert_eq!(strip_terminal_escapes("a\x07b\x7fc"), "abc");
    }

    #[test]
    fn keeps_tabs_and_newlines_when_stripping() {
        assert_eq!(strip_terminal_escapes("a\tb\nc"), "a\tb\nc");
    }

    #[test]
    fn metadata_is_single_line_and_trimmed() {
        assert_eq!(
            sanitize_metadata("  one\r\ntwo\n\nthree \x1b[1m"),
            "one two three"
        );
    }
}
