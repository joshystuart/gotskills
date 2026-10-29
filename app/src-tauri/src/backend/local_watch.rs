use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Weak};
use std::time::Instant;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::{Backend, BackendState};
use crate::registries::{get_registry, list_registries};

pub(super) struct LocalWatch {
    path: PathBuf,
    stopped: Arc<AtomicBool>,
    _watcher: RecommendedWatcher,
}

impl Drop for LocalWatch {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
}

enum Message {
    Path(PathBuf),
    Finished,
}

impl LocalWatch {
    fn start(backend: Weak<BackendState>, id: String, path: PathBuf) -> notify::Result<Self> {
        let (send, receive) = mpsc::channel();
        let events = send.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    if !matches!(event.kind, EventKind::Access(_)) {
                        for path in event.paths {
                            let _ = events.send(Message::Path(path));
                        }
                    }
                }
            })?;
        watcher.watch(&path, RecursiveMode::Recursive)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let root = path.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let mut debounce = Debounce::default();
            while !stop.load(Ordering::Relaxed) {
                match receive.recv_timeout(Duration::from_millis(25)) {
                    Ok(Message::Path(path)) => {
                        if let Ok(relative) = path.strip_prefix(&root) {
                            debounce.path_event(relative, started.elapsed());
                        }
                    }
                    Ok(Message::Finished) => debounce.finished(),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                if debounce.ready(started.elapsed()) {
                    let backend = backend.clone();
                    let id = id.clone();
                    let done = send.clone();
                    let stop = stop.clone();
                    std::thread::spawn(move || {
                        if !stop.load(Ordering::Relaxed) {
                            if let Some(inner) = backend.upgrade() {
                                let backend = Backend { inner };
                                backend.sync_watched_registry(&id);
                            }
                        }
                        let _ = done.send(Message::Finished);
                    });
                }
            }
        });
        Ok(Self {
            path,
            stopped,
            _watcher: watcher,
        })
    }
}

impl Backend {
    pub(super) fn refresh_local_watches(&self) {
        let Ok(registries) = list_registries(&self.db(), false) else {
            return;
        };
        let desired: BTreeMap<_, _> = registries
            .into_iter()
            .filter(|registry| {
                registry.source == "local" && registry.enabled && registry.removed_at.is_none()
            })
            .map(|registry| (registry.id, PathBuf::from(registry.url)))
            .collect();
        let mut watches = self.watches.lock().unwrap_or_else(|p| p.into_inner());
        watches.retain(|id, watch| desired.get(id) == Some(&watch.path));
        for (id, path) in desired {
            if !watches.contains_key(&id) {
                if let Ok(watch) = LocalWatch::start(Arc::downgrade(&self.inner), id.clone(), path)
                {
                    watches.insert(id, watch);
                }
            }
        }
    }

    fn sync_watched_registry(&self, id: &str) {
        let registry = get_registry(&self.db(), id).ok().flatten();
        if let Some(registry) = registry.filter(|registry| {
            registry.source == "local" && registry.enabled && registry.removed_at.is_none()
        }) {
            let _ = self.do_sync_pending(&registry, true);
            self.events.catalogue_updated();
            self.emit_status();
        }
    }
}

use std::time::Duration;

#[derive(Default)]
struct Debounce {
    last_event: Option<Duration>,
    running: bool,
}

impl Debounce {
    fn path_event(&mut self, path: &Path, now: Duration) {
        if !path.components().any(|part| {
            crate::mirror::discovery::skills::SKIP_DIRS
                .iter()
                .any(|skip| part.as_os_str() == *skip)
        }) {
            self.event(now);
        }
    }

    fn event(&mut self, now: Duration) {
        self.last_event = Some(now);
    }

    fn ready(&mut self, now: Duration) -> bool {
        if !self.running
            && self
                .last_event
                .is_some_and(|last| now.saturating_sub(last) >= Duration::from_secs(1))
        {
            self.last_event = None;
            self.running = true;
            true
        } else {
            false
        }
    }

    fn finished(&mut self) {
        self.running = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_during_sync_queue_one_follow_up() {
        let mut debounce = Debounce::default();
        debounce.event(Duration::ZERO);
        assert!(debounce.ready(Duration::from_secs(1)));
        debounce.event(Duration::from_secs(2));
        debounce.event(Duration::from_secs(3));
        assert!(!debounce.ready(Duration::from_secs(4)));
        debounce.finished();
        assert!(debounce.ready(Duration::from_secs(4)));
        debounce.finished();
        assert!(!debounce.ready(Duration::from_secs(5)));
    }

    #[test]
    fn skipped_directory_events_do_not_schedule_sync() {
        let mut debounce = Debounce::default();
        for folder in [".git", "node_modules", "dist", "build", "__pycache__"] {
            debounce.path_event(
                std::path::Path::new(&format!("alpha/{folder}/file")),
                Duration::ZERO,
            );
        }
        assert!(!debounce.ready(Duration::from_secs(2)));
        debounce.path_event(
            std::path::Path::new("alpha/building/file"),
            Duration::from_secs(2),
        );
        assert!(debounce.ready(Duration::from_secs(3)));
    }

    #[test]
    fn burst_waits_one_second_after_last_event() {
        let mut debounce = Debounce::default();
        debounce.event(Duration::ZERO);
        debounce.event(Duration::from_millis(800));
        assert!(!debounce.ready(Duration::from_millis(1799)));
        assert!(debounce.ready(Duration::from_millis(1800)));
        debounce.finished();
        assert!(!debounce.ready(Duration::from_secs(3)));
    }
}
