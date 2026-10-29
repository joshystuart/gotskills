//! Ported from vercel-labs/skills@1.7.0 (MIT License).
//! See UPSTREAM.md in this directory for maintenance notes.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_yaml::{Mapping, Value};

use super::constants::DEFAULT_SKILL_CONTAINER_DEPTH;
use super::frontmatter::parse_frontmatter;
use super::local_lock::read_local_lock_skill_names;
use super::paths::{njoin, normalize, resolve};
use super::plugin_manifest::{get_plugin_groupings, get_plugin_skill_paths};
use super::sanitize::{sanitize_metadata, strip_terminal_escapes};

pub(crate) const SKIP_DIRS: [&str; 5] = ["node_modules", ".git", "dist", "build", "__pycache__"];

const AGENT_PROJECT_SKILL_DIRS: [&str; 30] = [
    ".agents/skills",
    ".claude/skills",
    ".cline/skills",
    ".codebuddy/skills",
    ".codex/skills",
    ".commandcode/skills",
    ".continue/skills",
    ".factory/skills",
    ".github/skills",
    ".goose/skills",
    ".grok/skills",
    ".iflow/skills",
    ".junie/skills",
    ".kilo/skills",
    ".kilocode/skills",
    ".kimchi/skills",
    ".kiro/skills",
    ".minimax/skills",
    ".mux/skills",
    ".neovate/skills",
    ".opencode/skills",
    ".openhands/skills",
    ".pi/skills",
    ".posit/assistant/skills",
    ".qoder/skills",
    ".roo/skills",
    ".trae/skills",
    ".windsurf/skills",
    ".zcode/skills",
    ".zencoder/skills",
];

/// A discovered skill.
#[derive(Debug, Clone, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub raw_content: Option<String>,
    pub plugin_name: Option<String>,
    pub metadata: Option<Mapping>,
}

/// Options for [`discover_skills`].
#[derive(Debug, Clone, Copy, Default)]
pub struct DiscoverSkillsOptions {
    pub include_internal: bool,
    pub full_depth: bool,
    pub include_duplicate_names: bool,
}

fn normalize_skill_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut in_run = false;
    for ch in lower.chars() {
        if ch.is_whitespace() || ch == '_' {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        } else {
            out.push(ch);
            in_run = false;
        }
    }
    out
}

fn posix_relative(base: &Path, path: &Path) -> String {
    let base = normalize(base);
    let path = normalize(path);
    let text = path
        .strip_prefix(&base)
        .map(|rel| rel.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string());
    let mut collapsed = String::new();
    let mut previous_slash = false;
    for ch in text.chars() {
        if ch == '/' && previous_slash {
            continue;
        }
        previous_slash = ch == '/';
        collapsed.push(ch);
    }
    collapsed
}

/// Whether internal skills should be installed (`INSTALL_INTERNAL_SKILLS=1|true`).
pub fn should_install_internal_skills() -> bool {
    matches!(
        std::env::var("INSTALL_INTERNAL_SKILLS").as_deref(),
        Ok("1") | Ok("true")
    )
}

/// Whether `dir/SKILL.md` exists and is a file.
pub fn has_skill_md(dir: &Path) -> bool {
    fs::metadata(dir.join("SKILL.md"))
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

/// The warning text for a skipped SKILL.md.
pub fn skipped_skill_message(skill_md_path: &Path, reason: &str) -> String {
    format!(
        "\u{26a0} Skipped {} \u{2014} {}",
        sanitize_metadata(&skill_md_path.to_string_lossy()),
        strip_terminal_escapes(reason)
    )
}

fn warn_skipped_skill(skill_md_path: &Path, reason: &str) {
    eprintln!("{}", skipped_skill_message(skill_md_path, reason));
}

fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number
            .as_f64()
            .map(|n| n != 0.0 && !n.is_nan())
            .unwrap_or(true),
        Some(_) => true,
    }
}

fn type_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::String(_)) => "string",
        Some(Value::Number(_)) => "number",
        Some(Value::Bool(_)) => "boolean",
        Some(_) => "object",
    }
}

/// Parse a SKILL.md. Returns `None` (after warning) for unreadable, malformed
/// or hidden-internal skills.
pub fn parse_skill_md(skill_md_path: &Path, include_internal: bool) -> Option<Skill> {
    let content = match fs::read_to_string(skill_md_path) {
        Ok(content) => content,
        Err(error) => {
            warn_skipped_skill(skill_md_path, &format!("failed to read file: {error}"));
            return None;
        }
    };

    let data = match parse_frontmatter(&content) {
        Ok(parsed) => parsed.data,
        Err(error) => {
            warn_skipped_skill(skill_md_path, &format!("YAML parse error: {error}"));
            return None;
        }
    };

    let name = data.get("name");
    let description = data.get("description");
    if !is_truthy(name) || !is_truthy(description) {
        let mut missing = Vec::new();
        if !is_truthy(name) {
            missing.push("name");
        }
        if !is_truthy(description) {
            missing.push("description");
        }
        warn_skipped_skill(
            skill_md_path,
            &format!(
                "missing required frontmatter field(s): {}",
                missing.join(", ")
            ),
        );
        return None;
    }

    let (Some(Value::String(name)), Some(Value::String(description))) = (name, description) else {
        warn_skipped_skill(
            skill_md_path,
            &format!(
                "frontmatter \"name\" and \"description\" must be strings (got {} and {})",
                type_name(name),
                type_name(description)
            ),
        );
        return None;
    };

    let metadata = match data.get("metadata") {
        Some(Value::Mapping(mapping)) => Some(mapping.clone()),
        _ => None,
    };
    let is_internal = metadata
        .as_ref()
        .and_then(|mapping| mapping.get("internal"))
        == Some(&Value::Bool(true));
    if is_internal && !should_install_internal_skills() && !include_internal {
        return None;
    }

    Some(Skill {
        name: sanitize_metadata(name),
        description: sanitize_metadata(description),
        path: skill_md_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default(),
        raw_content: Some(content),
        plugin_name: None,
        metadata,
    })
}

/// Directory entries sorted by name (Node's `readdir` is `alphasort`ed), with
/// the entry type taken without following symlinks.
fn sorted_entries(dir: &Path) -> Option<Vec<(String, fs::FileType)>> {
    let mut entries: Vec<(String, fs::FileType)> = fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            Some((entry.file_name().to_string_lossy().to_string(), file_type))
        })
        .collect();
    entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Some(entries)
}

fn find_skill_dirs(dir: &Path, depth: usize, max_depth: usize) -> Vec<PathBuf> {
    if depth > max_depth {
        return Vec::new();
    }
    let mut found = Vec::new();
    if has_skill_md(dir) {
        found.push(dir.to_path_buf());
    }
    for (name, file_type) in sorted_entries(dir).unwrap_or_default() {
        if file_type.is_dir() && !SKIP_DIRS.contains(&name.as_str()) {
            found.extend(find_skill_dirs(&dir.join(&name), depth + 1, max_depth));
        }
    }
    found
}

/// Whether `subpath` stays within `base_path` once resolved.
pub fn is_subpath_safe(base_path: &Path, subpath: &str) -> bool {
    resolve(&base_path.join(subpath)).starts_with(resolve(base_path))
}

struct Discovery<'a> {
    base_path: &'a Path,
    options: DiscoverSkillsOptions,
    skills: Vec<Skill>,
    seen_names: HashSet<String>,
    parsed_skill_paths: HashSet<PathBuf>,
    locked_skill_names: HashSet<String>,
    plugin_groupings: std::collections::HashMap<PathBuf, String>,
}

impl Discovery<'_> {
    fn enhance(&self, mut skill: Skill) -> Skill {
        if let Some(name) = self.plugin_groupings.get(&resolve(&skill.path)) {
            skill.plugin_name = Some(name.clone());
        }
        skill
    }

    fn is_installed_project_skill(&self, skill: &Skill) -> bool {
        if self.locked_skill_names.is_empty() {
            return false;
        }
        let relative_dir = posix_relative(self.base_path, &skill.path);
        let is_agent_skill_path = AGENT_PROJECT_SKILL_DIRS
            .iter()
            .any(|dir| relative_dir == *dir || relative_dir.starts_with(&format!("{dir}/")));
        if !is_agent_skill_path {
            return false;
        }
        let directory_name = skill
            .path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        self.locked_skill_names
            .contains(&normalize_skill_name(&skill.name))
            || self
                .locked_skill_names
                .contains(&normalize_skill_name(&directory_name))
    }

    fn parse_skill_at(&mut self, skill_dir: &Path) -> Option<Skill> {
        let skill_md_path = resolve(&skill_dir.join("SKILL.md"));
        if !self.parsed_skill_paths.insert(skill_md_path.clone()) {
            return None;
        }
        parse_skill_md(&skill_md_path, self.options.include_internal)
    }

    fn try_add_skill_at(&mut self, skill_dir: &Path) -> bool {
        if !has_skill_md(skill_dir) {
            return false;
        }
        let Some(skill) = self.parse_skill_at(skill_dir) else {
            return true;
        };
        if !self.options.include_duplicate_names && self.seen_names.contains(&skill.name) {
            return true;
        }
        if self.is_installed_project_skill(&skill) {
            return true;
        }
        let skill = self.enhance(skill);
        self.seen_names.insert(skill.name.clone());
        self.skills.push(skill);
        true
    }

    fn walk_skill_dirs(&mut self, dir: &Path, max_depth: usize, depth: usize) {
        let Some(entries) = sorted_entries(dir) else {
            return;
        };
        for (name, file_type) in entries {
            if !file_type.is_dir() {
                continue;
            }
            let child_dir = dir.join(&name);
            let found_at_child = self.try_add_skill_at(&child_dir);
            if found_at_child || depth >= max_depth || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            self.walk_skill_dirs(&child_dir, max_depth, depth + 1);
        }
    }
}

/// Discover skills under `base_path` (optionally below `subpath`) using the
/// vercel-labs/skills rules: a root SKILL.md, priority container directories
/// (walked up to three levels), plugin-manifest directories, then a full walk
/// when nothing was found. Errors only for an unsafe `subpath`.
pub fn discover_skills(
    base_path: &Path,
    subpath: Option<&str>,
    options: DiscoverSkillsOptions,
) -> Result<Vec<Skill>, String> {
    if let Some(subpath) = subpath.filter(|value| !value.is_empty()) {
        if !is_subpath_safe(base_path, subpath) {
            return Err(format!(
                "Invalid subpath: \"{subpath}\" resolves outside the repository directory. Subpath must not contain \"..\" segments that escape the base path."
            ));
        }
    }
    let search_path = match subpath.filter(|value| !value.is_empty()) {
        Some(subpath) => njoin(base_path, subpath),
        None => base_path.to_path_buf(),
    };

    let mut discovery = Discovery {
        base_path,
        options,
        skills: Vec::new(),
        seen_names: HashSet::new(),
        parsed_skill_paths: HashSet::new(),
        locked_skill_names: read_local_lock_skill_names(base_path)
            .iter()
            .map(|name| normalize_skill_name(name))
            .collect(),
        plugin_groupings: get_plugin_groupings(&search_path),
    };

    if has_skill_md(&search_path) {
        if let Some(skill) = discovery.parse_skill_at(&search_path) {
            if !discovery.is_installed_project_skill(&skill) {
                let skill = discovery.enhance(skill);
                discovery.seen_names.insert(skill.name.clone());
                discovery.skills.push(skill);
                if !options.full_depth {
                    return Ok(discovery.skills);
                }
            }
        }
    }

    let mut priority_search_dirs: Vec<PathBuf> = vec![
        search_path.clone(),
        njoin(&search_path, "skills"),
        njoin(&search_path, "skills/.curated"),
        njoin(&search_path, "skills/.experimental"),
        njoin(&search_path, "skills/.system"),
    ];
    priority_search_dirs.extend(
        AGENT_PROJECT_SKILL_DIRS
            .iter()
            .map(|dir| njoin(&search_path, dir)),
    );

    let deep_container_dirs: HashSet<PathBuf> =
        priority_search_dirs.iter().skip(1).cloned().collect();

    priority_search_dirs.extend(get_plugin_skill_paths(&search_path));

    for dir in &priority_search_dirs {
        let max_depth = if deep_container_dirs.contains(dir) {
            DEFAULT_SKILL_CONTAINER_DEPTH
        } else {
            1
        };
        discovery.walk_skill_dirs(dir, max_depth, 1);
    }

    if discovery.skills.is_empty() || options.full_depth {
        for skill_dir in find_skill_dirs(&search_path, 0, 5) {
            let Some(skill) = discovery.parse_skill_at(&skill_dir) else {
                continue;
            };
            if (options.include_duplicate_names || !discovery.seen_names.contains(&skill.name))
                && !discovery.is_installed_project_skill(&skill)
            {
                let skill = discovery.enhance(skill);
                discovery.seen_names.insert(skill.name.clone());
                discovery.skills.push(skill);
            }
        }
    }

    Ok(discovery.skills)
}

/// A skill's display name: its name, else its directory name.
pub fn skill_display_name(skill: &Skill) -> String {
    if skill.name.is_empty() {
        skill
            .path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        skill.name.clone()
    }
}

/// Filter skills by case-insensitive name match.
pub fn filter_skills<'a>(skills: &'a [Skill], input_names: &[&str]) -> Vec<&'a Skill> {
    let inputs: Vec<String> = input_names.iter().map(|name| name.to_lowercase()).collect();
    skills
        .iter()
        .filter(|skill| {
            let name = skill.name.to_lowercase();
            let display = skill_display_name(skill).to_lowercase();
            inputs
                .iter()
                .any(|input| *input == name || *input == display)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, dir: &str, frontmatter: &str) {
        let path = root.join(dir);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("SKILL.md"),
            format!("---\n{frontmatter}\n---\n\n# Skill\n"),
        )
        .unwrap();
    }

    fn names(skills: &[Skill]) -> Vec<String> {
        skills.iter().map(|skill| skill.name.clone()).collect()
    }

    #[test]
    fn normalises_skill_names() {
        assert_eq!(normalize_skill_name("My  Skill_name"), "my-skill-name");
    }

    #[test]
    fn a_root_skill_stops_discovery() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), ".", "name: root\ndescription: Root");
        write_skill(
            dir.path(),
            "skills/other",
            "name: other\ndescription: Other",
        );
        let found = discover_skills(dir.path(), None, DiscoverSkillsOptions::default()).unwrap();
        assert_eq!(names(&found), vec!["root"]);
    }

    #[test]
    fn full_depth_continues_past_a_root_skill() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), ".", "name: root\ndescription: Root");
        write_skill(
            dir.path(),
            "skills/other",
            "name: other\ndescription: Other",
        );
        let options = DiscoverSkillsOptions {
            full_depth: true,
            ..Default::default()
        };
        let found = discover_skills(dir.path(), None, options).unwrap();
        assert_eq!(names(&found), vec!["root", "other"]);
    }

    #[test]
    fn falls_back_to_a_full_walk_when_no_container_matches() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(
            dir.path(),
            "examples/foo",
            "name: example\ndescription: Outside",
        );
        let found = discover_skills(dir.path(), None, DiscoverSkillsOptions::default()).unwrap();
        assert_eq!(names(&found), vec!["example"]);
    }

    #[test]
    fn skips_vendor_directories_in_the_full_walk() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(
            dir.path(),
            "node_modules/pkg",
            "name: vendored\ndescription: No",
        );
        let found = discover_skills(dir.path(), None, DiscoverSkillsOptions::default()).unwrap();
        assert!(found.is_empty());
    }

    #[test]
    fn rejects_a_subpath_escaping_the_base() {
        let dir = tempfile::tempdir().unwrap();
        let error = discover_skills(dir.path(), Some("../x"), DiscoverSkillsOptions::default())
            .unwrap_err();
        assert!(error.starts_with("Invalid subpath"));
    }

    #[test]
    fn hides_installed_project_skills_listed_in_the_local_lock() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(
            dir.path(),
            ".claude/skills/locked",
            "name: locked\ndescription: Installed",
        );
        write_skill(dir.path(), "skills/free", "name: free\ndescription: Source");
        fs::write(
            dir.path().join("skills-lock.json"),
            r#"{"version":1,"skills":{"locked":{}}}"#,
        )
        .unwrap();
        let found = discover_skills(dir.path(), None, DiscoverSkillsOptions::default()).unwrap();
        assert_eq!(names(&found), vec!["free"]);
    }

    #[test]
    fn internal_skills_need_the_include_flag() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(
            dir.path(),
            "skills/hidden",
            "name: hidden\ndescription: H\nmetadata:\n  internal: true",
        );
        assert!(parse_skill_md(&dir.path().join("skills/hidden/SKILL.md"), false).is_none());
        assert!(parse_skill_md(&dir.path().join("skills/hidden/SKILL.md"), true).is_some());
    }

    #[test]
    fn rejects_non_string_and_missing_fields() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), "a", "name: 5\ndescription: ok");
        write_skill(dir.path(), "b", "name: only");
        assert!(parse_skill_md(&dir.path().join("a/SKILL.md"), false).is_none());
        assert!(parse_skill_md(&dir.path().join("b/SKILL.md"), false).is_none());
    }

    #[test]
    fn warning_names_the_skipped_file_and_reason() {
        let message = skipped_skill_message(
            Path::new("/r/skills/no-desc/SKILL.md"),
            "missing required frontmatter field(s): description",
        );
        assert_eq!(
            message,
            "\u{26a0} Skipped /r/skills/no-desc/SKILL.md \u{2014} missing required frontmatter field(s): description"
        );
    }

    #[test]
    fn filters_by_name_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), "skills/a", "name: Alpha\ndescription: A");
        let found = discover_skills(dir.path(), None, DiscoverSkillsOptions::default()).unwrap();
        assert_eq!(filter_skills(&found, &["alpha"]).len(), 1);
        assert!(filter_skills(&found, &["beta"]).is_empty());
    }
}
