use std::collections::HashSet;
use std::path::Path;

use regex::Regex;
use rusqlite::{named_params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::AppResult;
use crate::types::{TargetOutcome, TargetResult};

/// Telemetry schema version for exported evidence rows.
pub const TELEMETRY_SCHEMA_VERSION: i64 = 2;

const INSTALLATION_ID_FILE: &str = "installation_id";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelemetryEventType {
    SessionStarted,
    SyncCompleted,
    InstallRequested,
    InstallTargetCompleted,
}

impl TelemetryEventType {
    pub fn as_str(self) -> &'static str {
        match self {
            TelemetryEventType::SessionStarted => "session_started",
            TelemetryEventType::SyncCompleted => "sync_completed",
            TelemetryEventType::InstallRequested => "install_requested",
            TelemetryEventType::InstallTargetCompleted => "install_target_completed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelemetryAction {
    Install,
    Update,
    Remove,
}

impl TelemetryAction {
    pub fn as_str(self) -> &'static str {
        match self {
            TelemetryAction::Install => "install",
            TelemetryAction::Update => "update",
            TelemetryAction::Remove => "remove",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelemetryOutcome {
    Success,
    Failure,
    Skipped,
}

impl TelemetryOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            TelemetryOutcome::Success => "success",
            TelemetryOutcome::Failure => "failure",
            TelemetryOutcome::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    LinkFailed,
    CliFailed,
    RevisionMismatch,
    Unknown,
}

impl ErrorCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCategory::LinkFailed => "link_failed",
            ErrorCategory::CliFailed => "cli_failed",
            ErrorCategory::RevisionMismatch => "revision_mismatch",
            ErrorCategory::Unknown => "unknown",
        }
    }
}

/// Fields of one telemetry event; everything but the type is optional.
#[derive(Debug, Clone)]
pub struct EmitInput {
    pub event_type: TelemetryEventType,
    pub operation_id: Option<String>,
    pub skill_id: Option<String>,
    pub commit_sha: Option<String>,
    pub content_hash: Option<String>,
    pub action: Option<TelemetryAction>,
    pub targets: Option<Vec<String>>,
    pub target_app: Option<String>,
    pub outcome: Option<TelemetryOutcome>,
    pub duration_ms: Option<i64>,
    pub error_category: Option<ErrorCategory>,
    pub registry_revision: Option<String>,
    pub visible_skill_count: Option<i64>,
}

impl EmitInput {
    /// An event of `event_type` with every other field unset.
    pub fn new(event_type: TelemetryEventType) -> Self {
        EmitInput {
            event_type,
            operation_id: None,
            skill_id: None,
            commit_sha: None,
            content_hash: None,
            action: None,
            targets: None,
            target_app: None,
            outcome: None,
            duration_ms: None,
            error_category: None,
            registry_revision: None,
            visible_skill_count: None,
        }
    }
}

/// Keep only known, distinct string targets (order preserved).
pub fn sanitize_targets(targets: &[String], known: &HashSet<String>) -> Vec<String> {
    let mut sanitized: Vec<String> = Vec::new();
    for target in targets {
        if known.contains(target) && !sanitized.contains(target) {
            sanitized.push(target.clone());
        }
    }
    sanitized
}

fn sanitize_target(target: Option<&str>, known: &HashSet<String>) -> Option<String> {
    target
        .filter(|value| known.contains(*value))
        .map(str::to_string)
}

fn parse_stored_targets(value: Option<&str>, known: &HashSet<String>) -> Option<Vec<String>> {
    let parsed: Value = serde_json::from_str(value?).ok()?;
    let items = parsed.as_array()?;
    let strings: Vec<String> = items
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();
    Some(sanitize_targets(&strings, known))
}

/// Load or create the persistent random installation id under `data_dir`.
pub fn load_or_create_installation_id(data_dir: &Path) -> std::io::Result<String> {
    let path = data_dir.join(INSTALLATION_ID_FILE);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return Ok(existing.to_string());
        }
    }
    std::fs::create_dir_all(data_dir)?;
    let id = Uuid::new_v4().to_string();
    std::fs::write(&path, format!("{id}\n"))?;
    Ok(id)
}

/// Map a redacted install error (or refusal) to a coarse category.
pub fn sanitize_error_category(revision_mismatch: bool, error: Option<&str>) -> ErrorCategory {
    if revision_mismatch {
        return ErrorCategory::RevisionMismatch;
    }
    let message = error.unwrap_or("").to_lowercase();
    let link =
        Regex::new(r"symlink|eperm|eacces|link|errno:\s*-1|operation not permitted").unwrap();
    if link.is_match(&message) {
        return ErrorCategory::LinkFailed;
    }
    if message.is_empty() {
        ErrorCategory::Unknown
    } else {
        ErrorCategory::CliFailed
    }
}

/// Append-only local telemetry log. Pass the connection to each call.
pub struct TelemetryLog {
    pub installation_id: String,
    pub session_id: String,
    pub app_version: String,
    known_targets: Box<dyn Fn() -> HashSet<String> + Send + Sync>,
}

impl TelemetryLog {
    /// Create a log, loading or creating the installation id in `data_dir`.
    pub fn new(
        data_dir: &Path,
        app_version: &str,
        known_targets: impl Fn() -> HashSet<String> + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        Ok(TelemetryLog {
            installation_id: load_or_create_installation_id(data_dir)?,
            session_id: Uuid::new_v4().to_string(),
            app_version: app_version.to_string(),
            known_targets: Box::new(known_targets),
        })
    }

    pub fn known_targets(&self) -> HashSet<String> {
        (self.known_targets)()
    }

    /// A fresh operation id correlating request and completion events.
    pub fn begin_operation(&self) -> String {
        Uuid::new_v4().to_string()
    }

    /// Insert one event row.
    pub fn emit(&self, conn: &Connection, input: EmitInput) -> rusqlite::Result<()> {
        let known = self.known_targets();
        let targets = input
            .targets
            .as_ref()
            .map(|t| serde_json::to_string(&sanitize_targets(t, &known)).unwrap());
        conn.execute(
            "INSERT INTO telemetry_event (
               event_id, occurred_at_utc, installation_id, session_id, event_type,
               schema_version, app_version, operation_id, skill_id, commit_sha, content_hash,
               action, targets, target_app, outcome, duration_ms, error_category,
               registry_revision, visible_skill_count
             ) VALUES (
               :event_id, :occurred_at_utc, :installation_id, :session_id, :event_type,
               :schema_version, :app_version, :operation_id, :skill_id, :commit_sha, :content_hash,
               :action, :targets, :target_app, :outcome, :duration_ms, :error_category,
               :registry_revision, :visible_skill_count
             )",
            named_params! {
                ":event_id": Uuid::new_v4().to_string(),
                ":occurred_at_utc": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ":installation_id": self.installation_id,
                ":session_id": self.session_id,
                ":event_type": input.event_type.as_str(),
                ":schema_version": TELEMETRY_SCHEMA_VERSION,
                ":app_version": self.app_version,
                ":operation_id": input.operation_id,
                ":skill_id": input.skill_id,
                ":commit_sha": input.commit_sha,
                ":content_hash": input.content_hash,
                ":action": input.action.map(TelemetryAction::as_str),
                ":targets": targets,
                ":target_app": sanitize_target(input.target_app.as_deref(), &known),
                ":outcome": input.outcome.map(TelemetryOutcome::as_str),
                ":duration_ms": input.duration_ms,
                ":error_category": input.error_category.map(ErrorCategory::as_str),
                ":registry_revision": input.registry_revision,
                ":visible_skill_count": input.visible_skill_count,
            },
        )?;
        Ok(())
    }

    /// All events as JSON lines, oldest first.
    pub fn export_jsonl(&self, conn: &Connection) -> AppResult<String> {
        let known = self.known_targets();
        let mut stmt = conn.prepare(
            "SELECT event_id, occurred_at_utc, installation_id, session_id, event_type,
                    schema_version, app_version, operation_id, skill_id, commit_sha, content_hash,
                    action, targets, target_app, outcome, duration_ms, error_category,
                    registry_revision, visible_skill_count
             FROM telemetry_event ORDER BY occurred_at_utc ASC, event_id ASC",
        )?;
        let lines = stmt
            .query_map([], |row| {
                let targets: Option<String> = row.get(12)?;
                let target_app: Option<String> = row.get(13)?;
                Ok(json!({
                    "event_id": row.get::<_, String>(0)?,
                    "occurred_at_utc": row.get::<_, String>(1)?,
                    "installation_id": row.get::<_, String>(2)?,
                    "session_id": row.get::<_, String>(3)?,
                    "event_type": row.get::<_, String>(4)?,
                    "schema_version": row.get::<_, i64>(5)?,
                    "app_version": row.get::<_, String>(6)?,
                    "operation_id": row.get::<_, Option<String>>(7)?,
                    "skill_id": row.get::<_, Option<String>>(8)?,
                    "commit_sha": row.get::<_, Option<String>>(9)?,
                    "content_hash": row.get::<_, Option<String>>(10)?,
                    "action": row.get::<_, Option<String>>(11)?,
                    "targets": parse_stored_targets(targets.as_deref(), &known),
                    "target_app": sanitize_target(target_app.as_deref(), &known),
                    "outcome": row.get::<_, Option<String>>(14)?,
                    "duration_ms": row.get::<_, Option<i64>>(15)?,
                    "error_category": row.get::<_, Option<String>>(16)?,
                    "registry_revision": row.get::<_, Option<String>>(17)?,
                    "visible_skill_count": row.get::<_, Option<i64>>(18)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<Value>>>()?;
        let mut out = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        if !lines.is_empty() {
            out.push('\n');
        }
        Ok(out)
    }
}

/// An install, update or remove request, for lifecycle telemetry.
#[derive(Debug, Clone)]
pub struct InstallLifecycleRequest {
    pub action: TelemetryAction,
    pub skill_id: String,
    pub targets: Vec<String>,
    pub commit_sha: Option<String>,
    pub content_hash: Option<String>,
}

/// Handle returned by [`begin_install_lifecycle`]; reuse for completions.
#[derive(Debug, Clone)]
pub struct InstallLifecycleOperation {
    pub operation_id: String,
}

/// Outcome details used to emit per-target completion events.
#[derive(Debug, Clone, Default)]
pub struct InstallLifecycleCompletion {
    pub commit_sha: Option<String>,
    pub content_hash: Option<String>,
    pub per_target: Vec<TargetResult>,
    pub duration_ms: i64,
    pub revision_mismatch: bool,
}

/// Persist `install_requested` before the operation starts.
pub fn begin_install_lifecycle(
    log: &TelemetryLog,
    conn: &Connection,
    request: &InstallLifecycleRequest,
) -> rusqlite::Result<InstallLifecycleOperation> {
    let operation_id = log.begin_operation();
    let mut event = EmitInput::new(TelemetryEventType::InstallRequested);
    event.operation_id = Some(operation_id.clone());
    event.action = Some(request.action);
    event.skill_id = Some(request.skill_id.clone());
    event.commit_sha = request.commit_sha.clone();
    event.content_hash = request.content_hash.clone();
    event.targets = Some(sanitize_targets(&request.targets, &log.known_targets()));
    log.emit(conn, event)?;
    Ok(InstallLifecycleOperation { operation_id })
}

fn map_target_outcome(outcome: TargetOutcome) -> TelemetryOutcome {
    match outcome {
        TargetOutcome::Installed => TelemetryOutcome::Success,
        TargetOutcome::Skipped => TelemetryOutcome::Skipped,
        TargetOutcome::Failed => TelemetryOutcome::Failure,
    }
}

/// Emit one `install_target_completed` per target; with no results, every
/// requested known target is recorded as failed.
pub fn complete_install_lifecycle(
    log: &TelemetryLog,
    conn: &Connection,
    operation: &InstallLifecycleOperation,
    request: &InstallLifecycleRequest,
    completion: &InstallLifecycleCompletion,
) -> rusqlite::Result<()> {
    let fallback: Vec<TargetResult>;
    let results: &[TargetResult] = if completion.per_target.is_empty() {
        fallback = sanitize_targets(&request.targets, &log.known_targets())
            .into_iter()
            .map(|target| TargetResult {
                target,
                outcome: TargetOutcome::Failed,
                method: crate::types::InstallMethod::Copy,
                paths: Vec::new(),
                error: None,
            })
            .collect();
        &fallback
    } else {
        &completion.per_target
    };
    for result in results {
        let failed = result.outcome == TargetOutcome::Failed;
        let mut event = EmitInput::new(TelemetryEventType::InstallTargetCompleted);
        event.operation_id = Some(operation.operation_id.clone());
        event.action = Some(request.action);
        event.skill_id = Some(request.skill_id.clone());
        event.commit_sha = completion
            .commit_sha
            .clone()
            .or_else(|| request.commit_sha.clone());
        event.content_hash = completion
            .content_hash
            .clone()
            .or_else(|| request.content_hash.clone());
        event.target_app = Some(result.target.clone());
        event.outcome = Some(map_target_outcome(result.outcome));
        event.duration_ms = Some(completion.duration_ms);
        event.error_category = failed.then(|| {
            sanitize_error_category(completion.revision_mismatch, result.error.as_deref())
        });
        log.emit(conn, event)?;
    }
    Ok(())
}

/// Version dimensions of a skill, exported as null when missing or malformed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SkillTelemetryDimensions {
    pub commit_sha: Option<String>,
    pub content_hash: Option<String>,
}

fn sanitize_git_object_id(value: Option<String>) -> Option<String> {
    let value = value?;
    let valid =
        (value.len() == 40 || value.len() == 64) && value.chars().all(|c| c.is_ascii_hexdigit());
    valid.then(|| value.to_lowercase())
}

/// Read the catalogue version dimensions for a skill (soft-deleted included).
pub fn read_skill_telemetry_dimensions(
    conn: &Connection,
    registry_id: &str,
    folder_name: &str,
) -> rusqlite::Result<SkillTelemetryDimensions> {
    let row = conn
        .query_row(
            "SELECT head_provenance_sha, head_content_hash FROM skill WHERE registry_id = ?1 AND folder_name = ?2",
            [registry_id, folder_name],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let (commit_sha, content_hash) = row.unwrap_or((None, None));
    Ok(SkillTelemetryDimensions {
        commit_sha: sanitize_git_object_id(commit_sha),
        content_hash: sanitize_git_object_id(content_hash),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::types::InstallMethod;

    fn known() -> HashSet<String> {
        ["~/.claude/skills", "~/.agents/skills"]
            .into_iter()
            .map(String::from)
            .collect()
    }

    fn log(dir: &Path) -> TelemetryLog {
        TelemetryLog::new(dir, "0.0.1", known).unwrap()
    }

    fn event_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM telemetry_event", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn installation_id_is_created_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_installation_id(dir.path()).unwrap();
        assert_eq!(load_or_create_installation_id(dir.path()).unwrap(), first);
        assert_ne!(log(dir.path()).session_id, log(dir.path()).session_id);
    }

    #[test]
    fn sanitize_targets_drops_unknown_and_duplicates() {
        let input: Vec<String> = ["~/.agents/skills", "/secret/path", "~/.agents/skills"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            sanitize_targets(&input, &known()),
            vec!["~/.agents/skills".to_string()]
        );
    }

    #[test]
    fn error_categories_are_coarse() {
        assert_eq!(
            sanitize_error_category(true, Some("anything")),
            ErrorCategory::RevisionMismatch
        );
        assert_eq!(
            sanitize_error_category(false, Some("EPERM: operation not permitted")),
            ErrorCategory::LinkFailed
        );
        assert_eq!(
            sanitize_error_category(false, Some("boom")),
            ErrorCategory::CliFailed
        );
        assert_eq!(sanitize_error_category(false, None), ErrorCategory::Unknown);
    }

    #[test]
    fn emit_stores_a_row_and_exports_sanitised_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let db = open_in_memory().unwrap();
        let log = log(dir.path());
        assert_eq!(log.export_jsonl(&db).unwrap(), "");
        let mut event = EmitInput::new(TelemetryEventType::InstallRequested);
        event.targets = Some(vec!["~/.agents/skills".into(), "/nope".into()]);
        event.target_app = Some("/nope".into());
        log.emit(&db, event).unwrap();
        let out = log.export_jsonl(&db).unwrap();
        assert!(out.ends_with('\n'));
        let row: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(row["targets"], json!(["~/.agents/skills"]));
        assert_eq!(row["target_app"], Value::Null);
        assert_eq!(row["schema_version"], json!(2));
        assert_eq!(row["installation_id"], json!(log.installation_id));
    }

    #[test]
    fn lifecycle_persists_request_then_correlated_completions() {
        let dir = tempfile::tempdir().unwrap();
        let db = open_in_memory().unwrap();
        let log = log(dir.path());
        let request = InstallLifecycleRequest {
            action: TelemetryAction::Install,
            skill_id: "r/alpha".into(),
            targets: vec!["~/.agents/skills".into(), "~/.claude/skills".into()],
            commit_sha: None,
            content_hash: None,
        };
        let operation = begin_install_lifecycle(&log, &db, &request).unwrap();
        assert_eq!(event_count(&db), 1);
        let completion = InstallLifecycleCompletion {
            per_target: vec![
                TargetResult {
                    target: "~/.agents/skills".into(),
                    outcome: TargetOutcome::Installed,
                    method: InstallMethod::Copy,
                    paths: vec![],
                    error: None,
                },
                TargetResult {
                    target: "~/.claude/skills".into(),
                    outcome: TargetOutcome::Failed,
                    method: InstallMethod::Copy,
                    paths: vec![],
                    error: Some("boom".into()),
                },
            ],
            duration_ms: 5,
            ..Default::default()
        };
        complete_install_lifecycle(&log, &db, &operation, &request, &completion).unwrap();
        let mut stmt = db
            .prepare("SELECT outcome, error_category FROM telemetry_event WHERE event_type = 'install_target_completed' AND operation_id = ?1 ORDER BY target_app")
            .unwrap();
        let rows: Vec<(String, Option<String>)> = stmt
            .query_map([&operation.operation_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            rows,
            vec![
                ("success".into(), None),
                ("failure".into(), Some("cli_failed".into()))
            ]
        );
    }

    #[test]
    fn a_failure_with_no_results_records_every_requested_target_as_failed() {
        let dir = tempfile::tempdir().unwrap();
        let db = open_in_memory().unwrap();
        let log = log(dir.path());
        let request = InstallLifecycleRequest {
            action: TelemetryAction::Remove,
            skill_id: "r/alpha".into(),
            targets: vec!["~/.agents/skills".into()],
            commit_sha: None,
            content_hash: None,
        };
        let operation = begin_install_lifecycle(&log, &db, &request).unwrap();
        let completion = InstallLifecycleCompletion {
            revision_mismatch: true,
            ..Default::default()
        };
        complete_install_lifecycle(&log, &db, &operation, &request, &completion).unwrap();
        let category: String = db
            .query_row("SELECT error_category FROM telemetry_event WHERE event_type = 'install_target_completed'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(category, "revision_mismatch");
    }

    #[test]
    fn skill_dimensions_are_null_unless_valid_git_object_ids() {
        let db = open_in_memory().unwrap();
        db.execute("INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at) VALUES ('r','u','main','k','t','t')", []).unwrap();
        let good = "a".repeat(40);
        db.execute(
            "INSERT INTO skill (registry_id, folder_name, name, description, head_provenance_sha, head_content_hash) VALUES ('r','ok','n','d',?1,'not-a-hash')",
            [&good],
        )
        .unwrap();
        let dims = read_skill_telemetry_dimensions(&db, "r", "ok").unwrap();
        assert_eq!(
            dims,
            SkillTelemetryDimensions {
                commit_sha: Some(good),
                content_hash: None
            }
        );
        assert_eq!(
            read_skill_telemetry_dimensions(&db, "r", "missing").unwrap(),
            SkillTelemetryDimensions::default()
        );
    }
}
