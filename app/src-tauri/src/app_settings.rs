use rusqlite::{Connection, OptionalExtension};

use crate::types::{Appearance, AppearancePatch, FontSize, Theme};

const AUTO_DOWNLOAD_KEY: &str = "app-update-auto-download";
const THEME_KEY: &str = "theme";
const FONT_SIZE_KEY: &str = "font-size";
const SYNC_CONCURRENCY_KEY: &str = "sync-concurrency";
const SYNC_CONCURRENCY_RANGE: std::ops::RangeInclusive<usize> = 1..=8;
const DEFAULT_SYNC_CONCURRENCY: usize = 4;

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_setting WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO app_setting (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

fn valid_sync_concurrency(concurrency: usize) -> usize {
    if SYNC_CONCURRENCY_RANGE.contains(&concurrency) {
        concurrency
    } else {
        DEFAULT_SYNC_CONCURRENCY
    }
}

pub fn get_sync_concurrency(conn: &Connection) -> usize {
    read_setting(conn, SYNC_CONCURRENCY_KEY)
        .and_then(|value| value.parse::<usize>().ok())
        .map_or(DEFAULT_SYNC_CONCURRENCY, valid_sync_concurrency)
}

pub fn set_sync_concurrency(conn: &Connection, concurrency: usize) -> rusqlite::Result<()> {
    write_setting(
        conn,
        SYNC_CONCURRENCY_KEY,
        &valid_sync_concurrency(concurrency).to_string(),
    )
}

/// Whether app updates download automatically (default true).
pub fn get_auto_download_app_updates(conn: &Connection) -> bool {
    read_setting(conn, AUTO_DOWNLOAD_KEY).as_deref() != Some("false")
}

pub fn set_auto_download_app_updates(conn: &Connection, enabled: bool) -> rusqlite::Result<()> {
    write_setting(conn, AUTO_DOWNLOAD_KEY, &enabled.to_string())
}

/// Stored appearance; unknown or missing values read as Dark and Default.
pub fn get_appearance(conn: &Connection) -> Appearance {
    let theme = read_setting(conn, THEME_KEY);
    let font_size = read_setting(conn, FONT_SIZE_KEY);
    Appearance {
        theme: Theme::ALL
            .into_iter()
            .find(|t| Some(t.as_str()) == theme.as_deref())
            .unwrap_or(Theme::Dark),
        font_size: FontSize::ALL
            .into_iter()
            .find(|f| Some(f.as_str()) == font_size.as_deref())
            .unwrap_or(FontSize::Default),
    }
}

/// Save only the provided appearance values.
pub fn set_appearance(conn: &Connection, patch: AppearancePatch) -> rusqlite::Result<()> {
    if let Some(theme) = patch.theme {
        write_setting(conn, THEME_KEY, theme.as_str())?;
    }
    if let Some(font_size) = patch.font_size {
        write_setting(conn, FONT_SIZE_KEY, font_size.as_str())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn sync_concurrency_defaults_and_round_trips() {
        let db = open_in_memory().unwrap();
        assert_eq!(get_sync_concurrency(&db), 4);
        for value in 1..=8 {
            set_sync_concurrency(&db, value).unwrap();
            assert_eq!(get_sync_concurrency(&db), value);
        }
        for value in ["0", "9", "-1", "no", "2.5"] {
            write_setting(&db, "sync-concurrency", value).unwrap();
            assert_eq!(get_sync_concurrency(&db), 4);
        }
        db.execute("DROP TABLE app_setting", []).unwrap();
        assert_eq!(get_sync_concurrency(&db), 4);
    }

    fn appearance(theme: Theme, font_size: FontSize) -> Appearance {
        Appearance { theme, font_size }
    }

    #[test]
    fn reads_dark_and_default_when_nothing_is_stored() {
        let db = open_in_memory().unwrap();
        assert_eq!(
            get_appearance(&db),
            appearance(Theme::Dark, FontSize::Default)
        );
    }

    #[test]
    fn round_trips_every_theme_and_font_size() {
        for theme in Theme::ALL {
            let db = open_in_memory().unwrap();
            set_appearance(
                &db,
                AppearancePatch {
                    theme: Some(theme),
                    font_size: None,
                },
            )
            .unwrap();
            assert_eq!(get_appearance(&db), appearance(theme, FontSize::Default));
        }
        for size in FontSize::ALL {
            let db = open_in_memory().unwrap();
            set_appearance(
                &db,
                AppearancePatch {
                    theme: None,
                    font_size: Some(size),
                },
            )
            .unwrap();
            assert_eq!(get_appearance(&db), appearance(Theme::Dark, size));
        }
    }

    #[test]
    fn partial_save_leaves_the_other_value_alone() {
        let db = open_in_memory().unwrap();
        set_appearance(
            &db,
            AppearancePatch {
                theme: Some(Theme::Light),
                font_size: Some(FontSize::Large),
            },
        )
        .unwrap();
        set_appearance(
            &db,
            AppearancePatch {
                theme: None,
                font_size: Some(FontSize::Small),
            },
        )
        .unwrap();
        assert_eq!(
            get_appearance(&db),
            appearance(Theme::Light, FontSize::Small)
        );
    }

    #[test]
    fn unknown_stored_values_read_as_defaults() {
        let db = open_in_memory().unwrap();
        db.execute(
            "INSERT INTO app_setting (key, value) VALUES ('theme', 'sepia')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO app_setting (key, value) VALUES ('font-size', 'huge')",
            [],
        )
        .unwrap();
        assert_eq!(
            get_appearance(&db),
            appearance(Theme::Dark, FontSize::Default)
        );
    }

    #[test]
    fn auto_download_defaults_on_and_only_false_turns_it_off() {
        let db = open_in_memory().unwrap();
        assert!(get_auto_download_app_updates(&db));
        set_auto_download_app_updates(&db, false).unwrap();
        assert!(!get_auto_download_app_updates(&db));
        set_auto_download_app_updates(&db, true).unwrap();
        assert!(get_auto_download_app_updates(&db));
    }
}
