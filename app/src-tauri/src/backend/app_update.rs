//! The App Update state machine, independent of the Tauri updater plugin.

use std::sync::{Arc, Mutex, MutexGuard};

use crate::types::{AppUpdateState, LastUpdateCheck, UpdateCheckResult};

/// Where releases come from. Implemented over `tauri-plugin-updater` in the
/// app and by fakes in tests. All methods block.
pub trait UpdateSource: Send + Sync {
    /// The version of a newer release, if one exists.
    fn check(&self) -> Result<Option<String>, String>;
    /// Download the release found by the last check, reporting percent done.
    fn download(&self, on_progress: &dyn Fn(f64)) -> Result<(), String>;
    /// Install the downloaded release and relaunch.
    fn install_and_restart(&self);
}

/// Runs a closure on another thread (replaceable in tests).
pub type Spawn = Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

/// Everything [`AppUpdate::new`] needs.
pub struct AppUpdateOptions {
    pub source: Arc<dyn UpdateSource>,
    pub packaged: bool,
    pub current_version: String,
    pub get_auto_download: Box<dyn Fn() -> bool + Send + Sync>,
    pub set_auto_download: Box<dyn Fn(bool) + Send + Sync>,
    pub is_busy: Box<dyn Fn() -> bool + Send + Sync>,
    pub on_state: Box<dyn Fn(&AppUpdateState) + Send + Sync>,
    pub log: Box<dyn Fn(&str) + Send + Sync>,
    pub spawn: Spawn,
}

struct Inner {
    state: AppUpdateState,
    state_before_manual_check: AppUpdateState,
    checking: bool,
    manual_check: bool,
    closed: bool,
}

/// Checks for, downloads and installs app updates.
pub struct AppUpdate {
    options: AppUpdateOptions,
    inner: Mutex<Inner>,
}

fn can_check(state: &AppUpdateState) -> bool {
    matches!(
        state,
        AppUpdateState::Idle { .. }
            | AppUpdateState::Available { .. }
            | AppUpdateState::DownloadFailed { .. }
    )
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl AppUpdate {
    pub fn new(options: AppUpdateOptions) -> Arc<Self> {
        let idle = AppUpdateState::Idle {
            current_version: options.current_version.clone(),
            last_check: None,
        };
        Arc::new(AppUpdate {
            options,
            inner: Mutex::new(Inner {
                state: idle.clone(),
                state_before_manual_check: idle,
                checking: false,
                manual_check: false,
                closed: false,
            }),
        })
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn current_version(&self) -> String {
        self.options.current_version.clone()
    }

    fn publish(&self, next: AppUpdateState) {
        {
            let mut inner = self.inner();
            if inner.closed {
                return;
            }
            inner.state = next.clone();
        }
        (self.options.on_state)(&next);
    }

    pub fn get_state(&self) -> AppUpdateState {
        self.inner().state.clone()
    }

    pub fn get_auto_download(&self) -> bool {
        (self.options.get_auto_download)()
    }

    pub fn set_auto_download(&self, enabled: bool) {
        (self.options.set_auto_download)(enabled)
    }

    /// A user-requested check; reports the outcome as the Idle state.
    pub fn check_manual(self: &Arc<Self>) {
        self.check(true)
    }

    /// The startup and periodic check; failures are only logged.
    pub fn check_background(self: &Arc<Self>) {
        self.check(false)
    }

    fn check(self: &Arc<Self>, manual: bool) {
        {
            let mut inner = self.inner();
            if !self.options.packaged || inner.closed || !can_check(&inner.state) {
                return;
            }
            if manual {
                inner.manual_check = true;
                inner.state_before_manual_check = inner.state.clone();
            }
        }
        if manual {
            self.publish(AppUpdateState::Checking {
                current_version: self.current_version(),
            });
        }
        {
            let mut inner = self.inner();
            if inner.checking {
                return;
            }
            inner.checking = true;
        }
        match self.options.source.check() {
            Ok(Some(version)) => {
                self.update_available(&version);
                self.check_result(UpdateCheckResult::UpToDate, None);
            }
            Ok(None) => self.check_result(UpdateCheckResult::UpToDate, None),
            Err(error) => {
                if self.inner().manual_check {
                    self.check_result(UpdateCheckResult::Error, Some(error));
                } else {
                    (self.options.log)(&error);
                }
            }
        }
        let mut inner = self.inner();
        inner.checking = false;
        inner.manual_check = false;
    }

    fn update_available(self: &Arc<Self>, version: &str) {
        let eligible = {
            let inner = self.inner();
            !version.contains('-')
                && (can_check(&inner.state)
                    || matches!(inner.state, AppUpdateState::Checking { .. }))
        };
        if !eligible {
            return;
        }
        self.publish(AppUpdateState::Available {
            current_version: self.current_version(),
            version: version.to_string(),
        });
        if self.get_auto_download() {
            let this = Arc::clone(self);
            (self.options.spawn)(Box::new(move || this.download()));
        }
    }

    fn check_result(&self, result: UpdateCheckResult, error: Option<String>) {
        let (manual, checking, before) = {
            let inner = self.inner();
            (
                inner.manual_check,
                matches!(inner.state, AppUpdateState::Checking { .. }),
                inner.state_before_manual_check.clone(),
            )
        };
        if !manual || !checking {
            return;
        }
        if result == UpdateCheckResult::Error && !matches!(before, AppUpdateState::Idle { .. }) {
            if let Some(error) = &error {
                (self.options.log)(error);
            }
            self.publish(before);
            return;
        }
        self.publish(AppUpdateState::Idle {
            current_version: self.current_version(),
            last_check: Some(LastUpdateCheck {
                at: now(),
                result,
                message: error,
            }),
        });
    }

    fn download_failed(&self, message: String) {
        let version = match self.get_state() {
            AppUpdateState::Downloading { version, .. } => version,
            _ => return,
        };
        self.publish(AppUpdateState::DownloadFailed {
            current_version: self.current_version(),
            version,
            message,
        });
    }

    /// Download the available release (or retry a failed download).
    pub fn download(&self) {
        let version = {
            let inner = self.inner();
            if !self.options.packaged || inner.closed {
                return;
            }
            match &inner.state {
                AppUpdateState::Available { version, .. }
                | AppUpdateState::DownloadFailed { version, .. } => version.clone(),
                _ => return,
            }
        };
        self.publish(AppUpdateState::Downloading {
            current_version: self.current_version(),
            version: version.clone(),
            percent: 0.0,
        });
        let outcome = self.options.source.download(&|percent| {
            if matches!(self.get_state(), AppUpdateState::Downloading { .. }) {
                self.publish(AppUpdateState::Downloading {
                    current_version: self.current_version(),
                    version: version.clone(),
                    percent,
                });
            }
        });
        match outcome {
            Ok(()) => {
                if matches!(self.get_state(), AppUpdateState::Downloading { .. }) {
                    self.publish(AppUpdateState::Ready {
                        current_version: self.current_version(),
                        version,
                        waiting: (self.options.is_busy)(),
                    });
                }
            }
            Err(error) => self.download_failed(error),
        }
    }

    /// Keep a ready update's `waiting` flag in step with the backend's busy flag.
    pub fn busy_changed(&self) {
        if let AppUpdateState::Ready {
            current_version,
            version,
            waiting,
        } = self.get_state()
        {
            let busy = (self.options.is_busy)();
            if waiting != busy {
                self.publish(AppUpdateState::Ready {
                    current_version,
                    version,
                    waiting: busy,
                });
            }
        }
    }

    /// Install the ready update and relaunch, unless work is in progress.
    pub fn restart(&self) {
        let allowed = {
            let inner = self.inner();
            self.options.packaged
                && !inner.closed
                && !(self.options.is_busy)()
                && matches!(inner.state, AppUpdateState::Ready { .. })
        };
        if allowed {
            self.options.source.install_and_restart();
        }
    }

    /// Stop publishing state.
    pub fn close(&self) {
        self.inner().closed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct FakeSource {
        found: Mutex<Option<Result<Option<String>, String>>>,
        download: Mutex<Option<Result<(), String>>>,
        progress: Mutex<Vec<f64>>,
        checks: AtomicUsize,
        downloads: AtomicUsize,
        restarts: AtomicUsize,
    }

    impl UpdateSource for FakeSource {
        fn check(&self) -> Result<Option<String>, String> {
            self.checks.fetch_add(1, Ordering::SeqCst);
            self.found.lock().unwrap().clone().unwrap_or(Ok(None))
        }

        fn download(&self, on_progress: &dyn Fn(f64)) -> Result<(), String> {
            self.downloads.fetch_add(1, Ordering::SeqCst);
            for percent in self.progress.lock().unwrap().iter() {
                on_progress(*percent);
            }
            self.download.lock().unwrap().clone().unwrap_or(Ok(()))
        }

        fn install_and_restart(&self) {
            self.restarts.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Fixture {
        source: Arc<FakeSource>,
        update: Arc<AppUpdate>,
        states: Arc<Mutex<Vec<AppUpdateState>>>,
        logs: Arc<Mutex<Vec<String>>>,
        busy: Arc<AtomicBool>,
        auto_download: Arc<AtomicBool>,
    }

    fn fixture(packaged: bool, auto_download: bool, busy: bool) -> Fixture {
        let source = Arc::new(FakeSource::default());
        let states = Arc::new(Mutex::new(Vec::new()));
        let logs = Arc::new(Mutex::new(Vec::new()));
        let busy = Arc::new(AtomicBool::new(busy));
        let auto = Arc::new(AtomicBool::new(auto_download));
        let update = AppUpdate::new(AppUpdateOptions {
            source: source.clone(),
            packaged,
            current_version: "0.0.6".into(),
            get_auto_download: {
                let auto = auto.clone();
                Box::new(move || auto.load(Ordering::SeqCst))
            },
            set_auto_download: {
                let auto = auto.clone();
                Box::new(move |enabled| auto.store(enabled, Ordering::SeqCst))
            },
            is_busy: {
                let busy = busy.clone();
                Box::new(move || busy.load(Ordering::SeqCst))
            },
            on_state: {
                let states = states.clone();
                Box::new(move |state| states.lock().unwrap().push(state.clone()))
            },
            log: {
                let logs = logs.clone();
                Box::new(move |message| logs.lock().unwrap().push(message.to_string()))
            },
            spawn: Box::new(|work| work()),
        });
        Fixture {
            source,
            update,
            states,
            logs,
            busy,
            auto_download: auto,
        }
    }

    fn available() -> AppUpdateState {
        AppUpdateState::Available {
            current_version: "0.0.6".into(),
            version: "0.0.7".into(),
        }
    }

    fn ready(waiting: bool) -> AppUpdateState {
        AppUpdateState::Ready {
            current_version: "0.0.6".into(),
            version: "0.0.7".into(),
            waiting,
        }
    }

    fn found(fixture: &Fixture, version: &str) {
        *fixture.source.found.lock().unwrap() = Some(Ok(Some(version.into())));
    }

    #[test]
    fn does_nothing_when_not_packaged() {
        let f = fixture(false, true, false);
        f.update.check_background();
        f.update.check_manual();
        f.update.download();
        assert_eq!(f.source.checks.load(Ordering::SeqCst), 0);
        assert!(f.states.lock().unwrap().is_empty());
    }

    #[test]
    fn waits_for_a_download_request_when_automatic_downloads_are_off() {
        let f = fixture(true, false, false);
        found(&f, "0.0.7");
        f.update.check_background();
        assert_eq!(f.update.get_state(), available());
        assert_eq!(f.source.downloads.load(Ordering::SeqCst), 0);
        f.update.download();
        assert_eq!(f.source.downloads.load(Ordering::SeqCst), 1);
        assert_eq!(f.update.get_state(), ready(false));
    }

    #[test]
    fn downloads_automatically_and_publishes_progress_then_ready() {
        let f = fixture(true, true, false);
        found(&f, "0.0.7");
        *f.source.progress.lock().unwrap() = vec![42.0];
        f.update.check_background();
        let states = f.states.lock().unwrap().clone();
        assert!(states.contains(&AppUpdateState::Downloading {
            current_version: "0.0.6".into(),
            version: "0.0.7".into(),
            percent: 42.0
        }));
        assert_eq!(states.last(), Some(&ready(false)));
    }

    #[test]
    fn ignores_prerelease_versions() {
        let f = fixture(true, true, false);
        found(&f, "0.0.7-beta.1");
        f.update.check_background();
        assert!(matches!(f.update.get_state(), AppUpdateState::Idle { .. }));
        assert_eq!(f.source.downloads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn reports_an_up_to_date_result_after_a_manual_check() {
        let f = fixture(true, true, false);
        f.update.check_manual();
        match f.update.get_state() {
            AppUpdateState::Idle {
                current_version,
                last_check: Some(last),
            } => {
                assert_eq!(current_version, "0.0.6");
                assert_eq!(last.result, UpdateCheckResult::UpToDate);
                assert_eq!(last.message, None);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn reports_manual_check_errors_next_to_the_current_version() {
        let f = fixture(true, true, false);
        *f.source.found.lock().unwrap() = Some(Err("Offline".into()));
        f.update.check_manual();
        match f.update.get_state() {
            AppUpdateState::Idle {
                last_check: Some(last),
                ..
            } => {
                assert_eq!(last.result, UpdateCheckResult::Error);
                assert_eq!(last.message.as_deref(), Some("Offline"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn logs_background_check_errors_without_changing_state() {
        let f = fixture(true, true, false);
        *f.source.found.lock().unwrap() = Some(Err("Offline".into()));
        f.update.check_background();
        assert!(matches!(
            f.update.get_state(),
            AppUpdateState::Idle {
                last_check: None,
                ..
            }
        ));
        assert_eq!(f.logs.lock().unwrap().as_slice(), ["Offline"]);
    }

    #[test]
    fn a_failed_manual_check_restores_the_previous_available_state() {
        let f = fixture(true, false, false);
        found(&f, "0.0.7");
        f.update.check_background();
        *f.source.found.lock().unwrap() = Some(Err("Offline".into()));
        f.update.check_manual();
        assert_eq!(f.update.get_state(), available());
        assert_eq!(f.logs.lock().unwrap().as_slice(), ["Offline"]);
    }

    #[test]
    fn a_failed_download_can_be_retried() {
        let f = fixture(true, false, false);
        found(&f, "0.0.7");
        f.update.check_background();
        *f.source.download.lock().unwrap() = Some(Err("disk full".into()));
        f.update.download();
        assert_eq!(
            f.update.get_state(),
            AppUpdateState::DownloadFailed {
                current_version: "0.0.6".into(),
                version: "0.0.7".into(),
                message: "disk full".into()
            }
        );
        *f.source.download.lock().unwrap() = Some(Ok(()));
        f.update.download();
        assert_eq!(f.update.get_state(), ready(false));
    }

    #[test]
    fn marks_the_ready_release_as_waiting_when_the_download_finishes_while_busy() {
        let f = fixture(true, true, true);
        found(&f, "0.0.7");
        f.update.check_background();
        assert_eq!(f.update.get_state(), ready(true));
    }

    #[test]
    fn republishes_waiting_once_busy_work_finishes() {
        let f = fixture(true, true, true);
        found(&f, "0.0.7");
        f.update.check_background();
        f.busy.store(false, Ordering::SeqCst);
        f.update.busy_changed();
        assert_eq!(f.update.get_state(), ready(false));
    }

    #[test]
    fn restarts_only_when_ready_and_idle() {
        let f = fixture(true, true, true);
        f.update.restart();
        found(&f, "0.0.7");
        f.update.check_background();
        f.update.restart();
        assert_eq!(f.source.restarts.load(Ordering::SeqCst), 0);
        f.busy.store(false, Ordering::SeqCst);
        f.update.restart();
        assert_eq!(f.source.restarts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stores_the_automatic_download_preference() {
        let f = fixture(true, true, false);
        f.update.set_auto_download(false);
        assert!(!f.update.get_auto_download());
        assert!(!f.auto_download.load(Ordering::SeqCst));
    }

    #[test]
    fn stops_publishing_once_closed() {
        let f = fixture(true, false, false);
        f.update.close();
        found(&f, "0.0.7");
        f.update.check_background();
        assert!(f.states.lock().unwrap().is_empty());
    }
}
