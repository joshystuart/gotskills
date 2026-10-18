//! Mapping of the stored Theme onto the native window.

use crate::types::Theme;

/// The window background for dark mode; matches the stylesheet's `--bg`.
pub const DARK_BACKGROUND: &str = "#09090b";

/// The window background for light mode.
pub const LIGHT_BACKGROUND: &str = "#ffffff";

/// The theme to force on the window: `None` follows the system.
pub fn forced_theme(theme: Theme) -> Option<tauri::Theme> {
    match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    }
}

/// Whether the window renders dark, given the stored theme and the system's.
pub fn uses_dark(theme: Theme, system_is_dark: bool) -> bool {
    match theme {
        Theme::System => system_is_dark,
        Theme::Light => false,
        Theme::Dark => true,
    }
}

/// The window background for the resolved scheme.
pub fn background_color(dark: bool) -> &'static str {
    if dark {
        DARK_BACKGROUND
    } else {
        LIGHT_BACKGROUND
    }
}

/// Parse `#rrggbb` into its channels.
pub fn parse_hex(colour: &str) -> Option<(u8, u8, u8)> {
    let digits = colour.strip_prefix('#')?;
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |range: std::ops::Range<usize>| u8::from_str_radix(&digits[range], 16).ok();
    Some((channel(0..2)?, channel(2..4)?, channel(4..6)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_follows_the_native_theme_and_others_force_it() {
        assert_eq!(forced_theme(Theme::System), None);
        assert_eq!(forced_theme(Theme::Light), Some(tauri::Theme::Light));
        assert_eq!(forced_theme(Theme::Dark), Some(tauri::Theme::Dark));
    }

    #[test]
    fn resolves_the_scheme_from_theme_and_system() {
        assert!(uses_dark(Theme::System, true));
        assert!(!uses_dark(Theme::System, false));
        assert!(!uses_dark(Theme::Light, true));
        assert!(uses_dark(Theme::Dark, false));
    }

    #[test]
    fn background_matches_the_resolved_scheme() {
        assert_eq!(background_color(true), "#09090b");
        assert_eq!(background_color(false), "#ffffff");
    }

    #[test]
    fn parses_hex_colours() {
        assert_eq!(parse_hex("#09090b"), Some((9, 9, 11)));
        assert_eq!(parse_hex("09090b"), None);
        assert_eq!(parse_hex("#fff"), None);
        assert_eq!(parse_hex("#gggggg"), None);
    }
}
