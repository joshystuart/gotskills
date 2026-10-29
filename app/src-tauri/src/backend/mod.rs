//! Orchestration of the mirror, installer and database behind the commands.
//!
//! [`Backend`] is synchronous: every method blocks, so callers run it through
//! `tauri::async_runtime::spawn_blocking`. Mirror work (sync, install,
//! uninstall) is serialised by registry-specific locks; the database connection is
//! only ever locked for short sections, and syncs write through their own
//! connection so reads stay responsive during a fetch.

pub mod app_update;
pub mod appearance;
pub mod registry_menu;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::app_settings;
use crate::config::DEFAULT_REGISTRY;
use crate::db::{open_database, SyncMarkerStatus};
use crate::env::{DataPaths, Environment};
use crate::error::{AppError, AppResult};
use crate::installer::{
    convert_symlink_installs, detect_install_targets, install_skill, read_install_records,
    reconcile, redact_error, supported_agents, target_install_path, telemetry_targets,
    uninstall_skill, AgentInfo, InstallDeps, InstallRecordFilter, MirrorMutex, ReconcileDeps,
    UninstallDeps, REVISION_REFUSED_MESSAGE,
};
use crate::mirror::catalogue::{
    aggregate_sync_status, read_catalogue, record_sync_failure, registry_sync_status_from_marker,
};
use crate::mirror::discovery::agents::agent_table;
use crate::mirror::git::{detect_default_branch, is_git_available};
use crate::mirror::git_errors::{classify_git_error, redact_git_error};
use crate::mirror::git_exec::{git, GitError};
use crate::mirror::skill_files::{list_skill_files, read_skill_file, SkillFilesDeps};
use crate::mirror::sync::{sync_registry, SyncRegistryConfig, SyncWriteResult};
use crate::registries::{
    find_by_canonical_key, get_marker, get_registry, hard_delete_registry, insert_registry,
    list_registries, registry_label, soft_remove_registry, update_registry, InsertRegistryInput,
    StoredRegistry, UpdateRegistryFields,
};
use crate::registry_url::canonicalize_registry_url;
use crate::telemetry::TelemetryEventType;
use crate::telemetry::{
    begin_install_lifecycle, complete_install_lifecycle, read_skill_telemetry_dimensions,
    EmitInput, InstallLifecycleCompletion, InstallLifecycleRequest, TelemetryAction, TelemetryLog,
};
use crate::types::{
    skill_id, AddRegistryRequest, Appearance, AppearancePatch, AutoUpdateFailure, AutoUpdateResult,
    AutoUpdatedSkill, CatalogueSnapshot, FontSize, InstallRequest, InstallResult,
    InstallTargetStatus, ReconcileReport, ReconcileState, RegistryRecord, RegistrySyncStatus,
    SkillFileContent, SkillFileList, SkillFileReadRequest, SkillFileRequest, SyncAllResult,
    SyncFailureReason, SyncPhase, SyncStatus, TargetDetection, TargetOutcome, Theme,
    UninstallRequest, UninstallResult, UninstallTargetResult, UpdateRegistryRequest,
    MAX_REGISTRY_NAME_LENGTH,
};

/// How often installed registries are refreshed in the background.
pub const SYNC_INTERVAL: Duration = Duration::from_secs(30 * 60);

const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Notifications the backend raises while it works.
pub trait BackendEvents: Send + Sync {
    fn sync_status(&self, status: &SyncStatus);
    fn catalogue_updated(&self);
    fn auto_update_result(&self, result: &AutoUpdateResult);
    fn busy_changed(&self, busy: bool);
}

/// Discards every notification.
pub struct NoEvents;

impl BackendEvents for NoEvents {
    fn sync_status(&self, _status: &SyncStatus) {}
    fn catalogue_updated(&self) {}
    fn auto_update_result(&self, _result: &AutoUpdateResult) {}
    fn busy_changed(&self, _busy: bool) {}
}

/// Syncs one registry; replaceable so tests can simulate failures.
pub type SyncFn = Arc<
    dyn Fn(&Connection, &SyncRegistryConfig) -> Result<SyncWriteResult, GitError> + Send + Sync,
>;

/// Everything [`Backend::open`] needs.
pub struct BackendOptions {
    pub paths: DataPaths,
    pub environment: Environment,
    pub app_version: String,
    pub events: Arc<dyn BackendEvents>,
    pub sync_registry: Option<SyncFn>,
}

impl BackendOptions {
    /// Options for a real run: the default data location and the process environment.
    pub fn real(app_version: &str, events: Arc<dyn BackendEvents>) -> Self {
        BackendOptions {
            paths: DataPaths::default_location(),
            environment: Environment::real(),
            app_version: app_version.to_string(),
            events,
            sync_registry: None,
        }
    }
}

#[derive(Default)]
struct RuntimeState {
    in_flight: HashSet<String>,
    syncing: HashSet<String>,
    active_operations: usize,
    busy: bool,
}

/// The agent table in the shape the installer consumes.
pub fn agent_directory(environment: &Environment) -> Vec<AgentInfo> {
    agent_table(environment)
        .into_iter()
        .map(|agent| AgentInfo {
            id: agent.id,
            display_name: agent.display_name,
            install_folder: agent.install_folder,
            native_folder: agent.native_folder,
            detected: agent.detected,
        })
        .collect()
}

fn known_targets(environment: &Environment, database: &std::path::Path) -> HashSet<String> {
    let records = Connection::open(database)
        .ok()
        .and_then(|conn| read_install_records(&conn, &InstallRecordFilter::default()).ok())
        .unwrap_or_default();
    telemetry_targets(
        environment,
        &agent_directory(environment),
        records.into_iter().map(|record| record.target),
    )
}

fn marker_status_for(reason: SyncFailureReason) -> SyncMarkerStatus {
    match reason {
        SyncFailureReason::Offline => SyncMarkerStatus::Offline,
        SyncFailureReason::Empty => SyncMarkerStatus::Empty,
        SyncFailureReason::AccessRequired => SyncMarkerStatus::AccessRequired,
    }
}

fn is_hex_colour(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// The application backend: state plus every operation the commands expose.
pub struct Backend {
    conn: Mutex<Connection>,
    paths: DataPaths,
    environment: Environment,
    telemetry: TelemetryLog,
    mirror_mutexes: Mutex<BTreeMap<String, Arc<MirrorMutex>>>,
    events: Arc<dyn BackendEvents>,
    runtime: Mutex<RuntimeState>,
    sync_done: Condvar,
    sync_impl: SyncFn,
}

struct OperationGuard<'a>(&'a Backend);

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.0.runtime().active_operations -= 1;
        self.0.signal_busy_change();
    }
}

struct InFlightGuard<'a> {
    backend: &'a Backend,
    registry_id: String,
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.backend.runtime().in_flight.remove(&self.registry_id);
        self.backend.sync_done.notify_all();
        self.backend.signal_busy_change();
        self.backend.emit_status();
    }
}

impl Backend {
    /// Open the database, convert legacy symlink installs, start the telemetry
    /// session, seed the default registry and finish interrupted removals.
    pub fn open(options: BackendOptions) -> AppResult<Backend> {
        let BackendOptions {
            paths,
            environment,
            app_version,
            events,
            sync_registry: sync_override,
        } = options;
        let conn = open_database(&paths.database())?;
        conn.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
        convert_symlink_installs(&conn, &environment.home)?;
        let telemetry = {
            let environment = environment.clone();
            let database = paths.database();
            TelemetryLog::new(&paths.root, &app_version, move || {
                known_targets(&environment, &database)
            })?
        };
        telemetry.emit(&conn, EmitInput::new(TelemetryEventType::SessionStarted))?;

        let backend = Backend {
            conn: Mutex::new(conn),
            paths,
            environment,
            telemetry,
            mirror_mutexes: Mutex::new(BTreeMap::new()),
            events,
            runtime: Mutex::new(RuntimeState::default()),
            sync_done: Condvar::new(),
            sync_impl: sync_override.unwrap_or_else(|| Arc::new(sync_registry)),
        };
        if list_registries(&backend.db(), true)?.is_empty() {
            backend.seed_default_registry();
        }
        backend.finish_interrupted_removals()?;
        Ok(backend)
    }

    /// The telemetry log, for export and tests.
    pub fn telemetry(&self) -> &TelemetryLog {
        &self.telemetry
    }

    /// The database connection, for diagnostics and tests.
    pub fn db(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn runtime(&self) -> MutexGuard<'_, RuntimeState> {
        self.runtime.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn seed_default_registry(&self) {
        let Ok(canonical) = canonicalize_registry_url(DEFAULT_REGISTRY.url) else {
            return;
        };
        let _ = insert_registry(
            &self.db(),
            &InsertRegistryInput {
                url: DEFAULT_REGISTRY.url.to_string(),
                branch: DEFAULT_REGISTRY.branch.to_string(),
                enabled: true,
                auto_update: false,
                github_owner: canonical.github_owner,
                github_repo: canonical.github_repo,
                canonical_key: canonical.canonical_key,
            },
        );
    }

    /// Push the current sync status to listeners.
    pub fn announce_status(&self) {
        self.emit_status();
    }

    /// True while a sync, install or uninstall is running.
    pub fn is_busy(&self) -> bool {
        let runtime = self.runtime();
        runtime.active_operations > 0 || !runtime.in_flight.is_empty()
    }

    fn signal_busy_change(&self) {
        let changed = {
            let mut runtime = self.runtime();
            let now = runtime.active_operations > 0 || !runtime.in_flight.is_empty();
            if runtime.busy == now {
                None
            } else {
                runtime.busy = now;
                Some(now)
            }
        };
        if let Some(busy) = changed {
            self.events.busy_changed(busy);
        }
    }

    fn track_operation<T>(&self, work: impl FnOnce() -> T) -> T {
        self.runtime().active_operations += 1;
        self.signal_busy_change();
        let _guard = OperationGuard(self);
        work()
    }

    fn registry_status(&self, conn: &Connection, id: &str) -> AppResult<RegistrySyncStatus> {
        let mut status = registry_sync_status_from_marker(conn, id)?;
        if self.runtime().syncing.contains(id) {
            status.phase = SyncPhase::Syncing;
        }
        Ok(status)
    }

    fn compute_status_with(&self, conn: &Connection) -> AppResult<SyncStatus> {
        let mut statuses = Vec::new();
        for registry in list_registries(conn, false)?
            .into_iter()
            .filter(|registry| registry.enabled)
        {
            statuses.push(self.registry_status(conn, &registry.id)?);
        }
        Ok(aggregate_sync_status(statuses))
    }

    fn compute_status(&self) -> AppResult<SyncStatus> {
        self.compute_status_with(&self.db())
    }

    fn emit_status(&self) {
        if let Ok(status) = self.compute_status() {
            self.events.sync_status(&status);
        }
    }

    fn to_record(&self, conn: &Connection, registry: &StoredRegistry) -> AppResult<RegistryRecord> {
        Ok(RegistryRecord {
            id: registry.id.clone(),
            url: registry.url.clone(),
            branch: registry.branch.clone(),
            enabled: registry.enabled,
            auto_update: registry.auto_update,
            github_owner: registry.github_owner.clone(),
            github_repo: registry.github_repo.clone(),
            colour: registry.colour.clone(),
            name: registry.name.clone(),
            sync_status: self.registry_status(conn, &registry.id)?,
        })
    }

    fn reconcile_report(
        &self,
        conn: &Connection,
        registry_id: Option<&str>,
        folder_name: Option<&str>,
    ) -> AppResult<ReconcileReport> {
        reconcile(&ReconcileDeps {
            conn,
            environment: &self.environment,
            agents: &agent_directory(&self.environment),
            registry_id,
            folder_name,
        })
    }

    fn mirror_mutex(&self, registry_id: &str) -> Arc<MirrorMutex> {
        self.mirror_mutexes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(registry_id.to_string())
            .or_insert_with(|| Arc::new(MirrorMutex::new()))
            .clone()
    }

    fn sync_exclusive(&self, registry: &StoredRegistry) -> AppResult<RegistrySyncStatus> {
        self.mirror_mutex(&registry.id).run_exclusive(|| {
            self.runtime().syncing.insert(registry.id.clone());
            self.emit_status();
            let outcome = self.sync_locked(registry);
            self.runtime().syncing.remove(&registry.id);
            outcome
        })
    }

    fn sync_locked(&self, registry: &StoredRegistry) -> AppResult<RegistrySyncStatus> {
        if !is_git_available() {
            let conn = self.db();
            record_sync_failure(&conn, &registry.id, SyncMarkerStatus::Offline)?;
            return registry_sync_status_from_marker(&conn, &registry.id);
        }
        let config = SyncRegistryConfig {
            registry_id: registry.id.clone(),
            url: registry.url.clone(),
            branch: registry.branch.clone(),
            mirror_path: self.paths.mirror(&registry.id),
        };
        let sync_conn = open_database(&self.paths.database())?;
        sync_conn.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
        let result = (self.sync_impl)(&sync_conn, &config);
        let conn = self.db();
        match result {
            Ok(written) => {
                let mut event = EmitInput::new(TelemetryEventType::SyncCompleted);
                event.registry_revision = Some(written.revision);
                event.visible_skill_count = Some(i64::from(written.visible_skill_count));
                self.telemetry.emit(&conn, event)?;
            }
            Err(error) => {
                let reason = classify_git_error(&redact_git_error(&error.message));
                record_sync_failure(&conn, &registry.id, marker_status_for(reason))?;
            }
        }
        registry_sync_status_from_marker(&conn, &registry.id)
    }

    /// Sync one registry; concurrent requests for the same id wait for the
    /// running sync and share its result.
    fn do_sync(&self, registry: &StoredRegistry) -> AppResult<RegistrySyncStatus> {
        {
            let mut runtime = self.runtime();
            if runtime.in_flight.contains(&registry.id) {
                while runtime.in_flight.contains(&registry.id) {
                    runtime = self
                        .sync_done
                        .wait(runtime)
                        .unwrap_or_else(|p| p.into_inner());
                }
                drop(runtime);
                return self.registry_status(&self.db(), &registry.id);
            }
            runtime.in_flight.insert(registry.id.clone());
        }
        self.signal_busy_change();
        let _guard = InFlightGuard {
            backend: self,
            registry_id: registry.id.clone(),
        };
        let status = self.sync_exclusive(registry)?;
        if status.phase == SyncPhase::Synced {
            self.apply_auto_updates(&registry.id)?;
        }
        Ok(status)
    }

    fn auto_update_enabled(&self, registry_id: &str) -> AppResult<Option<StoredRegistry>> {
        Ok(get_registry(&self.db(), registry_id)?
            .filter(|r| r.enabled && r.auto_update && r.removed_at.is_none()))
    }

    fn apply_auto_updates(&self, registry_id: &str) -> AppResult<()> {
        let Some(registry) = self.auto_update_enabled(registry_id)? else {
            return Ok(());
        };
        let (skills, pending) = {
            let conn = self.db();
            let report = self.reconcile_report(&conn, None, None)?;
            let records = read_install_records(&conn, &InstallRecordFilter::default())?;
            let skills = read_catalogue(&conn, &report, &records)?.skills;
            let scoped = self.reconcile_report(&conn, Some(registry_id), None)?;
            let mut pending: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for entry in scoped
                .entries
                .iter()
                .filter(|entry| entry.state == ReconcileState::UpdateAvailable)
            {
                pending
                    .entry(entry.folder_name.clone())
                    .or_default()
                    .push(entry.target.clone());
            }
            (skills, pending)
        };
        if pending.is_empty() {
            return Ok(());
        }
        let mirror_revision = git(&self.paths.mirror(registry_id), &["rev-parse", "HEAD"])?;
        let mut result = AutoUpdateResult {
            registry_id: registry_id.to_string(),
            registry_label: registry_label(&registry),
            updated: Vec::new(),
            failed: Vec::new(),
        };
        for (folder_name, targets) in pending {
            if self.auto_update_enabled(registry_id)?.is_none() {
                break;
            }
            let name = skills
                .iter()
                .find(|skill| skill.registry_id == registry_id && skill.folder_name == folder_name)
                .map(|skill| skill.name.clone())
                .unwrap_or_else(|| folder_name.clone());
            let request = InstallRequest {
                registry_id: registry_id.to_string(),
                folder_name: folder_name.clone(),
                targets,
                mirror_revision: mirror_revision.clone(),
                acknowledge_stale: None,
            };
            match self.run_install_operation(&request, TelemetryAction::Update, true) {
                Ok(None) => {}
                Ok(Some(installed)) => {
                    let updated: Vec<String> = installed
                        .per_target
                        .iter()
                        .filter(|target| target.outcome == TargetOutcome::Installed)
                        .map(|target| target.target.clone())
                        .collect();
                    if !updated.is_empty() {
                        result.updated.push(AutoUpdatedSkill {
                            folder_name: folder_name.clone(),
                            name: name.clone(),
                            targets: updated,
                        });
                    }
                    let failures: Vec<String> = installed
                        .per_target
                        .iter()
                        .filter(|target| target.outcome == TargetOutcome::Failed)
                        .map(|target| {
                            target
                                .error
                                .clone()
                                .unwrap_or_else(|| "install failed".to_string())
                        })
                        .collect();
                    if !failures.is_empty() {
                        result.failed.push(AutoUpdateFailure {
                            folder_name,
                            name,
                            reason: failures.join("; "),
                        });
                    }
                }
                Err(error) => result.failed.push(AutoUpdateFailure {
                    folder_name,
                    name,
                    reason: redact_error(&redact_git_error(&error.message())),
                }),
            }
        }
        if !result.updated.is_empty() || !result.failed.is_empty() {
            self.events.auto_update_result(&result);
            self.events.catalogue_updated();
        }
        Ok(())
    }

    fn refresh_all(&self) -> AppResult<SyncAllResult> {
        let enabled: Vec<StoredRegistry> = list_registries(&self.db(), false)?
            .into_iter()
            .filter(|registry| registry.enabled)
            .collect();
        let concurrency = self.get_sync_concurrency();
        let next = std::sync::atomic::AtomicUsize::new(0);
        let results = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..concurrency.min(enabled.len()))
                .map(|_| {
                    scope.spawn(|| {
                        let mut results = Vec::new();
                        loop {
                            let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let Some(registry) = enabled.get(index) else {
                                break;
                            };
                            results.push((index, self.do_sync(registry)));
                        }
                        results
                    })
                })
                .collect();
            let mut results = Vec::new();
            for worker in workers {
                results.extend(worker.join().unwrap());
            }
            results.sort_by_key(|(index, _)| *index);
            results
                .into_iter()
                .map(|(_, result)| result)
                .collect::<AppResult<Vec<_>>>()
        });
        let registries = results?;
        self.emit_status();
        self.events.catalogue_updated();
        Ok(SyncAllResult { registries })
    }

    fn mirror_has_live_symlink_dependents(&self, registry_id: &str) -> AppResult<bool> {
        let mirror_path = self.paths.mirror(registry_id);
        let Ok(mirror_root) = fs::canonicalize(&mirror_path) else {
            return Ok(false);
        };
        let home = &self.environment.home;
        let mut candidates: HashSet<PathBuf> = HashSet::new();
        let folders: Vec<String> = {
            let conn = self.db();
            for record in read_install_records(
                &conn,
                &InstallRecordFilter {
                    registry_id: Some(registry_id.to_string()),
                    ..Default::default()
                },
            )? {
                candidates.extend(record.paths.iter().map(PathBuf::from));
                candidates.insert(target_install_path(
                    home,
                    &record.target,
                    &record.folder_name,
                ));
            }
            let mut statement =
                conn.prepare("SELECT DISTINCT folder_name FROM skill WHERE registry_id = ?1")?;
            let rows = statement
                .query_map([registry_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for target in self.detect_targets_now()? {
            for folder in &folders {
                candidates.insert(target_install_path(home, &target.id, folder));
            }
        }
        Ok(candidates.iter().any(|path| {
            let is_link = fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
            is_link && fs::canonicalize(path).is_ok_and(|real| real.starts_with(&mirror_root))
        }))
    }

    fn detect_targets_now(&self) -> AppResult<Vec<InstallTargetStatus>> {
        let records = read_install_records(&self.db(), &InstallRecordFilter::default())?;
        Ok(detect_install_targets(
            &self.environment,
            &agent_directory(&self.environment),
            records.into_iter().map(|record| record.target),
        ))
    }

    fn cleanup_orphan_if_exhausted(&self, registry_id: &str) -> AppResult<()> {
        let removed =
            get_registry(&self.db(), registry_id)?.is_some_and(|r| r.removed_at.is_some());
        if !removed {
            return Ok(());
        }
        let installs = read_install_records(
            &self.db(),
            &InstallRecordFilter {
                registry_id: Some(registry_id.to_string()),
                ..Default::default()
            },
        )?;
        if !installs.is_empty() || self.mirror_has_live_symlink_dependents(registry_id)? {
            return Ok(());
        }
        hard_delete_registry(&self.db(), registry_id)?;
        let _ = fs::remove_dir_all(self.paths.mirror(registry_id));
        Ok(())
    }

    fn finish_interrupted_removals(&self) -> AppResult<()> {
        let removed: Vec<String> = list_registries(&self.db(), true)?
            .into_iter()
            .filter(|registry| registry.removed_at.is_some())
            .map(|registry| registry.id)
            .collect();
        for id in removed {
            self.cleanup_orphan_if_exhausted(&id)?;
        }
        Ok(())
    }

    fn execute_install_lifecycle<T>(
        &self,
        request: &InstallLifecycleRequest,
        work: impl FnOnce() -> AppResult<(T, InstallLifecycleCompletion)>,
    ) -> AppResult<T> {
        let operation = begin_install_lifecycle(&self.telemetry, &self.db(), request)?;
        let started = Instant::now();
        let duration = || i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        match work() {
            Ok((value, mut completion)) => {
                completion.duration_ms = duration();
                let _ = complete_install_lifecycle(
                    &self.telemetry,
                    &self.db(),
                    &operation,
                    request,
                    &completion,
                );
                Ok(value)
            }
            Err(error) => {
                let completion = InstallLifecycleCompletion {
                    duration_ms: duration(),
                    revision_mismatch: error.message() == REVISION_REFUSED_MESSAGE,
                    ..Default::default()
                };
                let _ = complete_install_lifecycle(
                    &self.telemetry,
                    &self.db(),
                    &operation,
                    request,
                    &completion,
                );
                Err(error)
            }
        }
    }

    fn run_install_operation(
        &self,
        request: &InstallRequest,
        action: TelemetryAction,
        only_update_available: bool,
    ) -> AppResult<Option<InstallResult>> {
        self.track_operation(|| {
            self.mirror_mutex(&request.registry_id)
                .run_exclusive(|| self.install_locked(request, action, only_update_available))
        })
    }

    fn install_locked(
        &self,
        request: &InstallRequest,
        action: TelemetryAction,
        only_update_available: bool,
    ) -> AppResult<Option<InstallResult>> {
        let id = &request.registry_id;
        {
            let conn = self.db();
            let registry = get_registry(&conn, id)?
                .ok_or_else(|| AppError::failed(format!("Registry \"{id}\" is not configured")))?;
            if registry.removed_at.is_some() {
                return Err(AppError::failed(format!(
                    "Registry \"{id}\" has been removed. Its installations are orphaned and can only be uninstalled."
                )));
            }
            if !registry.enabled {
                return Err(AppError::failed(format!(
                    "Registry \"{id}\" is disabled. Re-enable it before installing or updating its skills."
                )));
            }
            if get_marker(&conn, id)?.is_some_and(|marker| marker.stale)
                && request.acknowledge_stale != Some(true)
            {
                return Err(AppError::failed(
                    "This registry snapshot is stale after a failed sync. Acknowledge staleness to proceed.",
                ));
            }
        }
        let mirror_path = self.paths.mirror(id);
        let current_revision = git(&mirror_path, &["rev-parse", "HEAD"])?;
        let mut request = request.clone();
        if only_update_available {
            let report = self.reconcile_report(
                &self.db(),
                Some(&request.registry_id),
                Some(&request.folder_name),
            )?;
            request.targets.retain(|target| {
                report.entries.iter().any(|entry| {
                    &entry.target == target && entry.state == ReconcileState::UpdateAvailable
                })
            });
            if request.targets.is_empty() {
                return Ok(None);
            }
        }
        let dimensions = read_skill_telemetry_dimensions(
            &self.db(),
            &request.registry_id,
            &request.folder_name,
        )?;
        let lifecycle = InstallLifecycleRequest {
            action,
            skill_id: skill_id(&request.registry_id, &request.folder_name),
            targets: request.targets.clone(),
            commit_sha: dimensions.commit_sha,
            content_hash: dimensions.content_hash,
        };
        let result = self.execute_install_lifecycle(&lifecycle, || {
            let conn = self.db();
            let installed = install_skill(
                &InstallDeps {
                    conn: &conn,
                    registry_id: &request.registry_id,
                    mirror_path: &mirror_path,
                    environment: &self.environment,
                    current_revision: &current_revision,
                },
                &request,
            )?;
            let completion = InstallLifecycleCompletion {
                commit_sha: Some(installed.provenance_sha.clone()),
                content_hash: Some(installed.content_hash.clone()),
                per_target: installed.per_target.clone(),
                ..Default::default()
            };
            Ok((installed, completion))
        })?;
        self.events.catalogue_updated();
        Ok(Some(result))
    }

    /// Refresh every enabled registry and return the aggregate status.
    pub fn sync_now(&self) -> AppResult<SyncStatus> {
        self.refresh_all()?;
        self.compute_status()
    }

    pub fn detect_targets(&self) -> AppResult<TargetDetection> {
        Ok(TargetDetection {
            targets: self.detect_targets_now()?,
            agents: supported_agents(&self.environment, &agent_directory(&self.environment)),
        })
    }

    pub fn install(&self, request: &InstallRequest) -> AppResult<InstallResult> {
        self.run_install_operation(request, TelemetryAction::Install, false)?
            .ok_or_else(|| AppError::failed("install failed"))
    }

    pub fn repair(&self, request: &InstallRequest) -> AppResult<InstallResult> {
        self.run_install_operation(request, TelemetryAction::Update, false)?
            .ok_or_else(|| AppError::failed("repair failed"))
    }

    pub fn reconcile(
        &self,
        registry_id: Option<&str>,
        folder_name: Option<&str>,
    ) -> AppResult<ReconcileReport> {
        self.reconcile_report(&self.db(), registry_id, folder_name)
    }

    pub fn uninstall(&self, request: &UninstallRequest) -> AppResult<UninstallResult> {
        self.track_operation(|| {
            let dimensions = read_skill_telemetry_dimensions(
                &self.db(),
                &request.registry_id,
                &request.folder_name,
            )?;
            let lifecycle = InstallLifecycleRequest {
                action: TelemetryAction::Remove,
                skill_id: skill_id(&request.registry_id, &request.folder_name),
                targets: request.targets.clone(),
                commit_sha: dimensions.commit_sha,
                content_hash: dimensions.content_hash,
            };
            let result = self.execute_install_lifecycle(&lifecycle, || {
                self.mirror_mutex(&request.registry_id).run_exclusive(|| {
                    let conn = self.db();
                    let removed = uninstall_skill(
                        &UninstallDeps {
                            conn: &conn,
                            home: &self.environment.home,
                        },
                        request,
                    )?;
                    let completion = InstallLifecycleCompletion {
                        per_target: removed.per_target.iter().map(to_target_result).collect(),
                        ..Default::default()
                    };
                    Ok((removed, completion))
                })
            })?;
            self.cleanup_orphan_if_exhausted(&request.registry_id)?;
            self.events.catalogue_updated();
            Ok(result)
        })
    }

    pub fn get_catalogue(&self) -> AppResult<CatalogueSnapshot> {
        let conn = self.db();
        let report = self.reconcile_report(&conn, None, None)?;
        let records = read_install_records(&conn, &InstallRecordFilter::default())?;
        let snapshot = read_catalogue(&conn, &report, &records)?;
        Ok(CatalogueSnapshot {
            skills: snapshot.skills,
            sync_status: self.compute_status_with(&conn)?,
        })
    }

    pub fn refresh(&self) -> AppResult<SyncAllResult> {
        self.refresh_all()
    }

    pub fn get_sync_status(&self) -> AppResult<SyncStatus> {
        self.compute_status()
    }

    pub fn list_registries(&self) -> AppResult<Vec<RegistryRecord>> {
        let conn = self.db();
        list_registries(&conn, false)?
            .iter()
            .map(|registry| self.to_record(&conn, registry))
            .collect()
    }

    pub fn add_registry(&self, request: &AddRegistryRequest) -> AppResult<RegistryRecord> {
        let canonical = canonicalize_registry_url(&request.url)?;
        if let Some(existing) = find_by_canonical_key(&self.db(), &canonical.canonical_key)? {
            return Err(AppError::failed(format!(
                "A registry for {} is already configured (id {}).",
                registry_label(&existing),
                existing.id
            )));
        }
        let branch = match request
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
        {
            Some(branch) => branch.to_string(),
            None => {
                if !is_git_available() {
                    return Err(AppError::failed(
                        "Git is unavailable; specify a branch for this registry.",
                    ));
                }
                detect_default_branch(&canonical.url).map_err(|_| {
                    AppError::failed(
                        "Could not detect the default branch; specify a branch for this registry.",
                    )
                })?
            }
        };
        let stored = insert_registry(
            &self.db(),
            &InsertRegistryInput {
                url: canonical.url,
                branch,
                enabled: request.enabled.unwrap_or(true),
                auto_update: false,
                github_owner: canonical.github_owner,
                github_repo: canonical.github_repo,
                canonical_key: canonical.canonical_key,
            },
        )?;
        if stored.enabled {
            self.do_sync(&stored)?;
        }
        self.events.catalogue_updated();
        self.emit_status();
        self.registry_record(&stored.id)
    }

    fn registry_record(&self, id: &str) -> AppResult<RegistryRecord> {
        let conn = self.db();
        let registry = get_registry(&conn, id)?
            .ok_or_else(|| AppError::not_found(format!("Registry \"{id}\" not found")))?;
        self.to_record(&conn, &registry)
    }

    /// One registry as the UI sees it, or an error when it does not exist.
    pub fn registry(&self, id: &str) -> AppResult<RegistryRecord> {
        self.list_registries()?
            .into_iter()
            .find(|registry| registry.id == id)
            .ok_or_else(|| AppError::not_found(format!("Registry \"{id}\" not found")))
    }

    pub fn update_registry(&self, request: &UpdateRegistryRequest) -> AppResult<RegistryRecord> {
        let not_configured =
            || AppError::failed(format!("Registry \"{}\" is not configured", request.id));
        let (current, fields) = {
            let conn = self.db();
            let current = get_registry(&conn, &request.id)?
                .filter(|registry| registry.removed_at.is_none())
                .ok_or_else(not_configured)?;
            let mut fields = UpdateRegistryFields::default();
            if let Some(url) = request
                .url
                .as_deref()
                .filter(|url| url.trim() != current.url)
            {
                let canonical = canonicalize_registry_url(url)?;
                if let Some(clash) = find_by_canonical_key(&conn, &canonical.canonical_key)?
                    .filter(|clash| clash.id != current.id)
                {
                    return Err(AppError::failed(format!(
                        "A registry for {} is already configured (id {}).",
                        registry_label(&clash),
                        clash.id
                    )));
                }
                fields.url = Some(canonical.url);
                fields.github_owner = Some(canonical.github_owner);
                fields.github_repo = Some(canonical.github_repo);
                fields.canonical_key = Some(canonical.canonical_key);
            }
            if let Some(branch) = request
                .branch
                .as_deref()
                .map(str::trim)
                .filter(|b| !b.is_empty() && *b != current.branch)
            {
                fields.branch = Some(branch.to_string());
            }
            fields.enabled = request.enabled;
            fields.auto_update = request.auto_update;
            if let Some(colour) = &request.colour {
                if !is_hex_colour(colour) {
                    return Err(AppError::invalid(format!(
                        "\"{colour}\" is not a #rrggbb colour."
                    )));
                }
                fields.colour = Some(colour.to_lowercase());
            }
            if let Some(name) = &request.name {
                let name = name.trim();
                if name.chars().count() > MAX_REGISTRY_NAME_LENGTH {
                    return Err(AppError::invalid(format!(
                        "A registry name can be at most {MAX_REGISTRY_NAME_LENGTH} characters."
                    )));
                }
                fields.name = Some((!name.is_empty()).then(|| name.to_string()));
            }
            (current, fields)
        };
        let url_or_branch_changed = fields.url.is_some() || fields.branch.is_some();
        let updated = update_registry(&self.db(), &request.id, fields)?;
        let enabled_from_disabled = request.enabled == Some(true) && !current.enabled;
        let auto_update_enabled = request.auto_update == Some(true) && !current.auto_update;
        if updated.enabled
            && (url_or_branch_changed || enabled_from_disabled || auto_update_enabled)
        {
            self.do_sync(&updated)?;
        }
        self.events.catalogue_updated();
        self.emit_status();
        self.registry_record(&request.id)
    }

    pub fn remove_registry(&self, id: &str) -> AppResult<()> {
        if get_registry(&self.db(), id)?.is_none() {
            return Ok(());
        }
        soft_remove_registry(&self.db(), id)?;
        self.cleanup_orphan_if_exhausted(id)?;
        self.events.catalogue_updated();
        self.emit_status();
        Ok(())
    }

    pub fn sync_registry(&self, id: &str) -> AppResult<RegistrySyncStatus> {
        let registry = get_registry(&self.db(), id)?
            .ok_or_else(|| AppError::failed(format!("Registry \"{id}\" is not configured")))?;
        if !registry.enabled || registry.removed_at.is_some() {
            return self.registry_status(&self.db(), id);
        }
        let status = self.do_sync(&registry)?;
        self.events.catalogue_updated();
        self.emit_status();
        Ok(status)
    }

    pub fn list_skill_files(&self, request: &SkillFileRequest) -> AppResult<SkillFileList> {
        let conn = self.db();
        let mirror_path_for = |id: &str| self.paths.mirror(id);
        list_skill_files(
            &SkillFilesDeps {
                conn: &conn,
                mirror_path_for: &mirror_path_for,
            },
            request,
        )
    }

    pub fn read_skill_file(&self, request: &SkillFileReadRequest) -> AppResult<SkillFileContent> {
        let conn = self.db();
        let mirror_path_for = |id: &str| self.paths.mirror(id);
        read_skill_file(
            &SkillFilesDeps {
                conn: &conn,
                mirror_path_for: &mirror_path_for,
            },
            request,
        )
    }

    pub fn get_sync_concurrency(&self) -> usize {
        app_settings::get_sync_concurrency(&self.db())
    }

    pub fn set_sync_concurrency(&self, concurrency: usize) -> AppResult<()> {
        Ok(app_settings::set_sync_concurrency(&self.db(), concurrency)?)
    }

    pub fn get_auto_download_app_updates(&self) -> bool {
        app_settings::get_auto_download_app_updates(&self.db())
    }

    pub fn set_auto_download_app_updates(&self, enabled: bool) -> AppResult<()> {
        Ok(app_settings::set_auto_download_app_updates(
            &self.db(),
            enabled,
        )?)
    }

    pub fn get_appearance(&self) -> Appearance {
        app_settings::get_appearance(&self.db())
    }

    pub fn set_theme(&self, theme: Theme) -> AppResult<()> {
        Ok(app_settings::set_appearance(
            &self.db(),
            AppearancePatch {
                theme: Some(theme),
                font_size: None,
            },
        )?)
    }

    pub fn set_font_size(&self, font_size: FontSize) -> AppResult<()> {
        Ok(app_settings::set_appearance(
            &self.db(),
            AppearancePatch {
                theme: None,
                font_size: Some(font_size),
            },
        )?)
    }
}

fn to_target_result(target: &UninstallTargetResult) -> crate::types::TargetResult {
    crate::types::TargetResult {
        target: target.target.clone(),
        outcome: target.outcome,
        method: crate::types::InstallMethod::Copy,
        paths: target.paths.clone(),
        error: target.error.clone(),
    }
}
