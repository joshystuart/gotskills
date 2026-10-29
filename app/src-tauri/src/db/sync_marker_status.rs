use std::fmt;

/// Canonical sync marker status. `AccessRequired` is stored as
/// `access_required` on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMarkerStatus {
    Never,
    Ok,
    Offline,
    Empty,
    AccessRequired,
    FolderNotFound,
}

impl SyncMarkerStatus {
    /// The spelling persisted in SQLite.
    pub fn encode(self) -> &'static str {
        match self {
            SyncMarkerStatus::Never => "never",
            SyncMarkerStatus::Ok => "ok",
            SyncMarkerStatus::Offline => "offline",
            SyncMarkerStatus::Empty => "empty",
            SyncMarkerStatus::AccessRequired => "access_required",
            SyncMarkerStatus::FolderNotFound => "folder_not_found",
        }
    }

    /// Parse a persisted value; anything outside the schema is an error.
    pub fn decode(value: &str) -> Result<Self, UnknownSyncMarkerStatus> {
        match value {
            "never" => Ok(SyncMarkerStatus::Never),
            "ok" => Ok(SyncMarkerStatus::Ok),
            "offline" => Ok(SyncMarkerStatus::Offline),
            "empty" => Ok(SyncMarkerStatus::Empty),
            "access_required" => Ok(SyncMarkerStatus::AccessRequired),
            "folder_not_found" => Ok(SyncMarkerStatus::FolderNotFound),
            other => Err(UnknownSyncMarkerStatus(other.to_string())),
        }
    }
}

/// A persisted status value outside the schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownSyncMarkerStatus(pub String);

impl fmt::Display for UnknownSyncMarkerStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Unknown persisted sync marker status: {}", self.0)
    }
}

impl std::error::Error for UnknownSyncMarkerStatus {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_required_uses_the_sqlite_spelling() {
        assert_eq!(SyncMarkerStatus::AccessRequired.encode(), "access_required");
        assert_eq!(
            SyncMarkerStatus::decode("access_required"),
            Ok(SyncMarkerStatus::AccessRequired)
        );
    }

    #[test]
    fn unchanged_statuses_round_trip() {
        for status in [
            SyncMarkerStatus::Never,
            SyncMarkerStatus::Ok,
            SyncMarkerStatus::Offline,
            SyncMarkerStatus::Empty,
        ] {
            assert_eq!(SyncMarkerStatus::decode(status.encode()), Ok(status));
        }
    }

    #[test]
    fn rejects_values_outside_the_persisted_schema() {
        let error = SyncMarkerStatus::decode("access-required").unwrap_err();
        assert!(error
            .to_string()
            .contains("Unknown persisted sync marker status"));
    }
}
