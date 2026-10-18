use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Directory name Electron used for `userData` in packaged builds. Reusing it
/// keeps existing `cache.sqlite`, `mirrors/` and `installation_id` in place.
pub const DATA_DIR_NAME: &str = "Got Skills";

/// Overrides the data directory (tests, development).
pub const DATA_DIR_ENV: &str = "GOTSKILLS_DATA_DIR";

/// Overrides the home directory (tests, development).
pub const HOME_ENV: &str = "GOTSKILLS_HOME";

/// The seam through which everything reads home, environment variables and
/// file existence, so tests can confine agent detection to a fake home.
#[derive(Debug, Clone)]
pub struct Environment {
    pub home: PathBuf,
    pub env: HashMap<String, String>,
    confine_to_home: bool,
}

impl Environment {
    /// The real process environment. `GOTSKILLS_HOME` overrides the home dir.
    pub fn real() -> Self {
        let home = std::env::var_os(HOME_ENV)
            .map(PathBuf::from)
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("/"));
        Environment {
            home,
            env: std::env::vars().collect(),
            confine_to_home: false,
        }
    }

    /// A fake home with an empty environment where only paths inside `home`
    /// can exist (mirrors `fakeHomeEnvironment`).
    pub fn fake_home(home: impl Into<PathBuf>) -> Self {
        Environment {
            home: home.into(),
            env: HashMap::new(),
            confine_to_home: true,
        }
    }

    /// Whether `path` exists (and, for a fake home, lies inside the home).
    pub fn exists(&self, path: &Path) -> bool {
        if self.confine_to_home && !path.starts_with(&self.home) {
            return false;
        }
        path.exists()
    }

    /// Look up an environment variable.
    pub fn var(&self, key: &str) -> Option<&str> {
        self.env.get(key).map(String::as_str)
    }
}

/// The app data directory: `GOTSKILLS_DATA_DIR`, else the OS data dir (on macOS
/// `~/Library/Application Support`) joined with `Got Skills`.
pub fn default_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(DATA_DIR_ENV) {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(DATA_DIR_NAME)
}

/// Locations inside the data directory.
#[derive(Debug, Clone)]
pub struct DataPaths {
    pub root: PathBuf,
}

impl DataPaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        DataPaths { root: root.into() }
    }

    /// Paths under [`default_data_dir`].
    pub fn default_location() -> Self {
        Self::new(default_data_dir())
    }

    /// `cache.sqlite`.
    pub fn database(&self) -> PathBuf {
        self.root.join("cache.sqlite")
    }

    /// `mirrors/`, holding one working clone per registry id.
    pub fn mirrors(&self) -> PathBuf {
        self.root.join("mirrors")
    }

    /// The mirror directory of one registry.
    pub fn mirror(&self, registry_id: &str) -> PathBuf {
        self.mirrors().join(registry_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_home_confines_existence_to_the_home() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let env = Environment::fake_home(home.path());
        assert!(env.exists(home.path()));
        assert!(!env.exists(outside.path()));
        assert!(env.env.is_empty());
    }

    #[test]
    fn data_paths_use_the_electron_layout() {
        let paths = DataPaths::new("/data/Got Skills");
        assert_eq!(
            paths.database(),
            PathBuf::from("/data/Got Skills/cache.sqlite")
        );
        assert_eq!(
            paths.mirror("r1"),
            PathBuf::from("/data/Got Skills/mirrors/r1")
        );
    }

    #[test]
    fn default_data_dir_ends_with_the_electron_product_name() {
        if std::env::var_os(DATA_DIR_ENV).is_none() {
            assert!(default_data_dir().ends_with(DATA_DIR_NAME));
        }
    }
}
