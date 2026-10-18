/// Abbreviate a SHA to seven characters; missing or empty input yields `None`.
pub fn short_sha(sha: Option<&str>) -> Option<String> {
    let sha = sha.filter(|value| !value.is_empty())?;
    Some(sha.chars().take(7).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortens_long_shas_and_keeps_short_ones() {
        assert_eq!(
            short_sha(Some("0123456789abcdef")).as_deref(),
            Some("0123456")
        );
        assert_eq!(short_sha(Some("abc")).as_deref(), Some("abc"));
    }

    #[test]
    fn missing_or_empty_is_none() {
        assert_eq!(short_sha(None), None);
        assert_eq!(short_sha(Some("")), None);
    }
}
