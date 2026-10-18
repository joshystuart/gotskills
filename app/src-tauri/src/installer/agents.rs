//! The agent information the installer needs, supplied by the mirror module.

use std::path::PathBuf;

/// One row of the agent table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInfo {
    pub id: String,
    pub display_name: String,
    /// The folder skills are installed into for this agent (the shared
    /// `~/.agents/skills` for universal agents, otherwise the native folder).
    pub install_folder: PathBuf,
    /// The agent's own global skills folder.
    pub native_folder: PathBuf,
    pub detected: bool,
}

/// Source of the agent table, in table order.
pub trait AgentDirectory {
    fn agents(&self) -> Vec<AgentInfo>;
}

impl AgentDirectory for Vec<AgentInfo> {
    fn agents(&self) -> Vec<AgentInfo> {
        self.clone()
    }
}

impl AgentDirectory for [AgentInfo] {
    fn agents(&self) -> Vec<AgentInfo> {
        self.to_vec()
    }
}
