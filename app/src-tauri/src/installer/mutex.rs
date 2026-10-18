//! Serialises mirror-mutating (sync) and mirror-reading (install) work.

use std::sync::Mutex;

/// A process-wide exclusive section. A panic inside one section never blocks the next.
#[derive(Debug, Default)]
pub struct MirrorMutex {
    inner: Mutex<()>,
}

impl MirrorMutex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run `work` while holding the lock.
    pub fn run_exclusive<T>(&self, work: impl FnOnce() -> T) -> T {
        let _guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        work()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn sections_never_overlap() {
        let mutex = Arc::new(MirrorMutex::new());
        let active = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let mutex = Arc::clone(&mutex);
                let active = Arc::clone(&active);
                std::thread::spawn(move || {
                    mutex.run_exclusive(|| {
                        assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        active.fetch_sub(1, Ordering::SeqCst);
                    })
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
    }

    #[test]
    fn a_panic_does_not_block_later_sections() {
        let mutex = Arc::new(MirrorMutex::new());
        let clone = Arc::clone(&mutex);
        let _ = std::thread::spawn(move || clone.run_exclusive(|| panic!("boom"))).join();
        assert_eq!(mutex.run_exclusive(|| 7), 7);
    }
}
