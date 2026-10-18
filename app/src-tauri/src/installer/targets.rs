//! Install target ids and detection.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::env::Environment;
use crate::types::{InstallTargetAgent, InstallTargetStatus, SupportedAgent};

use super::agents::{AgentDirectory, AgentInfo};

/// The Shared Target, served by every universal agent.
pub const SHARED_TARGET: &str = "~/.agents/skills";

/// The folder a target id refers to: `~/<rel>` under `home`, otherwise absolute.
pub fn target_folder(home: &Path, target: &str) -> PathBuf {
    match target.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(target),
    }
}

/// The target id for a folder: `~/<rel>` when under `home`, otherwise the path.
pub fn target_id_for_folder(home: &Path, folder: &Path) -> String {
    match folder.strip_prefix(home) {
        Ok(rel) if !rel.as_os_str().is_empty() => format!("~/{}", rel.to_string_lossy()),
        _ => folder.to_string_lossy().into_owned(),
    }
}

/// Where a skill lives inside a target.
pub fn target_install_path(home: &Path, target: &str, folder_name: &str) -> PathBuf {
    target_folder(home, target).join(folder_name)
}

fn target_names(id: &str, served: &[AgentInfo], native: &[&AgentInfo]) -> Vec<String> {
    let detected: Vec<&AgentInfo> = served.iter().filter(|agent| agent.detected).collect();
    if id == SHARED_TARGET && detected.is_empty() {
        return vec!["Shared folder".to_string()];
    }
    let named: Vec<String> = if id == SHARED_TARGET {
        detected.iter().map(|a| a.display_name.clone()).collect()
    } else if !served.is_empty() {
        served.iter().map(|a| a.display_name.clone()).collect()
    } else {
        native.iter().map(|a| a.display_name.clone()).collect()
    };
    if named.is_empty() {
        vec![id.to_string()]
    } else {
        named
    }
}

fn dedupe(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// Every target the app can show: one per served folder, the Shared Target, and
/// any folder that only holds install records. `visible` marks those with a
/// detected agent or a record.
pub fn detect_install_targets(
    environment: &Environment,
    directory: &dyn AgentDirectory,
    record_targets: impl IntoIterator<Item = String>,
) -> Vec<InstallTargetStatus> {
    let home = &environment.home;
    let with_records = dedupe(record_targets);
    let table = directory.agents();

    let mut served: Vec<(String, Vec<AgentInfo>)> = Vec::new();
    for agent in &table {
        let id = target_id_for_folder(home, &agent.install_folder);
        match served.iter_mut().find(|(existing, _)| *existing == id) {
            Some((_, agents)) => agents.push(agent.clone()),
            None => served.push((id, vec![agent.clone()])),
        }
    }
    let is_served = |id: &str| served.iter().any(|(existing, _)| existing == id);

    let mut ids: Vec<String> = served
        .iter()
        .map(|(id, _)| id.clone())
        .filter(|id| id != SHARED_TARGET)
        .collect();
    ids.push(SHARED_TARGET.to_string());
    ids.extend(
        with_records
            .iter()
            .filter(|id| !is_served(id) && id.as_str() != SHARED_TARGET)
            .cloned(),
    );

    ids.into_iter()
        .map(|id| {
            let target_agents: &[AgentInfo] = served
                .iter()
                .find(|(existing, _)| *existing == id)
                .map(|(_, agents)| agents.as_slice())
                .unwrap_or(&[]);
            let native: Vec<&AgentInfo> = table
                .iter()
                .filter(|agent| target_id_for_folder(home, &agent.native_folder) == id)
                .collect();
            InstallTargetStatus {
                label: target_names(&id, target_agents, &native).join(", "),
                shared: id == SHARED_TARGET,
                visible: with_records.contains(&id) || target_agents.iter().any(|a| a.detected),
                agents: target_agents
                    .iter()
                    .map(|agent| InstallTargetAgent {
                        id: agent.id.clone(),
                        display_name: agent.display_name.clone(),
                        detected: agent.detected,
                    })
                    .collect(),
                id,
            }
        })
        .collect()
}

/// Every supported agent with the target it installs into.
pub fn supported_agents(
    environment: &Environment,
    directory: &dyn AgentDirectory,
) -> Vec<SupportedAgent> {
    directory
        .agents()
        .into_iter()
        .map(|agent| SupportedAgent {
            target: target_id_for_folder(&environment.home, &agent.install_folder),
            id: agent.id,
            display_name: agent.display_name,
            detected: agent.detected,
        })
        .collect()
}

/// The home-relative target ids, which telemetry reports on.
pub fn telemetry_targets(
    environment: &Environment,
    directory: &dyn AgentDirectory,
    record_targets: impl IntoIterator<Item = String>,
) -> HashSet<String> {
    detect_install_targets(environment, directory, record_targets)
        .into_iter()
        .map(|target| target.id)
        .filter(|id| id.starts_with("~/"))
        .collect()
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn agent(home: &Path, id: &str, name: &str, folder: &str, detected: bool) -> AgentInfo {
        AgentInfo {
            id: id.into(),
            display_name: name.into(),
            install_folder: home.join(folder),
            native_folder: home.join(folder),
            detected,
        }
    }

    pub fn universal(home: &Path, id: &str, name: &str, native: &str, detected: bool) -> AgentInfo {
        AgentInfo {
            install_folder: home.join(".agents/skills"),
            native_folder: home.join(native),
            ..agent(home, id, name, native, detected)
        }
    }

    pub fn table(home: &Path, detected: &[&str]) -> Vec<AgentInfo> {
        let on = |id: &str| detected.contains(&id);
        vec![
            agent(
                home,
                "claude-code",
                "Claude Code",
                ".claude/skills",
                on("claude-code"),
            ),
            universal(home, "codex", "Codex", ".codex/skills", on("codex")),
            universal(home, "cursor", "Cursor", ".cursor/skills", on("cursor")),
            agent(home, "goose", "Goose", ".config/goose/skills", on("goose")),
            agent(
                home,
                "windsurf",
                "Windsurf",
                ".codeium/windsurf/skills",
                on("windsurf"),
            ),
            agent(
                home,
                "zencoder",
                "Zencoder",
                ".zencoder/skills",
                on("zencoder"),
            ),
            agent(
                home,
                "zenflow",
                "Zenflow",
                ".zencoder/skills",
                on("zencoder"),
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    fn env(home: &Path) -> Environment {
        Environment::fake_home(home)
    }

    #[test]
    fn target_ids_round_trip_through_folders() {
        let home = Path::new("/h");
        assert_eq!(
            target_folder(home, "~/.claude/skills"),
            PathBuf::from("/h/.claude/skills")
        );
        assert_eq!(
            target_folder(home, "/elsewhere"),
            PathBuf::from("/elsewhere")
        );
        assert_eq!(
            target_id_for_folder(home, Path::new("/h/.claude/skills")),
            "~/.claude/skills"
        );
        assert_eq!(
            target_id_for_folder(home, Path::new("/other/x")),
            "/other/x"
        );
        assert_eq!(target_id_for_folder(home, home), "/h");
        assert_eq!(
            target_install_path(home, SHARED_TARGET, "alpha"),
            PathBuf::from("/h/.agents/skills/alpha")
        );
    }

    #[test]
    fn shows_detected_agents_and_folders_holding_records() {
        let home = Path::new("/h");
        let table = table(home, &["claude-code", "cursor", "codex", "goose"]);
        let records = [
            "~/.codeium/windsurf/skills",
            "~/.cursor/skills",
            "/unclaimed",
        ]
        .map(String::from);
        let visible: Vec<(String, String, bool)> =
            detect_install_targets(&env(home), &table, records)
                .into_iter()
                .filter(|target| target.visible)
                .map(|t| (t.id, t.label, t.shared))
                .collect();
        let expected: Vec<(String, String, bool)> = [
            ("~/.claude/skills", "Claude Code", false),
            ("~/.config/goose/skills", "Goose", false),
            ("~/.codeium/windsurf/skills", "Windsurf", false),
            ("~/.agents/skills", "Codex, Cursor", true),
            ("~/.cursor/skills", "Cursor", false),
            ("/unclaimed", "/unclaimed", false),
        ]
        .map(|(a, b, c)| (a.to_string(), b.to_string(), c))
        .to_vec();
        assert_eq!(visible, expected);
    }

    #[test]
    fn the_shared_target_is_a_shared_folder_until_it_holds_installs() {
        let home = Path::new("/h");
        let table = table(home, &["claude-code"]);
        let before = detect_install_targets(&env(home), &table, Vec::new());
        let shared = before.iter().find(|t| t.shared).unwrap();
        assert_eq!(
            (shared.label.as_str(), shared.visible),
            ("Shared folder", false)
        );

        let after = detect_install_targets(&env(home), &table, vec![SHARED_TARGET.to_string()]);
        let shared = after.iter().find(|t| t.shared).unwrap();
        assert_eq!(
            (shared.label.as_str(), shared.visible),
            ("Shared folder", true)
        );
    }

    #[test]
    fn a_folder_shared_by_agents_is_one_target_labelled_by_all() {
        let home = Path::new("/h");
        let table = table(home, &["zencoder"]);
        let targets = detect_install_targets(&env(home), &table, Vec::new());
        let zen: Vec<_> = targets
            .iter()
            .filter(|t| t.id == "~/.zencoder/skills")
            .collect();
        assert_eq!(zen.len(), 1);
        assert_eq!(zen[0].label, "Zencoder, Zenflow");
        assert!(zen[0].visible);
        assert_eq!(zen[0].agents.len(), 2);
        assert!(zen[0].agents.iter().all(|a| a.detected));
    }

    #[test]
    fn records_for_an_unserved_folder_are_listed_once() {
        let home = Path::new("/h");
        let table = table(home, &[]);
        let records = vec!["/elsewhere".to_string(), "/elsewhere".to_string()];
        let targets = detect_install_targets(&env(home), &table, records);
        let extra: Vec<_> = targets.iter().filter(|t| t.id == "/elsewhere").collect();
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].label, "/elsewhere");
        assert!(extra[0].visible && !extra[0].shared && extra[0].agents.is_empty());
    }

    #[test]
    fn supported_agents_map_to_their_install_target() {
        let home = Path::new("/h");
        let table = table(home, &["claude-code"]);
        let agents = supported_agents(&env(home), &table);
        let find = |id: &str| agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(find("claude-code").target, "~/.claude/skills");
        assert!(find("claude-code").detected);
        assert_eq!(find("cursor").target, "~/.agents/skills");
        assert!(!find("cursor").detected);
    }

    #[test]
    fn telemetry_targets_keep_only_home_relative_ids() {
        let home = Path::new("/h");
        let table = table(home, &[]);
        let targets = telemetry_targets(&env(home), &table, vec!["/elsewhere".to_string()]);
        assert!(targets.contains(SHARED_TARGET));
        assert!(!targets.contains("/elsewhere"));
    }
}
