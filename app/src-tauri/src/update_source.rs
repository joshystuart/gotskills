//! [`UpdateSource`] over `tauri-plugin-updater`.

use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::backend::app_update::UpdateSource;

struct Staged {
    update: Update,
    bytes: Option<Vec<u8>>,
}

/// Checks the configured endpoint, downloads into memory and installs on restart.
pub struct TauriUpdateSource {
    app: AppHandle,
    staged: Mutex<Option<Staged>>,
}

impl TauriUpdateSource {
    pub fn new(app: AppHandle) -> Self {
        TauriUpdateSource {
            app,
            staged: Mutex::new(None),
        }
    }

    fn staged(&self) -> std::sync::MutexGuard<'_, Option<Staged>> {
        self.staged.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl UpdateSource for TauriUpdateSource {
    fn check(&self) -> Result<Option<String>, String> {
        let updater = self.app.updater().map_err(|e| e.to_string())?;
        let found = tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())?;
        let version = found.as_ref().map(|update| update.version.clone());
        *self.staged() = found.map(|update| Staged {
            update,
            bytes: None,
        });
        Ok(version)
    }

    fn download(&self, on_progress: &dyn Fn(f64)) -> Result<(), String> {
        let update = self
            .staged()
            .as_ref()
            .map(|staged| staged.update.clone())
            .ok_or_else(|| "No update has been found".to_string())?;
        let mut received: u64 = 0;
        let bytes = tauri::async_runtime::block_on(update.download(
            |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|total| *total > 0) {
                    on_progress((received as f64 / total as f64 * 100.0).min(100.0));
                }
            },
            || {},
        ))
        .map_err(|e| e.to_string())?;
        if let Some(staged) = self.staged().as_mut() {
            staged.bytes = Some(bytes);
        }
        Ok(())
    }

    fn install_and_restart(&self) {
        let Some(Staged {
            update,
            bytes: Some(bytes),
        }) = self.staged().take()
        else {
            return;
        };
        if update.install(bytes).is_ok() {
            self.app.restart();
        }
    }
}
