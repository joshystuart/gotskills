//! Got Skills backend: a Tauri v2 shell over a Rust core.

pub mod app_settings;
pub mod backend;
pub mod commands;
pub mod config;
pub mod db;
pub mod env;
pub mod error;
pub mod external_links;
pub mod installer;
pub mod mirror;
pub mod registries;
pub mod registry_url;
pub mod short_sha;
pub mod telemetry;
pub mod types;
pub mod update_source;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::PageLoadEvent;
use tauri::{App, AppHandle, Emitter, Manager, RunEvent, Window, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::backend::app_update::{AppUpdate, AppUpdateOptions};
use crate::backend::appearance::uses_dark;
use crate::backend::{Backend, BackendEvents, BackendOptions, SYNC_INTERVAL};
use crate::commands::{apply_theme, set_window_background, MenuSelection, MAIN_WINDOW};
use crate::external_links::{navigation, Navigation};
use crate::mirror::git::is_git_available;
use crate::types::{events, AutoUpdateResult, SyncStatus};
use crate::update_source::TauriUpdateSource;

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

const GIT_REQUIRED_MESSAGE: &str = "Got Skills needs Git to sync the skill registry.\n\nInstall the Xcode Command Line Tools (xcode-select --install) or Git, then relaunch the app.";

/// Forwards backend notifications to the renderer and the updater.
struct TauriEvents {
    app: AppHandle,
    update: Arc<OnceLock<Arc<AppUpdate>>>,
}

impl BackendEvents for TauriEvents {
    fn sync_status(&self, status: &SyncStatus) {
        let _ = self.app.emit(events::SYNC_STATUS, status);
    }

    fn catalogue_updated(&self) {
        let _ = self.app.emit(events::CATALOGUE_UPDATED, ());
    }

    fn auto_update_result(&self, result: &AutoUpdateResult) {
        let _ = self.app.emit(events::AUTO_UPDATE_RESULT, result);
    }

    fn busy_changed(&self, _busy: bool) {
        if let Some(update) = self.update.get() {
            update.busy_changed();
        }
    }
}

fn external_links_plugin() -> TauriPlugin<Wry> {
    PluginBuilder::<Wry>::new("external-links")
        .on_navigation(|webview, url| match navigation(url) {
            Navigation::Allow => true,
            Navigation::OpenExternally => {
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
                false
            }
            Navigation::Block => false,
        })
        .build()
}

fn spawn_every(interval: Duration, work: impl Fn() + Send + 'static) {
    std::thread::spawn(move || loop {
        std::thread::sleep(interval);
        work();
    });
}

fn start_background_work(backend: &Arc<Backend>, update: &Arc<AppUpdate>) {
    let sync_backend = Arc::clone(backend);
    spawn_every(SYNC_INTERVAL, move || {
        let _ = sync_backend.sync_now();
    });
    let check_update = Arc::clone(update);
    std::thread::spawn({
        let update = Arc::clone(update);
        move || update.check_background()
    });
    spawn_every(UPDATE_CHECK_INTERVAL, move || {
        check_update.check_background()
    });
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    if !is_git_available() {
        let handle = app.handle().clone();
        app.dialog()
            .message(GIT_REQUIRED_MESSAGE)
            .title("Git required")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCustom("Quit".into()))
            .show(move |_| handle.exit(0));
        return Ok(());
    }

    let handle = app.handle().clone();
    let update_slot = Arc::new(OnceLock::new());
    let events = Arc::new(TauriEvents {
        app: handle.clone(),
        update: Arc::clone(&update_slot),
    });
    let version = app.package_info().version.to_string();
    let backend = Arc::new(Backend::open(BackendOptions::real(&version, events))?);

    let update = AppUpdate::new(AppUpdateOptions {
        source: Arc::new(TauriUpdateSource::new(handle.clone())),
        packaged: !cfg!(debug_assertions),
        current_version: version,
        get_auto_download: {
            let backend = Arc::clone(&backend);
            Box::new(move || backend.get_auto_download_app_updates())
        },
        set_auto_download: {
            let backend = Arc::clone(&backend);
            Box::new(move |enabled| {
                let _ = backend.set_auto_download_app_updates(enabled);
            })
        },
        is_busy: {
            let backend = Arc::clone(&backend);
            Box::new(move || backend.is_busy())
        },
        on_state: {
            let handle = handle.clone();
            Box::new(move |state| {
                let _ = handle.emit(events::APP_UPDATE_STATE, state);
            })
        },
        log: Box::new(|error| eprintln!("App Update: {error}")),
        spawn: Box::new(|work| {
            std::thread::spawn(work);
        }),
    });
    let _ = update_slot.set(Arc::clone(&update));

    apply_theme(&handle, backend.get_appearance().theme);
    start_background_work(&backend, &update);
    app.manage(backend);
    app.manage(update);
    Ok(())
}

fn on_page_load_finished(window: &Window) {
    let app = window.app_handle();
    let Some(backend) = app.try_state::<Arc<Backend>>() else {
        return;
    };
    let backend = Arc::clone(backend.inner());
    let _ = window.show();
    tauri::async_runtime::spawn_blocking(move || {
        backend.announce_status();
        let _ = backend.sync_now();
    });
}

fn on_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::ThemeChanged(theme) => {
            let app = window.app_handle();
            if let Some(backend) = app.try_state::<Arc<Backend>>() {
                let dark = uses_dark(backend.get_appearance().theme, *theme == tauri::Theme::Dark);
                set_window_background(app, dark);
            }
        }
        #[cfg(target_os = "macos")]
        WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_WINDOW => {
            api.prevent_close();
            let _ = window.hide();
        }
        _ => {}
    }
}

fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::Exit => {
            if let Some(update) = app.try_state::<Arc<AppUpdate>>() {
                update.close();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    }
}

/// Start the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(external_links_plugin())
        .manage(MenuSelection::default())
        .on_menu_event(|app, event| {
            if let Some(selection) = app.try_state::<MenuSelection>() {
                selection.deliver(event.id().as_ref());
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished && webview.label() == MAIN_WINDOW {
                on_page_load_finished(&webview.window());
            }
        })
        .on_window_event(on_window_event)
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            commands::choose_registry_folder,
            commands::get_app_update_state,
            commands::check_app_update,
            commands::get_auto_download_app_updates,
            commands::set_auto_download_app_updates,
            commands::download_app_update,
            commands::restart_for_app_update,
            commands::get_sync_concurrency,
            commands::set_sync_concurrency,
            commands::get_appearance,
            commands::set_theme,
            commands::set_font_size,
            commands::detect_targets,
            commands::install,
            commands::reconcile,
            commands::repair,
            commands::uninstall,
            commands::get_catalogue,
            commands::refresh,
            commands::get_sync_status,
            commands::list_registries,
            commands::add_registry,
            commands::update_registry,
            commands::remove_registry,
            commands::sync_registry,
            commands::list_skill_files,
            commands::read_skill_file,
            commands::show_registry_menu,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Got Skills")
        .run(on_run_event);
}
