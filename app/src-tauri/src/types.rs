//! Serde mirrors of `app/src/shared/ipc.ts`. Field names are camelCase and
//! unions use the same string spellings as the TypeScript types.

use serde::{Deserialize, Serialize};

/// The closed set of Registry sources, shared by storage, sync and IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RegistrySource {
    Git,
    Local,
}

/// Longest Registry Name allowed, after trimming.
pub const MAX_REGISTRY_NAME_LENGTH: usize = 40;

/// Event names emitted from the backend to the renderer.
pub mod events {
    pub const APP_UPDATE_STATE: &str = "appUpdate:state";
    pub const SYNC_STATUS: &str = "sync:status";
    pub const CATALOGUE_UPDATED: &str = "catalogue:updated";
    pub const AUTO_UPDATE_RESULT: &str = "catalogue:autoUpdateResult";
}

/// Composite Skill id: `registryId/folderName`.
pub fn skill_id(registry_id: &str, folder_name: &str) -> String {
    format!("{registry_id}/{folder_name}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMethod {
    Symlink,
    Copy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncPhase {
    Syncing,
    Synced,
    Failed,
}

/// Aggregate catalogue refresh phase; also `partial` when some registries fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogueSyncPhase {
    Syncing,
    Synced,
    Failed,
    Partial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncFailureReason {
    Offline,
    Empty,
    AccessRequired,
    FolderNotFound,
    FolderUnreadable,
    FolderChanged,
    SnapshotFailed,
}

impl SyncFailureReason {
    /// Whether this reason is about a Local Registry folder, so its status
    /// names the folder path.
    pub fn is_local(self) -> bool {
        matches!(
            self,
            SyncFailureReason::FolderNotFound
                | SyncFailureReason::FolderUnreadable
                | SyncFailureReason::FolderChanged
                | SyncFailureReason::SnapshotFailed
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySyncStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    pub registry_id: String,
    pub phase: SyncPhase,
    pub last_synced_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<SyncFailureReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_skill_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub phase: CatalogueSyncPhase,
    pub last_synced_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<SyncFailureReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_skill_count: Option<u32>,
    pub registries: Vec<RegistrySyncStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAllResult {
    pub registries: Vec<RegistrySyncStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReconcileState {
    Installed,
    UpdateAvailable,
    NeedsRepair,
    NotInstalled,
    External,
    OtherRegistry,
    RemovedFromRegistry,
    Orphaned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdatedSkill {
    pub folder_name: String,
    pub name: String,
    pub targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateFailure {
    pub folder_name: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateResult {
    pub registry_id: String,
    pub registry_label: String,
    pub updated: Vec<AutoUpdatedSkill>,
    pub failed: Vec<AutoUpdateFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerTargetState {
    pub target: String,
    pub state: ReconcileState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub registry_id: String,
    pub folder_name: String,
    pub id: String,
    pub name: String,
    pub description: String,
    pub registry_label: String,
    pub conflict: bool,
    pub stale: bool,
    pub orphaned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub soft_deleted: bool,
    pub per_target: Vec<PerTargetState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueSnapshot {
    pub skills: Vec<SkillSummary>,
    pub sync_status: SyncStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRecord {
    pub source: RegistrySource,
    pub automatic_name: String,
    pub id: String,
    pub url: String,
    pub branch: String,
    pub enabled: bool,
    pub auto_update: bool,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
    pub colour: Option<String>,
    pub name: Option<String>,
    pub sync_status: RegistrySyncStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRegistryRequest {
    pub url: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRegistryRequest {
    pub id: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub auto_update: Option<bool>,
    #[serde(default)]
    pub colour: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTargetAgent {
    pub id: String,
    pub display_name: String,
    pub detected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTargetStatus {
    pub id: String,
    pub label: String,
    pub shared: bool,
    pub visible: bool,
    pub agents: Vec<InstallTargetAgent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedAgent {
    pub id: String,
    pub display_name: String,
    pub target: String,
    pub detected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDetection {
    pub targets: Vec<InstallTargetStatus>,
    pub agents: Vec<SupportedAgent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub registry_id: String,
    pub folder_name: String,
    pub targets: Vec<String>,
    pub mirror_revision: String,
    #[serde(default)]
    pub acknowledge_stale: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetOutcome {
    Installed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetResult {
    pub target: String,
    pub outcome: TargetOutcome,
    pub method: InstallMethod,
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub registry_id: String,
    pub folder_name: String,
    pub skill_id: String,
    pub mirror_revision: String,
    pub content_hash: String,
    pub provenance_sha: String,
    pub cli_version: String,
    pub per_target: Vec<TargetResult>,
    pub installed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub registry_id: String,
    pub folder_name: String,
    pub target: String,
    pub content_hash: String,
    pub provenance_sha: String,
    pub method: InstallMethod,
    pub paths: Vec<String>,
    pub cli_version: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallRequest {
    pub registry_id: String,
    pub folder_name: String,
    pub targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallTargetResult {
    pub target: String,
    pub outcome: TargetOutcome,
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResult {
    pub registry_id: String,
    pub folder_name: String,
    pub skill_id: String,
    pub per_target: Vec<UninstallTargetResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskProbe {
    pub path: String,
    pub exists: bool,
    pub is_symlink: bool,
    pub resolves: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileEntry {
    pub registry_id: String,
    pub folder_name: String,
    pub skill_id: String,
    pub target: String,
    pub state: ReconcileState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirror_hash: Option<String>,
    pub disk: Vec<DiskProbe>,
    pub lock_agrees: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub scanned_at: String,
    pub entries: Vec<ReconcileEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileRequest {
    #[serde(default)]
    pub registry_id: Option<String>,
    #[serde(default)]
    pub folder_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileEntry {
    pub path: String,
    pub size_bytes: u64,
    pub viewable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillFileUnavailable {
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileList {
    pub files: Vec<SkillFileEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<SkillFileUnavailable>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillFileKind {
    Text,
    Binary,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileContent {
    pub path: String,
    pub size_bytes: u64,
    pub kind: SkillFileKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileRequest {
    pub registry_id: String,
    pub folder_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileReadRequest {
    pub registry_id: String,
    pub folder_name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastUpdateCheck {
    pub at: String,
    pub result: UpdateCheckResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateCheckResult {
    UpToDate,
    Error,
}

/// App update state machine, tagged by `kind` like the TypeScript union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AppUpdateState {
    Idle {
        current_version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_check: Option<LastUpdateCheck>,
    },
    Checking {
        current_version: String,
    },
    Available {
        current_version: String,
        version: String,
    },
    Downloading {
        current_version: String,
        version: String,
        percent: f64,
    },
    Ready {
        current_version: String,
        version: String,
        waiting: bool,
    },
    DownloadFailed {
        current_version: String,
        version: String,
        message: String,
    },
}

/// The colour theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

impl Theme {
    pub const ALL: [Theme; 3] = [Theme::System, Theme::Light, Theme::Dark];

    /// The stored and wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }
}

/// The text size preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontSize {
    Small,
    Default,
    Large,
    Larger,
}

impl FontSize {
    pub const ALL: [FontSize; 4] = [
        FontSize::Small,
        FontSize::Default,
        FontSize::Large,
        FontSize::Larger,
    ];

    /// The stored and wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            FontSize::Small => "small",
            FontSize::Default => "default",
            FontSize::Large => "large",
            FontSize::Larger => "larger",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub theme: Theme,
    pub font_size: FontSize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AppearancePatch {
    pub theme: Option<Theme>,
    pub font_size: Option<FontSize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RegistryMenuAction {
    Rename,
    Sync,
    ToggleEnabled,
    ToggleAutoUpdate,
    ShowSettings,
    Remove,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MenuPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryMenuRequest {
    pub registry_id: String,
    pub busy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<MenuPosition>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_update_state_is_tagged_by_kind() {
        let state = AppUpdateState::DownloadFailed {
            current_version: "1.0.0".into(),
            version: "1.1.0".into(),
            message: "no".into(),
        };
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({ "kind": "download-failed", "currentVersion": "1.0.0", "version": "1.1.0", "message": "no" })
        );
        let idle: AppUpdateState =
            serde_json::from_value(json!({ "kind": "idle", "currentVersion": "1.0.0" })).unwrap();
        assert_eq!(
            idle,
            AppUpdateState::Idle {
                current_version: "1.0.0".into(),
                last_check: None
            }
        );
    }

    #[test]
    fn requests_deserialise_camel_case_with_optional_fields() {
        let request: InstallRequest = serde_json::from_value(json!({
            "registryId": "r", "folderName": "f", "targets": ["~/.agents/skills"], "mirrorRevision": "abc"
        }))
        .unwrap();
        assert_eq!(request.acknowledge_stale, None);
        let update: UpdateRegistryRequest =
            serde_json::from_value(json!({ "id": "r", "autoUpdate": true })).unwrap();
        assert_eq!(update.auto_update, Some(true));
    }

    #[test]
    fn unions_use_the_typescript_spellings() {
        assert_eq!(
            serde_json::to_value(ReconcileState::UpdateAvailable).unwrap(),
            json!("update-available")
        );
        assert_eq!(
            serde_json::to_value(SyncFailureReason::AccessRequired).unwrap(),
            json!("access-required")
        );
        assert_eq!(
            serde_json::to_value(RegistryMenuAction::ToggleAutoUpdate).unwrap(),
            json!("toggle-auto-update")
        );
        assert_eq!(
            serde_json::to_value(CatalogueSyncPhase::Partial).unwrap(),
            json!("partial")
        );
        assert_eq!(
            serde_json::to_value(Appearance {
                theme: Theme::System,
                font_size: FontSize::Larger
            })
            .unwrap(),
            json!({ "theme": "system", "fontSize": "larger" })
        );
    }

    #[test]
    fn optional_status_fields_are_omitted_not_null() {
        let status = RegistrySyncStatus {
            folder_path: None,
            registry_id: "r".into(),
            phase: SyncPhase::Synced,
            last_synced_at: None,
            reason: None,
            revision: None,
            visible_skill_count: None,
            stale: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "registryId": "r", "phase": "synced", "lastSyncedAt": null })
        );
    }

    #[test]
    fn skill_id_joins_registry_and_folder() {
        assert_eq!(skill_id("r", "f"), "r/f");
    }
}
