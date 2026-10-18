//! Skill install, uninstall, reconcile and target handling (work package C).
//!
//! There is no Node runtime: [`copy`] reimplements what
//! `skills add <mirror> --skill X -g -a <agent> -y --copy` did, and the agent
//! table is injected through [`agents::AgentDirectory`].

pub mod agents;
pub mod convert;
pub mod copy;
pub mod errors;
pub mod install;
pub mod mutex;
pub mod reconcile;
pub mod records;
pub mod targets;
pub mod uninstall;

#[cfg(test)]
mod test_support;

pub use agents::{AgentDirectory, AgentInfo};
pub use convert::convert_symlink_installs;
pub use errors::redact_error;
pub use install::{install_skill, InstallDeps, INSTALLER_VERSION, REVISION_REFUSED_MESSAGE};
pub use mutex::MirrorMutex;
pub use reconcile::{lock_agrees, per_target_from_reconcile, reconcile, ReconcileDeps};
pub use records::{
    delete_install_record, read_install_records, read_occupancy, upsert_install_record,
    InstallRecordFilter,
};
pub use targets::{
    detect_install_targets, supported_agents, target_folder, target_id_for_folder,
    target_install_path, telemetry_targets, SHARED_TARGET,
};
pub use uninstall::{uninstall_skill, UninstallDeps};
