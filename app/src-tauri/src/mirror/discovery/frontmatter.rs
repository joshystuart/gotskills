//! Ported from vercel-labs/skills@1.7.0 (MIT License).
//! See UPSTREAM.md in this directory for maintenance notes.

use regex::Regex;
use serde_yaml::{Mapping, Value};
use std::sync::OnceLock;

fn frontmatter_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?s)\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\z").expect("valid frontmatter pattern")
    })
}

/// Parsed frontmatter plus the remaining body.
#[derive(Debug, Clone, PartialEq)]
pub struct Frontmatter {
    pub data: Mapping,
    pub content: String,
}

/// Minimal YAML-only frontmatter parser (the `---` delimiter). Errors carry the
/// YAML parser message.
pub fn parse_frontmatter(raw: &str) -> Result<Frontmatter, String> {
    let Some(captures) = frontmatter_pattern().captures(raw) else {
        return Ok(Frontmatter {
            data: Mapping::new(),
            content: raw.to_string(),
        });
    };
    let parsed: Value = serde_yaml::from_str(&captures[1]).map_err(|error| error.to_string())?;
    let data = match parsed {
        Value::Mapping(mapping) => mapping,
        _ => Mapping::new(),
    };
    Ok(Frontmatter {
        data,
        content: captures[2].to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_yaml_frontmatter_from_the_body() {
        let parsed = parse_frontmatter("---\nname: a\ndescription: b\n---\n\n# Body\n").unwrap();
        assert_eq!(parsed.data.get("name"), Some(&Value::String("a".into())));
        assert_eq!(parsed.content, "\n# Body\n");
    }

    #[test]
    fn returns_the_whole_input_without_frontmatter() {
        let parsed = parse_frontmatter("no frontmatter\n").unwrap();
        assert!(parsed.data.is_empty());
        assert_eq!(parsed.content, "no frontmatter\n");
    }

    #[test]
    fn reports_invalid_yaml() {
        assert!(parse_frontmatter("---\nname: [unclosed\n---\n").is_err());
    }

    #[test]
    fn treats_an_empty_block_as_no_data() {
        let parsed = parse_frontmatter("---\n\n---\nbody").unwrap();
        assert!(parsed.data.is_empty());
    }
}
