use serde::Serialize;

/// Application error. Serialises as `{ "kind": "...", "message": "...", ...fields }`
/// so the renderer shim can rebuild typed errors (camelCase field names).
#[derive(Debug, Clone, Serialize, thiserror::Error, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AppError {
    /// A target folder is already occupied by a managed or external skill.
    #[error("{message}")]
    InstallationCollision {
        message: String,
        occupant: Occupant,
        folder_name: String,
        target: String,
    },
    /// A registry URL failed validation.
    #[error("{message}")]
    RegistryUrlInvalid { message: String },
    /// A referenced entity does not exist.
    #[error("{message}")]
    NotFound { message: String },
    /// The request was malformed or refused.
    #[error("{message}")]
    InvalidInput { message: String },
    /// Any other failure; the message is already user-safe.
    #[error("{message}")]
    Failed { message: String },
}

/// Who currently occupies a colliding install folder.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Occupant {
    Managed,
    External,
}

/// Result alias used across the backend.
pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    /// Build a generic failure.
    pub fn failed(message: impl Into<String>) -> Self {
        AppError::Failed {
            message: message.into(),
        }
    }

    /// Build an invalid-input error.
    pub fn invalid(message: impl Into<String>) -> Self {
        AppError::InvalidInput {
            message: message.into(),
        }
    }

    /// Build a not-found error.
    pub fn not_found(message: impl Into<String>) -> Self {
        AppError::NotFound {
            message: message.into(),
        }
    }

    /// The human-readable message.
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        AppError::failed(error.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError::failed(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        AppError::failed(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn collision_serialises_with_kind_and_camel_case_fields() {
        let error = AppError::InstallationCollision {
            message: "occupied".into(),
            occupant: Occupant::External,
            folder_name: "alpha".into(),
            target: "~/.agents/skills".into(),
        };
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            json!({
                "kind": "installation-collision",
                "message": "occupied",
                "occupant": "external",
                "folderName": "alpha",
                "target": "~/.agents/skills"
            })
        );
    }

    #[test]
    fn simple_errors_carry_kind_and_message() {
        let value = serde_json::to_value(AppError::failed("boom")).unwrap();
        assert_eq!(value, json!({ "kind": "failed", "message": "boom" }));
        assert_eq!(AppError::not_found("x").message(), "x");
    }
}
