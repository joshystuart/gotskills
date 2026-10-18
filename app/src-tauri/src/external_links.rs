//! Keeps the app on its own pages: external links open in the browser.

use url::Url;

/// What to do with a navigation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    OpenExternally,
    Block,
}

/// Decide a navigation: the app's own origins load, web and mail links go to
/// the system, everything else is refused.
pub fn navigation(url: &Url) -> Navigation {
    match url.scheme() {
        "tauri" | "asset" | "ipc" | "about" | "blob" | "data" => Navigation::Allow,
        "http" | "https" => match url.host_str() {
            Some(
                "localhost" | "127.0.0.1" | "tauri.localhost" | "ipc.localhost" | "asset.localhost",
            ) => Navigation::Allow,
            _ => Navigation::OpenExternally,
        },
        "mailto" | "tel" => Navigation::OpenExternally,
        _ => Navigation::Block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decide(url: &str) -> Navigation {
        navigation(&Url::parse(url).unwrap())
    }

    #[test]
    fn app_origins_load() {
        assert_eq!(decide("tauri://localhost/index.html"), Navigation::Allow);
        assert_eq!(decide("http://localhost:1420/"), Navigation::Allow);
        assert_eq!(decide("http://tauri.localhost/"), Navigation::Allow);
        assert_eq!(decide("about:blank"), Navigation::Allow);
    }

    #[test]
    fn web_and_mail_links_open_externally() {
        assert_eq!(decide("https://github.com/o/r"), Navigation::OpenExternally);
        assert_eq!(decide("http://example.com/"), Navigation::OpenExternally);
        assert_eq!(decide("mailto:a@b.c"), Navigation::OpenExternally);
    }

    #[test]
    fn other_schemes_are_blocked() {
        assert_eq!(decide("file:///etc/passwd"), Navigation::Block);
        assert_eq!(decide("javascript:alert(1)"), Navigation::Block);
    }
}
