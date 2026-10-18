//! Ported from vercel-labs/skills@1.7.0 (MIT License).
//! See UPSTREAM.md in this directory for maintenance notes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::paths::{is_contained_in, njoin, resolve};

const MARKETPLACE_FILE: &str = ".claude-plugin/marketplace.json";
const PLUGIN_FILE: &str = ".claude-plugin/plugin.json";

fn is_valid_relative_path(path: &str) -> bool {
    path.starts_with("./")
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// A marketplace plugin entry whose `source` is local (a valid relative path or
/// absent). Remote object sources and invalid paths are skipped.
struct LocalPlugin<'a> {
    entry: &'a Value,
    base: PathBuf,
}

fn local_marketplace_plugins<'a>(manifest: &'a Value, base_path: &Path) -> Vec<LocalPlugin<'a>> {
    let plugin_root = match manifest.pointer("/metadata/pluginRoot") {
        None => None,
        Some(Value::String(root)) if is_valid_relative_path(root) => Some(root.as_str()),
        Some(_) => return Vec::new(),
    };
    let Some(plugins) = manifest.get("plugins").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in plugins {
        let source = match entry.get("source") {
            None => None,
            Some(Value::String(source)) if is_valid_relative_path(source) => Some(source.as_str()),
            Some(_) => continue,
        };
        let base = njoin(
            &njoin(base_path, plugin_root.unwrap_or("")),
            source.unwrap_or(""),
        );
        result.push(LocalPlugin { entry, base });
    }
    result
}

/// Extract skill search directories from plugin manifests (`marketplace.json`
/// and `plugin.json`). Only local paths contained in `base_path` are resolved.
/// Returns directories that CONTAIN skills; explicit skill paths add their
/// parent directory so the discovery loop finds them.
pub fn get_plugin_skill_paths(base_path: &Path) -> Vec<PathBuf> {
    let mut search_dirs = Vec::new();

    let mut add_plugin_skill_paths = |plugin_base: &Path, skills: &[String]| {
        if !is_contained_in(plugin_base, base_path) {
            return;
        }
        for skill_path in skills {
            if !is_valid_relative_path(skill_path) {
                continue;
            }
            let skill_dir = njoin(plugin_base, skill_path)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| plugin_base.to_path_buf());
            if is_contained_in(&skill_dir, base_path) {
                search_dirs.push(skill_dir);
            }
        }
        search_dirs.push(njoin(plugin_base, "skills"));
    };

    if let Some(manifest) = read_json(&base_path.join(MARKETPLACE_FILE)) {
        for plugin in local_marketplace_plugins(&manifest, base_path) {
            add_plugin_skill_paths(&plugin.base, &string_list(plugin.entry.get("skills")));
        }
    }

    if let Some(manifest) = read_json(&base_path.join(PLUGIN_FILE)) {
        add_plugin_skill_paths(base_path, &string_list(manifest.get("skills")));
    }

    search_dirs
}

/// Map of absolute skill directory to the plugin name that declares it.
pub fn get_plugin_groupings(base_path: &Path) -> HashMap<PathBuf, String> {
    let mut groupings = HashMap::new();

    if let Some(manifest) = read_json(&base_path.join(MARKETPLACE_FILE)) {
        for plugin in local_marketplace_plugins(&manifest, base_path) {
            let Some(name) = plugin
                .entry
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            if !is_contained_in(&plugin.base, base_path) {
                continue;
            }
            for skill_path in string_list(plugin.entry.get("skills")) {
                if !is_valid_relative_path(&skill_path) {
                    continue;
                }
                let skill_dir = njoin(&plugin.base, &skill_path);
                if is_contained_in(&skill_dir, base_path) {
                    groupings.insert(resolve(&skill_dir), name.to_string());
                }
            }
        }
    }

    if let Some(manifest) = read_json(&base_path.join(PLUGIN_FILE)) {
        let name = manifest
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty());
        if let Some(name) = name {
            for skill_path in string_list(manifest.get("skills")) {
                if !is_valid_relative_path(&skill_path) {
                    continue;
                }
                let skill_dir = njoin(base_path, &skill_path);
                if is_contained_in(&skill_dir, base_path) {
                    groupings.insert(resolve(&skill_dir), name.to_string());
                }
            }
        }
    }

    groupings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_dir(marketplace: Option<&str>, plugin: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".claude-plugin")).unwrap();
        if let Some(content) = marketplace {
            std::fs::write(dir.path().join(MARKETPLACE_FILE), content).unwrap();
        }
        if let Some(content) = plugin {
            std::fs::write(dir.path().join(PLUGIN_FILE), content).unwrap();
        }
        dir
    }

    #[test]
    fn marketplace_plugins_add_skill_parents_and_skills_dir() {
        let dir = manifest_dir(
            Some(
                r#"{"plugins":[{"source":"./plugins/demo","name":"demo","skills":["./skills/review"]}]}"#,
            ),
            None,
        );
        let base = dir.path();
        let paths = get_plugin_skill_paths(base);
        assert_eq!(
            paths,
            vec![
                base.join("plugins/demo/skills"),
                base.join("plugins/demo/skills"),
            ]
        );
        let groupings = get_plugin_groupings(base);
        assert_eq!(
            groupings.get(&resolve(&base.join("plugins/demo/skills/review"))),
            Some(&"demo".to_string())
        );
    }

    #[test]
    fn plugin_json_groups_declared_skills() {
        let dir = manifest_dir(
            None,
            Some(r#"{"name":"solo","skills":["./skills/review"]}"#),
        );
        let groupings = get_plugin_groupings(dir.path());
        assert_eq!(
            groupings.get(&resolve(&dir.path().join("skills/review"))),
            Some(&"solo".to_string())
        );
    }

    #[test]
    fn rejects_escaping_remote_and_non_relative_paths() {
        let dir = manifest_dir(
            Some(
                r#"{"plugins":[
                {"source":{"source":"github","repo":"o/r"},"skills":["./a"]},
                {"source":"../outside","skills":["./a"]},
                {"source":"./ok","skills":["../../escape","skills/x"]}
            ]}"#,
            ),
            None,
        );
        let paths = get_plugin_skill_paths(dir.path());
        assert_eq!(paths, vec![dir.path().join("ok/skills")]);
    }

    #[test]
    fn missing_or_malformed_manifests_yield_nothing() {
        let dir = manifest_dir(Some("not json"), Some("[1,2"));
        assert!(get_plugin_skill_paths(dir.path()).is_empty());
        assert!(get_plugin_groupings(dir.path()).is_empty());
    }
}
