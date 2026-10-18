//! Got Skills backend: a Tauri v2 shell over a Rust core.

pub mod app_settings;
pub mod backend;
pub mod commands;
pub mod config;
pub mod db;
pub mod env;
pub mod error;
pub mod installer;
pub mod mirror;
pub mod registries;
pub mod registry_url;
pub mod short_sha;
pub mod telemetry;
pub mod types;

/// Start the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Got Skills");
}
