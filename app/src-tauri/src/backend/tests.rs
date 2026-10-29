use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::*;
use crate::mirror::test_support::{commit_all, git as run_git, make_repo, write_skill};
use crate::types::SyncPhase;

#[derive(Default)]
struct Recorder {
    statuses: Mutex<Vec<SyncStatus>>,
    catalogue_updates: Mutex<usize>,
    auto_updates: Mutex<Vec<AutoUpdateResult>>,
    busy: Mutex<Vec<bool>>,
}

impl BackendEvents for Recorder {
    fn sync_status(&self, status: &SyncStatus) {
        self.statuses.lock().unwrap().push(status.clone());
    }

    fn catalogue_updated(&self) {
        *self.catalogue_updates.lock().unwrap() += 1;
    }

    fn auto_update_result(&self, result: &AutoUpdateResult) {
        self.auto_updates.lock().unwrap().push(result.clone());
    }

    fn busy_changed(&self, busy: bool) {
        self.busy.lock().unwrap().push(busy);
    }
}

struct Harness {
    backend: Backend,
    events: Arc<Recorder>,
    data: tempfile::TempDir,
    home: tempfile::TempDir,
}

fn open_with(data: &Path, home: &Path, events: Arc<Recorder>, sync: Option<SyncFn>) -> Backend {
    Backend::open(BackendOptions {
        paths: DataPaths::new(data),
        environment: Environment::fake_home(home),
        app_version: "0.0.0-test".into(),
        events,
        sync_registry: sync,
    })
    .unwrap()
}

fn harness_with(sync: Option<SyncFn>) -> Harness {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(".claude")).unwrap();
    let events = Arc::new(Recorder::default());
    let backend = open_with(data.path(), home.path(), events.clone(), sync);
    Harness {
        backend,
        events,
        data,
        home,
    }
}

fn harness() -> Harness {
    harness_with(None)
}

fn without_default(backend: &Backend) {
    for registry in backend.list_registries().unwrap() {
        backend.remove_registry(&registry.id).unwrap();
    }
}

fn remote(ids: &[&str]) -> tempfile::TempDir {
    let remote = make_repo();
    for id in ids {
        write_skill(
            remote.path(),
            &format!("skills/{id}"),
            Some(&format!("name: {id}\ndescription: {id} description")),
        );
    }
    commit_all(remote.path(), "seed");
    remote
}

fn add(backend: &Backend, remote: &Path) -> RegistryRecord {
    backend
        .add_registry(&AddRegistryRequest {
            url: format!("file://{}", remote.display()),
            branch: Some("main".into()),
            enabled: None,
        })
        .unwrap()
}

fn update(id: &str) -> UpdateRegistryRequest {
    UpdateRegistryRequest {
        id: id.into(),
        url: None,
        branch: None,
        enabled: None,
        auto_update: None,
        colour: None,
        name: None,
    }
}

fn install_request(registry: &RegistryRecord, folder: &str, targets: &[&str]) -> InstallRequest {
    InstallRequest {
        registry_id: registry.id.clone(),
        folder_name: folder.into(),
        targets: targets.iter().map(|t| t.to_string()).collect(),
        mirror_revision: registry.sync_status.revision.clone().unwrap(),
        acknowledge_stale: None,
    }
}

fn current(backend: &Backend, id: &str) -> RegistryRecord {
    backend.registry(id).unwrap()
}

fn folders(backend: &Backend) -> Vec<String> {
    let mut names: Vec<String> = backend
        .get_catalogue()
        .unwrap()
        .skills
        .into_iter()
        .map(|skill| skill.folder_name)
        .collect();
    names.sort();
    names
}

fn telemetry_events(backend: &Backend, event_type: &str) -> i64 {
    backend
        .db()
        .query_row(
            "SELECT count(*) FROM telemetry_event WHERE event_type = ?1",
            [event_type],
            |row| row.get(0),
        )
        .unwrap()
}

fn change_remote(remote: &Path, ids: &[&str], description: &str) {
    for id in ids {
        write_skill(
            remote,
            &format!("skills/{id}"),
            Some(&format!("name: {id}\ndescription: {description}")),
        );
    }
    run_git(remote, &["add", "-A"]);
    run_git(remote, &["commit", "-m", "change"]);
}

fn failing_sync(message: &'static str) -> SyncFn {
    Arc::new(move |_conn, _config| Err(GitError::new(message)))
}

#[test]
fn starts_with_an_empty_catalogue_before_the_first_sync() {
    let h = harness();
    assert!(h.backend.get_catalogue().unwrap().skills.is_empty());
}

#[test]
fn detects_claude_code_the_shared_target_and_own_folder_targets() {
    let h = harness();
    let ids: Vec<String> = h
        .backend
        .detect_targets()
        .unwrap()
        .targets
        .into_iter()
        .map(|target| target.id)
        .collect();
    for expected in [
        "~/.claude/skills",
        "~/.agents/skills",
        "~/.config/goose/skills",
        "~/.zencoder/skills",
    ] {
        assert!(ids.contains(&expected.to_string()), "{expected} in {ids:?}");
    }
}

#[test]
fn supported_agents_leave_out_the_universal_pseudo_agent() {
    let h = harness();
    let agents = h.backend.detect_targets().unwrap().agents;
    assert!(agents.iter().any(|agent| agent.id == "claude-code"));
    for left_out in ["universal", "eve", "promptscript"] {
        assert!(agents.iter().all(|agent| agent.id != left_out));
    }
}

#[test]
fn seeds_the_shipped_default_registry_on_first_start() {
    let h = harness();
    let registries = h.backend.list_registries().unwrap();
    assert_eq!(registries.len(), 1);
    assert_eq!(registries[0].url, DEFAULT_REGISTRY.url);
    assert_eq!(registries[0].branch, DEFAULT_REGISTRY.branch);
    assert!(registries[0].enabled);
    assert_eq!(registries[0].github_owner.as_deref(), Some("anthropics"));
    assert_eq!(registries[0].github_repo.as_deref(), Some("skills"));
}

#[test]
fn adds_two_registries_and_unions_their_catalogues() {
    let h = harness();
    without_default(&h.backend);
    let a = remote(&["alpha", "beta"]);
    let b = remote(&["to-spec", "wayfinder"]);
    let first = add(&h.backend, a.path());
    let second = add(&h.backend, b.path());

    let snapshot = h.backend.get_catalogue().unwrap();
    assert_eq!(
        folders(&h.backend),
        ["alpha", "beta", "to-spec", "wayfinder"]
    );
    let owner = |folder: &str| {
        snapshot
            .skills
            .iter()
            .find(|skill| skill.folder_name == folder)
            .unwrap()
            .registry_id
            .clone()
    };
    assert_eq!(owner("alpha"), first.id);
    assert_eq!(owner("to-spec"), second.id);
    assert!(snapshot.skills.iter().all(|skill| !skill.conflict));
    assert_eq!(
        snapshot.sync_status.phase,
        crate::types::CatalogueSyncPhase::Synced
    );
    assert_eq!(snapshot.sync_status.registries.len(), 2);
}

#[test]
fn flags_a_skill_conflict_when_two_registries_share_a_folder_name() {
    let h = harness();
    without_default(&h.backend);
    let a = remote(&["grilling"]);
    let b = remote(&["grilling"]);
    add(&h.backend, a.path());
    add(&h.backend, b.path());
    let skills = h.backend.get_catalogue().unwrap().skills;
    assert_eq!(skills.len(), 2);
    assert!(skills.iter().all(|skill| skill.conflict));
}

#[test]
fn enforces_one_registry_per_github_repo() {
    let h = harness();
    let error = h
        .backend
        .add_registry(&AddRegistryRequest {
            url: "git@github.com:Anthropics/Skills.git".into(),
            branch: Some("main".into()),
            enabled: None,
        })
        .unwrap_err();
    assert!(error.message().contains("already configured"), "{error}");
}

#[test]
fn disabling_a_registry_hides_its_skills_without_deleting_them() {
    let h = harness();
    without_default(&h.backend);
    let a = remote(&["alpha"]);
    let registry = add(&h.backend, a.path());
    assert_eq!(folders(&h.backend), ["alpha"]);

    let mut disable = update(&registry.id);
    disable.enabled = Some(false);
    h.backend.update_registry(&disable).unwrap();
    assert!(folders(&h.backend).is_empty());

    let mut enable = update(&registry.id);
    enable.enabled = Some(true);
    h.backend.update_registry(&enable).unwrap();
    assert_eq!(folders(&h.backend), ["alpha"]);
}

#[test]
fn removing_a_registry_without_installs_drops_it_and_its_mirror() {
    let h = harness();
    without_default(&h.backend);
    let a = remote(&["alpha"]);
    let registry = add(&h.backend, a.path());
    let mirror = h.data.path().join("mirrors").join(&registry.id);
    assert!(mirror.exists());

    h.backend.remove_registry(&registry.id).unwrap();

    assert!(h.backend.list_registries().unwrap().is_empty());
    assert!(folders(&h.backend).is_empty());
    assert!(!mirror.exists());
    assert!(get_registry(&h.backend.db(), &registry.id)
        .unwrap()
        .is_none());
}

#[test]
fn persists_registries_and_snapshots_across_relaunch() {
    let h = harness();
    without_default(&h.backend);
    let a = remote(&["one"]);
    let added = add(&h.backend, a.path());
    let Harness {
        backend,
        data,
        home,
        ..
    } = h;
    drop(backend);

    let second = open_with(
        data.path(),
        home.path(),
        Arc::new(Recorder::default()),
        None,
    );
    let ids: Vec<String> = second
        .list_registries()
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, [added.id]);
    assert_eq!(folders(&second), ["one"]);
}

#[test]
fn colour_is_null_until_chosen_stored_lowercase_and_validated() {
    let h = harness();
    let seeded = h.backend.list_registries().unwrap().remove(0);
    assert_eq!(seeded.colour, None);

    let mut request = update(&seeded.id);
    request.colour = Some("#AABBCC".into());
    assert_eq!(
        h.backend
            .update_registry(&request)
            .unwrap()
            .colour
            .as_deref(),
        Some("#aabbcc")
    );

    for bad in ["red", "#fff", "url(x)"] {
        let mut request = update(&seeded.id);
        request.colour = Some(bad.into());
        assert!(h.backend.update_registry(&request).is_err(), "{bad}");
    }
    assert_eq!(
        current(&h.backend, &seeded.id).colour.as_deref(),
        Some("#aabbcc")
    );

    let mut other = update(&seeded.id);
    other.enabled = Some(false);
    assert_eq!(
        h.backend.update_registry(&other).unwrap().colour.as_deref(),
        Some("#aabbcc")
    );
}

#[test]
fn name_is_trimmed_cleared_by_blank_and_bounded() {
    let h = harness();
    let seeded = h.backend.list_registries().unwrap().remove(0);
    assert_eq!(seeded.name, None);

    let mut request = update(&seeded.id);
    request.name = Some("  Team skills  ".into());
    assert_eq!(
        h.backend.update_registry(&request).unwrap().name.as_deref(),
        Some("Team skills")
    );

    for blank in ["", "   "] {
        let mut request = update(&seeded.id);
        request.name = Some("Team skills".into());
        h.backend.update_registry(&request).unwrap();
        request.name = Some(blank.into());
        assert_eq!(h.backend.update_registry(&request).unwrap().name, None);
    }

    let mut too_long = update(&seeded.id);
    too_long.name = Some("x".repeat(41));
    assert!(h.backend.update_registry(&too_long).is_err());
    let mut longest = update(&seeded.id);
    longest.name = Some("x".repeat(40));
    assert_eq!(
        h.backend.update_registry(&longest).unwrap().name,
        Some("x".repeat(40))
    );

    let mut other = update(&seeded.id);
    other.enabled = Some(false);
    assert_eq!(
        h.backend.update_registry(&other).unwrap().name,
        Some("x".repeat(40))
    );
}

#[test]
fn updating_an_unknown_registry_fails() {
    let h = harness();
    assert!(h.backend.update_registry(&update("missing")).is_err());
}

#[test]
fn a_missing_remote_fails_with_offline_and_matches_across_apis() {
    let h = harness();
    without_default(&h.backend);
    let missing = h.data.path().join("no-such-remote");
    let record = add(&h.backend, &missing);
    assert_eq!(record.sync_status.phase, SyncPhase::Failed);

    let status = h.backend.get_sync_status().unwrap();
    assert_eq!(status.phase, crate::types::CatalogueSyncPhase::Failed);
    assert_eq!(status.reason, Some(SyncFailureReason::Offline));
    assert_eq!(h.backend.get_catalogue().unwrap().sync_status, status);
}

#[test]
fn records_access_required_for_an_ambiguous_auth_failure() {
    let h = harness_with(Some(failing_sync(
        "fatal: Authentication failed for 'https://x-access-token:ghp_secret@github.com/o/p.git/'",
    )));
    without_default(&h.backend);
    let private = h
        .backend
        .add_registry(&AddRegistryRequest {
            url: "https://github.com/example-org/private-skills".into(),
            branch: Some("main".into()),
            enabled: None,
        })
        .unwrap();
    assert_eq!(private.sync_status.phase, SyncPhase::Failed);
    assert_eq!(
        private.sync_status.reason,
        Some(SyncFailureReason::AccessRequired)
    );
    assert_eq!(private.sync_status.stale, Some(true));
}

#[test]
fn an_inaccessible_registry_does_not_block_others() {
    let sync: SyncFn = Arc::new(move |conn, config| {
        if config.url.starts_with("https://") {
            return Err(GitError::new("remote: Repository not found."));
        }
        sync_registry(conn, config)
    });
    let h = harness_with(Some(sync));
    without_default(&h.backend);
    let public = remote(&["alpha"]);
    let private = h
        .backend
        .add_registry(&AddRegistryRequest {
            url: "https://github.com/example-org/private-skills".into(),
            branch: Some("main".into()),
            enabled: None,
        })
        .unwrap();
    let local = add(&h.backend, public.path());

    assert_eq!(
        private.sync_status.reason,
        Some(SyncFailureReason::AccessRequired)
    );
    assert_eq!(local.sync_status.phase, SyncPhase::Synced);
    assert_eq!(
        h.backend.get_sync_status().unwrap().phase,
        crate::types::CatalogueSyncPhase::Partial
    );
    assert_eq!(folders(&h.backend), ["alpha"]);
}

#[test]
fn installs_updates_and_uninstalls_with_lifecycle_telemetry() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());
    let target = "~/.claude/skills";
    let installed_path = h.home.path().join(".claude/skills/alpha/SKILL.md");

    let result = h
        .backend
        .install(&install_request(&registry, "alpha", &[target]))
        .unwrap();
    assert_eq!(result.per_target[0].outcome, TargetOutcome::Installed);
    assert!(installed_path.exists());
    assert_eq!(telemetry_events(&h.backend, "install_requested"), 1);
    assert_eq!(telemetry_events(&h.backend, "install_target_completed"), 1);
    assert_eq!(telemetry_events(&h.backend, "session_started"), 1);

    let report = h
        .backend
        .reconcile(Some(&registry.id), Some("alpha"))
        .unwrap();
    assert!(report
        .entries
        .iter()
        .any(|e| e.target == target && e.state == ReconcileState::Installed));

    let removed = h
        .backend
        .uninstall(&UninstallRequest {
            registry_id: registry.id.clone(),
            folder_name: "alpha".into(),
            targets: vec![target.into()],
        })
        .unwrap();
    assert_eq!(removed.per_target[0].outcome, TargetOutcome::Installed);
    assert!(!installed_path.exists());
    assert_eq!(telemetry_events(&h.backend, "install_requested"), 2);
    assert!(*h.events.catalogue_updates.lock().unwrap() > 0);
}

#[test]
fn refuses_a_stale_revision_and_records_a_failed_target() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());
    let mut request = install_request(&registry, "alpha", &["~/.claude/skills"]);
    request.mirror_revision = "0".repeat(40);

    let error = h.backend.install(&request).unwrap_err();

    assert_eq!(error.message(), REVISION_REFUSED_MESSAGE);
    assert!(!h.home.path().join(".claude/skills/alpha").exists());
    assert_eq!(telemetry_events(&h.backend, "install_target_completed"), 1);
    let category: String = h
        .backend
        .db()
        .query_row(
            "SELECT error_category FROM telemetry_event WHERE event_type = 'install_target_completed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(category, "revision_mismatch");
}

#[test]
fn installing_requires_acknowledging_a_stale_snapshot() {
    let fail = Arc::new(Mutex::new(false));
    let gate = fail.clone();
    let sync: SyncFn = Arc::new(move |conn, config| {
        if *gate.lock().unwrap() {
            return Err(GitError::new("fatal: unable to access remote"));
        }
        sync_registry(conn, config)
    });
    let h = harness_with(Some(sync));
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());

    *fail.lock().unwrap() = true;
    h.backend.sync_registry(&registry.id).unwrap();
    let mut request = install_request(&registry, "alpha", &["~/.claude/skills"]);
    let error = h.backend.install(&request).unwrap_err();
    assert!(error.message().contains("stale"), "{error}");

    request.acknowledge_stale = Some(true);
    assert!(h.backend.install(&request).is_ok());
}

#[test]
fn installing_from_a_disabled_or_unknown_registry_fails() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());
    let request = install_request(&registry, "alpha", &["~/.claude/skills"]);

    let mut disable = update(&registry.id);
    disable.enabled = Some(false);
    h.backend.update_registry(&disable).unwrap();
    assert!(h
        .backend
        .install(&request)
        .unwrap_err()
        .message()
        .contains("disabled"));

    let mut unknown = request.clone();
    unknown.registry_id = "nope".into();
    assert!(h
        .backend
        .install(&unknown)
        .unwrap_err()
        .message()
        .contains("not configured"));
}

#[test]
fn a_collision_with_an_external_folder_is_reported_structurally() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());
    let outside = h.home.path().join(".claude/skills/alpha");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("SKILL.md"), "outside this app").unwrap();

    let error = h
        .backend
        .install(&install_request(&registry, "alpha", &["~/.claude/skills"]))
        .unwrap_err();

    assert!(
        matches!(error, AppError::InstallationCollision { .. }),
        "{error:?}"
    );
}

#[test]
fn removing_a_registry_with_installs_orphans_it_until_uninstalled() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());
    let target = "~/.claude/skills";
    h.backend
        .install(&install_request(&registry, "alpha", &[target]))
        .unwrap();
    let mirror = h.data.path().join("mirrors").join(&registry.id);

    h.backend.remove_registry(&registry.id).unwrap();

    assert!(h.backend.list_registries().unwrap().is_empty());
    assert!(mirror.exists());
    let orphan = h
        .backend
        .get_catalogue()
        .unwrap()
        .skills
        .into_iter()
        .find(|skill| skill.folder_name == "alpha")
        .unwrap();
    assert!(orphan.orphaned);

    h.backend
        .uninstall(&UninstallRequest {
            registry_id: registry.id.clone(),
            folder_name: "alpha".into(),
            targets: vec![target.into()],
        })
        .unwrap();

    assert!(!mirror.exists());
    assert!(get_registry(&h.backend.db(), &registry.id)
        .unwrap()
        .is_none());
}

#[test]
fn a_changed_branch_resyncs_the_registry() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    run_git(source.path(), &["checkout", "-b", "next"]);
    write_skill(
        source.path(),
        "skills/gamma",
        Some("name: gamma\ndescription: gamma description"),
    );
    commit_all(source.path(), "next");
    run_git(source.path(), &["checkout", "main"]);
    let registry = add(&h.backend, source.path());
    assert_eq!(folders(&h.backend), ["alpha"]);

    let mut request = update(&registry.id);
    request.branch = Some("next".into());
    let updated = h.backend.update_registry(&request).unwrap();

    assert_eq!(updated.branch, "next");
    assert_eq!(folders(&h.backend), ["alpha", "gamma"]);
}

#[test]
fn auto_update_brings_installed_skills_current_and_reports_it() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha", "beta"]);
    let registry = add(&h.backend, source.path());
    let target = "~/.claude/skills";
    h.backend
        .install(&install_request(&registry, "alpha", &[target]))
        .unwrap();
    let mut enable = update(&registry.id);
    enable.auto_update = Some(true);
    h.backend.update_registry(&enable).unwrap();

    change_remote(source.path(), &["alpha", "beta"], "changed");
    h.backend.sync_registry(&registry.id).unwrap();

    let results = h.events.auto_updates.lock().unwrap().clone();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].registry_id, registry.id);
    assert_eq!(
        results[0].updated,
        [AutoUpdatedSkill {
            folder_name: "alpha".into(),
            name: "alpha".into(),
            targets: vec![target.into()]
        }]
    );
    assert!(results[0].failed.is_empty());
    let body = fs::read_to_string(h.home.path().join(".claude/skills/alpha/SKILL.md")).unwrap();
    assert!(body.contains("description: changed"));
    assert!(!h.home.path().join(".claude/skills/beta").exists());
}

#[test]
fn unchanged_sync_is_synced_without_running_auto_update() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());
    h.backend
        .install(&install_request(&registry, "alpha", &["~/.claude/skills"]))
        .unwrap();
    change_remote(source.path(), &["alpha"], "changed");
    h.backend.sync_registry(&registry.id).unwrap();
    let mut enable = update(&registry.id);
    enable.auto_update = Some(true);
    h.backend.update_registry(&enable).unwrap();
    h.backend.sync_registry(&registry.id).unwrap();
    let status = current(&h.backend, &registry.id).sync_status;
    assert_eq!(status.phase, SyncPhase::Synced);
    assert_eq!(status.stale, Some(false));
    assert!(h.events.auto_updates.lock().unwrap().is_empty());
    let body = fs::read_to_string(h.home.path().join(".claude/skills/alpha/SKILL.md")).unwrap();
    assert!(!body.contains("description: changed"));
}

#[test]
fn without_auto_update_a_sync_leaves_installs_behind() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());
    h.backend
        .install(&install_request(&registry, "alpha", &["~/.claude/skills"]))
        .unwrap();

    change_remote(source.path(), &["alpha"], "changed");
    h.backend.sync_registry(&registry.id).unwrap();

    assert!(h.events.auto_updates.lock().unwrap().is_empty());
    let report = h
        .backend
        .reconcile(Some(&registry.id), Some("alpha"))
        .unwrap();
    assert!(report
        .entries
        .iter()
        .any(|e| e.state == ReconcileState::UpdateAvailable));
}

#[test]
fn syncing_emits_status_and_toggles_busy() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    add(&h.backend, source.path());

    let phases: Vec<_> = h
        .events
        .statuses
        .lock()
        .unwrap()
        .iter()
        .flat_map(|status| status.registries.iter().map(|r| r.phase))
        .collect();
    assert!(phases.contains(&SyncPhase::Syncing));
    assert!(phases.contains(&SyncPhase::Synced));
    assert_eq!(h.events.busy.lock().unwrap().as_slice(), [true, false]);
    assert!(!h.backend.is_busy());
}

#[test]
fn startup_converts_legacy_symlink_installs_into_copies() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());
    let shared = h.home.path().join(".agents/skills/alpha");
    fs::create_dir_all(shared.parent().unwrap()).unwrap();
    fs::create_dir_all(&shared).unwrap();
    fs::write(shared.join("SKILL.md"), "shared body").unwrap();
    let claude = h.home.path().join(".claude/skills");
    fs::create_dir_all(&claude).unwrap();
    std::os::unix::fs::symlink(&shared, claude.join("alpha")).unwrap();
    crate::installer::upsert_install_record(
        &h.backend.db(),
        &crate::types::InstallRecord {
            registry_id: registry.id.clone(),
            folder_name: "alpha".into(),
            target: "~/.claude/skills".into(),
            content_hash: "h".into(),
            provenance_sha: "s".into(),
            method: crate::types::InstallMethod::Symlink,
            paths: vec![claude.join("alpha").to_string_lossy().into_owned()],
            cli_version: "1.6.0".into(),
            installed_at: "2026-01-01T00:00:00.000Z".into(),
        },
    )
    .unwrap();
    let Harness {
        backend,
        data,
        home,
        ..
    } = h;
    drop(backend);

    let reopened = open_with(
        data.path(),
        home.path(),
        Arc::new(Recorder::default()),
        None,
    );

    let link = claude.join("alpha");
    assert!(fs::symlink_metadata(&link).unwrap().is_dir());
    assert_eq!(
        fs::read_to_string(link.join("SKILL.md")).unwrap(),
        "shared body"
    );
    let records = read_install_records(&reopened.db(), &InstallRecordFilter::default()).unwrap();
    assert!(records
        .iter()
        .all(|record| record.method == crate::types::InstallMethod::Copy));
}

#[test]
fn appearance_and_update_preferences_persist() {
    let h = harness();
    assert_eq!(h.backend.get_appearance().theme, Theme::Dark);
    h.backend.set_theme(Theme::Light).unwrap();
    h.backend.set_font_size(FontSize::Larger).unwrap();
    assert_eq!(
        h.backend.get_appearance(),
        Appearance {
            theme: Theme::Light,
            font_size: FontSize::Larger
        }
    );
    assert!(h.backend.get_auto_download_app_updates());
    h.backend.set_auto_download_app_updates(false).unwrap();
    assert!(!h.backend.get_auto_download_app_updates());
}

#[test]
fn lists_and_reads_skill_files_from_the_mirror() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["alpha"]);
    let registry = add(&h.backend, source.path());
    let list = h
        .backend
        .list_skill_files(&SkillFileRequest {
            registry_id: registry.id.clone(),
            folder_name: "alpha".into(),
        })
        .unwrap();
    assert!(list.files.iter().any(|file| file.path == "SKILL.md"));
    let content = h
        .backend
        .read_skill_file(&SkillFileReadRequest {
            registry_id: registry.id.clone(),
            folder_name: "alpha".into(),
            path: "SKILL.md".into(),
        })
        .unwrap();
    assert!(content.content.unwrap_or_default().contains("alpha"));
}

#[test]
fn the_installation_id_lives_in_the_data_directory() {
    let h = harness();
    let id: PathBuf = h.data.path().join("installation_id");
    assert_eq!(
        fs::read_to_string(id).unwrap().trim(),
        h.backend.telemetry().installation_id
    );
}

#[test]
fn refresh_respects_concurrency_and_uses_the_next_setting() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let testing = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let sync: SyncFn = {
        let testing = testing.clone();
        let active = active.clone();
        let peak = peak.clone();
        Arc::new(move |_, _| {
            if testing.load(Ordering::SeqCst) {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(30));
                active.fetch_sub(1, Ordering::SeqCst);
            }
            Err(GitError {
                message: "offline".into(),
            })
        })
    };
    let h = harness_with(Some(sync));
    without_default(&h.backend);
    for _ in 0..5 {
        let remote = remote(&["skill"]);
        add(&h.backend, remote.path());
    }
    testing.store(true, Ordering::SeqCst);
    h.backend.set_sync_concurrency(2).unwrap();
    h.backend.refresh().unwrap();
    assert_eq!(peak.swap(0, Ordering::SeqCst), 2);
    h.backend.set_sync_concurrency(1).unwrap();
    h.backend.refresh().unwrap();
    assert_eq!(peak.load(Ordering::SeqCst), 1);
}

#[test]
fn installing_another_registry_does_not_wait_for_a_running_sync() {
    use std::sync::mpsc;
    let blocked = Arc::new(Mutex::new(None::<String>));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let sync: SyncFn = {
        let blocked = blocked.clone();
        let release_rx = Mutex::new(release_rx);
        Arc::new(move |conn, config| {
            if blocked.lock().unwrap().as_ref() == Some(&config.registry_id) {
                started_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
            }
            sync_registry(conn, config)
        })
    };
    let h = harness_with(Some(sync));
    without_default(&h.backend);
    let first_remote = remote(&["first"]);
    let second_remote = remote(&["second"]);
    let first = add(&h.backend, first_remote.path());
    let second = add(&h.backend, second_remote.path());
    *blocked.lock().unwrap() = Some(first.id.clone());
    std::thread::scope(|scope| {
        let syncing = scope.spawn(|| h.backend.sync_registry(&first.id));
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (installed_tx, installed_rx) = mpsc::channel();
        let backend = &h.backend;
        let installing = scope.spawn(move || {
            let result =
                backend.install(&install_request(&second, "second", &["~/.claude/skills"]));
            installed_tx.send(result).unwrap();
        });
        let installed = installed_rx.recv_timeout(Duration::from_secs(5));
        release_tx.send(()).unwrap();
        syncing.join().unwrap().unwrap();
        installing.join().unwrap();
        assert!(installed.unwrap().is_ok());
    });
    assert!(h
        .home
        .path()
        .join(".claude/skills/second/SKILL.md")
        .exists());
}

#[test]
fn changing_concurrency_does_not_interrupt_the_current_refresh() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    let testing = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let sync: SyncFn = {
        let testing = testing.clone();
        let release_rx = Mutex::new(release_rx);
        Arc::new(move |_, _| {
            if testing.load(Ordering::SeqCst) {
                started_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
            }
            Err(GitError::new("offline"))
        })
    };
    let h = harness_with(Some(sync));
    without_default(&h.backend);
    let sources: Vec<_> = (0..4).map(|_| remote(&["skill"])).collect();
    for source in &sources {
        add(&h.backend, source.path());
    }
    h.backend.set_sync_concurrency(2).unwrap();
    testing.store(true, Ordering::SeqCst);
    std::thread::scope(|scope| {
        let refresh = scope.spawn(|| h.backend.refresh());
        for _ in 0..2 {
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        h.backend.set_sync_concurrency(1).unwrap();
        for _ in 0..2 {
            release_tx.send(()).unwrap();
        }
        let pending: Vec<_> = (0..2)
            .map(|_| started_rx.recv_timeout(Duration::from_secs(5)))
            .collect();
        for _ in 0..2 {
            release_tx.send(()).unwrap();
        }
        refresh.join().unwrap().unwrap();
        assert!(pending.iter().all(Result::is_ok));
    });
    assert_eq!(h.backend.get_sync_concurrency(), 1);
}

#[test]
fn local_registry_snapshots_without_git() {
    let h = harness();
    without_default(&h.backend);
    let folder = h.home.path().join("drafts");
    fs::create_dir_all(&folder).unwrap();
    write_skill(&folder, "alpha", Some("name: alpha\ndescription: Draft"));
    let (registry, calls) = crate::mirror::git_exec::count_git_invocations(|| {
        h.backend
            .add_registry(&AddRegistryRequest {
                url: "~/drafts".into(),
                branch: None,
                enabled: None,
            })
            .unwrap()
    });
    assert_eq!(calls, 0);
    assert_eq!(registry.source, "local");
    assert_eq!(registry.branch, "");
    assert_eq!(folders(&h.backend), vec!["alpha"]);
}

#[test]
fn local_installs_use_pinned_snapshots_and_auto_update_changed_content() {
    let h = harness();
    without_default(&h.backend);
    let folder = h.home.path().join("drafts");
    fs::create_dir_all(&folder).unwrap();
    write_skill(&folder, "alpha", Some("name: alpha\ndescription: First"));
    fs::write(folder.join("alpha/helper.txt"), "first").unwrap();
    let registry = h
        .backend
        .add_registry(&AddRegistryRequest {
            url: "~/drafts".into(),
            branch: None,
            enabled: None,
        })
        .unwrap();
    let request = install_request(&registry, "alpha", &["~/.agents/skills"]);
    fs::write(folder.join("alpha/helper.txt"), "second").unwrap();
    let (_, calls) =
        crate::mirror::git_exec::count_git_invocations(|| h.backend.install(&request).unwrap());
    assert_eq!(calls, 0);
    assert_eq!(
        fs::read_to_string(h.home.path().join(".agents/skills/alpha/helper.txt")).unwrap(),
        "first"
    );
    let mut change = update(&registry.id);
    change.auto_update = Some(true);
    h.backend.update_registry(&change).unwrap();
    assert_eq!(
        fs::read_to_string(h.home.path().join(".agents/skills/alpha/helper.txt")).unwrap(),
        "second"
    );
    assert!(h.backend.install(&request).is_err());
}

#[test]
fn local_identity_and_folder_guards_use_real_paths() {
    let h = harness();
    without_default(&h.backend);
    let folder = h.home.path().join("drafts");
    fs::create_dir_all(&folder).unwrap();
    let add_path = |url: String| {
        h.backend.add_registry(&AddRegistryRequest {
            url,
            branch: None,
            enabled: Some(false),
        })
    };
    let registry = add_path("~/drafts".into()).unwrap();
    assert_eq!(registry.automatic_name, "~/drafts");
    let link = h.home.path().join("alias");
    std::os::unix::fs::symlink(&folder, &link).unwrap();
    assert!(add_path(link.to_string_lossy().into_owned())
        .unwrap_err()
        .to_string()
        .contains("already configured"));
    for path in [
        "~".to_string(),
        "/".into(),
        h.data.path().to_string_lossy().into_owned(),
    ] {
        assert!(add_path(path)
            .unwrap_err()
            .to_string()
            .contains("cannot be"));
    }
}

#[test]
fn local_content_changes_offer_updates_and_conflict_with_git_skills() {
    let h = harness();
    without_default(&h.backend);
    let git_source = remote(&["alpha"]);
    add(&h.backend, git_source.path());
    let folder = h.home.path().join("drafts");
    fs::create_dir_all(&folder).unwrap();
    write_skill(&folder, "alpha", Some("name: alpha\ndescription: Draft"));
    let registry = h
        .backend
        .add_registry(&AddRegistryRequest {
            url: "~/drafts".into(),
            branch: None,
            enabled: None,
        })
        .unwrap();
    let skills = h.backend.get_catalogue().unwrap().skills;
    assert_eq!(skills.len(), 2);
    assert!(skills.iter().all(|skill| skill.conflict));
    h.backend
        .install(&install_request(&registry, "alpha", &["~/.agents/skills"]))
        .unwrap();
    write_skill(&folder, "alpha", Some("name: alpha\ndescription: Changed"));
    let (_, calls) = crate::mirror::git_exec::count_git_invocations(|| {
        h.backend.sync_registry(&registry.id).unwrap()
    });
    assert_eq!(calls, 0);
    let report = h
        .backend
        .reconcile(Some(&registry.id), Some("alpha"))
        .unwrap();
    assert!(report
        .entries
        .iter()
        .any(|entry| entry.state == ReconcileState::UpdateAvailable));
}

#[test]
fn registry_switches_between_git_and_local_preserving_settings() {
    let h = harness();
    without_default(&h.backend);
    let remote = remote(&["published"]);
    let registry = add(&h.backend, remote.path());
    let mut settings = update(&registry.id);
    settings.name = Some("My skills".into());
    settings.colour = Some("#123456".into());
    settings.auto_update = Some(true);
    h.backend.update_registry(&settings).unwrap();
    let folder = h.home.path().join("drafts");
    fs::create_dir_all(&folder).unwrap();
    write_skill(&folder, "draft", Some("name: draft\ndescription: Draft"));
    let mut change = update(&registry.id);
    change.url = Some("~/drafts".into());
    change.branch = Some("ignored-for-local".into());
    let local = h.backend.update_registry(&change).unwrap();
    assert_eq!(local.source, "local");
    assert_eq!(local.branch, "");
    assert_eq!(folders(&h.backend), vec!["draft"]);
    assert_eq!(local.id, registry.id);
    assert_eq!(local.name.as_deref(), Some("My skills"));
    assert_eq!(local.colour.as_deref(), Some("#123456"));
    assert!(local.auto_update);
    change.url = Some(format!("file://{}", remote.path().display()));
    change.branch = None;
    let git = h.backend.update_registry(&change).unwrap();
    assert_eq!(git.source, "git");
    assert_eq!(git.branch, "main");
    assert_eq!(folders(&h.backend), vec!["published"]);
    assert_eq!(git.id, registry.id);
    assert_eq!(git.name, local.name);
    assert_eq!(git.colour, local.colour);
    assert!(git.auto_update);
}

#[test]
fn registry_source_switch_rejects_duplicates_and_unsafe_folders_without_changes() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["published"]);
    let registry = add(&h.backend, source.path());
    let folder = h.home.path().join("drafts");
    fs::create_dir_all(&folder).unwrap();
    let local = h
        .backend
        .add_registry(&AddRegistryRequest {
            url: "~/drafts".into(),
            branch: None,
            enabled: Some(false),
        })
        .unwrap();
    let alias = h.home.path().join("alias");
    std::os::unix::fs::symlink(&folder, &alias).unwrap();
    let mut change = update(&registry.id);
    change.url = Some(alias.to_string_lossy().into_owned());
    assert!(h
        .backend
        .update_registry(&change)
        .unwrap_err()
        .to_string()
        .contains("already configured"));
    for path in [
        "~".to_string(),
        "/".into(),
        h.data.path().to_string_lossy().into_owned(),
    ] {
        change.url = Some(path);
        assert!(h
            .backend
            .update_registry(&change)
            .unwrap_err()
            .to_string()
            .contains("cannot be"));
    }
    let unchanged = h.backend.registry(&registry.id).unwrap();
    assert_eq!(unchanged.source, "git");
    assert_eq!(unchanged.url, registry.url);
    assert_eq!(unchanged.branch, registry.branch);
    assert_eq!(folders(&h.backend), vec!["published"]);
    let mut change = update(&local.id);
    change.url = Some(registry.url);
    assert!(h
        .backend
        .update_registry(&change)
        .unwrap_err()
        .to_string()
        .contains("already configured"));
    assert_eq!(h.backend.registry(&local.id).unwrap().source, "local");
}

#[test]
fn local_registry_switch_uses_the_requested_git_branch() {
    let h = harness();
    without_default(&h.backend);
    let source = remote(&["published"]);
    run_git(source.path(), &["checkout", "-b", "draft"]);
    write_skill(
        source.path(),
        "skills/preview",
        Some("name: preview\ndescription: Preview"),
    );
    commit_all(source.path(), "preview");
    run_git(source.path(), &["checkout", "main"]);
    let registry = h
        .backend
        .add_registry(&AddRegistryRequest {
            url: source.path().to_string_lossy().into_owned(),
            branch: None,
            enabled: None,
        })
        .unwrap();
    let mut change = update(&registry.id);
    change.url = Some(format!("file://{}", source.path().display()));
    change.branch = Some("draft".into());
    let registry = h.backend.update_registry(&change).unwrap();
    assert_eq!(registry.source, "git");
    assert_eq!(registry.branch, "draft");
    assert_eq!(folders(&h.backend), vec!["preview", "published"]);
}
