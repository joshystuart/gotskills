//! The `#[tauri::command]` surface the renderer calls through `invoke`.
//!
//! Each command keeps the name and argument names documented above
//! `IpcRequest` in `src/shared/ipc.ts`. Blocking backend work runs through
//! `spawn_blocking`; failures cross as [`AppError`].

use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem};
use tauri::{AppHandle, LogicalPosition, Manager, State, Window};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::backend::app_update::AppUpdate;
use crate::backend::appearance::{background_color, forced_theme, parse_hex, uses_dark};
use crate::backend::registry_menu::{
    github_url, registry_menu_template, MenuAction, RegistryMenuItem,
};
use crate::backend::Backend;
use crate::error::{AppError, AppResult};
use crate::types::{
    AddRegistryRequest, AppUpdateState, Appearance, CatalogueSnapshot, FontSize, InstallRequest,
    InstallResult, ReconcileReport, ReconcileRequest, RegistryMenuAction, RegistryMenuRequest,
    RegistryRecord, RegistrySyncStatus, SkillFileContent, SkillFileList, SkillFileReadRequest,
    SkillFileRequest, SyncAllResult, SyncStatus, TargetDetection, Theme, UninstallRequest,
    UninstallResult, UpdateRegistryRequest,
};

/// The label of the window every command acts on.
pub const MAIN_WINDOW: &str = "main";

const MENU_GRACE: Duration = Duration::from_millis(300);

/// The pending registry menu, resolved by the app-wide menu event handler.
#[derive(Default)]
pub struct MenuSelection {
    sender: Mutex<Option<Sender<MenuAction>>>,
}

impl MenuSelection {
    /// Route a native menu item id to whoever is waiting on the menu.
    pub fn deliver(&self, item_id: &str) {
        let Some(action) = MenuAction::from_item_id(item_id) else {
            return;
        };
        if let Some(sender) = self.sender.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = sender.send(action);
        }
    }

    fn expect(&self) -> std::sync::mpsc::Receiver<MenuAction> {
        let (sender, receiver) = channel();
        *self.sender.lock().unwrap_or_else(|p| p.into_inner()) = Some(sender);
        receiver
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::failed(error.to_string()))?
}

async fn run<T: Send + 'static>(
    backend: &State<'_, Arc<Backend>>,
    work: impl FnOnce(&Backend) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let backend = Arc::clone(backend.inner());
    blocking(move || work(&backend)).await
}

async fn run_update<T: Send + 'static>(
    update: &State<'_, Arc<AppUpdate>>,
    work: impl FnOnce(&Arc<AppUpdate>) -> T + Send + 'static,
) -> AppResult<T> {
    let update = Arc::clone(update.inner());
    blocking(move || Ok(work(&update))).await
}

/// Apply the stored Theme to the main window and its background.
pub fn apply_theme(app: &AppHandle, theme: Theme) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.set_theme(forced_theme(theme));
    let system_dark = window
        .theme()
        .map(|current| current == tauri::Theme::Dark)
        .unwrap_or(true);
    set_window_background(app, uses_dark(theme, system_dark));
}

/// Paint the main window's background for the resolved scheme.
pub fn set_window_background(app: &AppHandle, dark: bool) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if let Some((r, g, b)) = parse_hex(background_color(dark)) {
        let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
    }
}

#[tauri::command]
pub async fn get_app_update_state(update: State<'_, Arc<AppUpdate>>) -> AppResult<AppUpdateState> {
    run_update(&update, |update| update.get_state()).await
}

#[tauri::command]
pub async fn check_app_update(update: State<'_, Arc<AppUpdate>>) -> AppResult<()> {
    run_update(&update, |update| update.check_manual()).await
}

#[tauri::command]
pub async fn get_auto_download_app_updates(update: State<'_, Arc<AppUpdate>>) -> AppResult<bool> {
    run_update(&update, |update| update.get_auto_download()).await
}

#[tauri::command]
pub async fn set_auto_download_app_updates(
    update: State<'_, Arc<AppUpdate>>,
    enabled: bool,
) -> AppResult<()> {
    run_update(&update, move |update| update.set_auto_download(enabled)).await
}

#[tauri::command]
pub async fn download_app_update(update: State<'_, Arc<AppUpdate>>) -> AppResult<()> {
    run_update(&update, |update| update.download()).await
}

#[tauri::command]
pub async fn restart_for_app_update(update: State<'_, Arc<AppUpdate>>) -> AppResult<()> {
    run_update(&update, |update| update.restart()).await
}

#[tauri::command]
pub async fn get_sync_concurrency(backend: State<'_, Arc<Backend>>) -> AppResult<usize> {
    run(&backend, |backend| Ok(backend.get_sync_concurrency())).await
}

#[tauri::command]
pub async fn set_sync_concurrency(
    backend: State<'_, Arc<Backend>>,
    concurrency: usize,
) -> AppResult<()> {
    run(&backend, move |backend| {
        backend.set_sync_concurrency(concurrency)
    })
    .await
}

#[tauri::command]
pub async fn get_appearance(backend: State<'_, Arc<Backend>>) -> AppResult<Appearance> {
    run(&backend, |backend| Ok(backend.get_appearance())).await
}

#[tauri::command]
pub async fn set_theme(
    app: AppHandle,
    backend: State<'_, Arc<Backend>>,
    theme: Theme,
) -> AppResult<()> {
    run(&backend, move |backend| backend.set_theme(theme)).await?;
    apply_theme(&app, theme);
    Ok(())
}

#[tauri::command]
pub async fn set_font_size(backend: State<'_, Arc<Backend>>, font_size: FontSize) -> AppResult<()> {
    run(&backend, move |backend| backend.set_font_size(font_size)).await
}

#[tauri::command]
pub async fn detect_targets(backend: State<'_, Arc<Backend>>) -> AppResult<TargetDetection> {
    run(&backend, |backend| backend.detect_targets()).await
}

#[tauri::command]
pub async fn install(
    backend: State<'_, Arc<Backend>>,
    request: InstallRequest,
) -> AppResult<InstallResult> {
    run(&backend, move |backend| backend.install(&request)).await
}

#[tauri::command]
pub async fn reconcile(
    backend: State<'_, Arc<Backend>>,
    request: Option<ReconcileRequest>,
) -> AppResult<ReconcileReport> {
    run(&backend, move |backend| {
        let request = request.unwrap_or_default();
        backend.reconcile(
            request.registry_id.as_deref(),
            request.folder_name.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn repair(
    backend: State<'_, Arc<Backend>>,
    request: InstallRequest,
) -> AppResult<InstallResult> {
    run(&backend, move |backend| backend.repair(&request)).await
}

#[tauri::command]
pub async fn uninstall(
    backend: State<'_, Arc<Backend>>,
    request: UninstallRequest,
) -> AppResult<UninstallResult> {
    run(&backend, move |backend| backend.uninstall(&request)).await
}

#[tauri::command]
pub async fn get_catalogue(backend: State<'_, Arc<Backend>>) -> AppResult<CatalogueSnapshot> {
    run(&backend, |backend| backend.get_catalogue()).await
}

#[tauri::command]
pub async fn refresh(backend: State<'_, Arc<Backend>>) -> AppResult<SyncAllResult> {
    run(&backend, |backend| backend.refresh()).await
}

#[tauri::command]
pub async fn get_sync_status(backend: State<'_, Arc<Backend>>) -> AppResult<SyncStatus> {
    run(&backend, |backend| backend.get_sync_status()).await
}

#[tauri::command]
pub async fn list_registries(backend: State<'_, Arc<Backend>>) -> AppResult<Vec<RegistryRecord>> {
    run(&backend, |backend| backend.list_registries()).await
}

#[tauri::command]
pub async fn add_registry(
    backend: State<'_, Arc<Backend>>,
    request: AddRegistryRequest,
) -> AppResult<RegistryRecord> {
    run(&backend, move |backend| backend.add_registry(&request)).await
}

#[tauri::command]
pub async fn update_registry(
    backend: State<'_, Arc<Backend>>,
    request: UpdateRegistryRequest,
) -> AppResult<RegistryRecord> {
    run(&backend, move |backend| backend.update_registry(&request)).await
}

#[tauri::command]
pub async fn remove_registry(backend: State<'_, Arc<Backend>>, id: String) -> AppResult<()> {
    run(&backend, move |backend| backend.remove_registry(&id)).await
}

#[tauri::command]
pub async fn sync_registry(
    backend: State<'_, Arc<Backend>>,
    id: String,
) -> AppResult<RegistrySyncStatus> {
    run(&backend, move |backend| backend.sync_registry(&id)).await
}

#[tauri::command]
pub async fn list_skill_files(
    backend: State<'_, Arc<Backend>>,
    request: SkillFileRequest,
) -> AppResult<SkillFileList> {
    run(&backend, move |backend| backend.list_skill_files(&request)).await
}

#[tauri::command]
pub async fn read_skill_file(
    backend: State<'_, Arc<Backend>>,
    request: SkillFileReadRequest,
) -> AppResult<SkillFileContent> {
    run(&backend, move |backend| backend.read_skill_file(&request)).await
}

fn menu_error(error: tauri::Error) -> AppError {
    AppError::failed(error.to_string())
}

fn build_menu(app: &AppHandle, items: &[RegistryMenuItem]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for item in items {
        match item {
            RegistryMenuItem::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            RegistryMenuItem::Normal {
                label,
                action,
                enabled,
            } => menu.append(
                &MenuItemBuilder::with_id(action.item_id(), *label)
                    .enabled(*enabled)
                    .build(app)?,
            )?,
            RegistryMenuItem::Checkbox {
                label,
                action,
                enabled,
                checked,
            } => menu.append(
                &CheckMenuItemBuilder::with_id(action.item_id(), *label)
                    .enabled(*enabled)
                    .checked(*checked)
                    .build(app)?,
            )?,
        }
    }
    Ok(menu)
}

/// Show the native registry menu. Copy URL and Open on GitHub run here; the
/// other picks resolve to the action the renderer performs.
#[tauri::command]
pub async fn show_registry_menu(
    app: AppHandle,
    window: Window,
    backend: State<'_, Arc<Backend>>,
    selection: State<'_, MenuSelection>,
    request: RegistryMenuRequest,
) -> AppResult<Option<RegistryMenuAction>> {
    let registry_id = request.registry_id.clone();
    let registry = run(&backend, move |backend| backend.registry(&registry_id)).await?;
    let menu =
        build_menu(&app, &registry_menu_template(&registry, request.busy)).map_err(menu_error)?;
    let receiver = selection.expect();
    let position = request.position;
    let picked = blocking(move || {
        match position {
            Some(at) => {
                window.popup_menu_at(&menu, LogicalPosition::new(at.x.round(), at.y.round()))
            }
            None => window.popup_menu(&menu),
        }
        .map_err(menu_error)?;
        Ok(receiver.recv_timeout(MENU_GRACE).ok())
    })
    .await?;
    match picked {
        Some(MenuAction::Renderer(action)) => Ok(Some(action)),
        Some(MenuAction::CopyUrl) => {
            app.clipboard()
                .write_text(registry.url.clone())
                .map_err(|error| AppError::failed(error.to_string()))?;
            Ok(None)
        }
        Some(MenuAction::OpenGithub) => {
            if let Some(url) = github_url(&registry) {
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|error| AppError::failed(error.to_string()))?;
            }
            Ok(None)
        }
        None => Ok(None),
    }
}
