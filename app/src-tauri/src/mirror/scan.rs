use std::cmp::Ordering;
use std::path::Path;

use super::discovery::skills::{discover_skills, DiscoverSkillsOptions};
use super::git_exec::git;

/// A skill found in a mirror, with git provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedSkill {
    /// Install key: the frontmatter `name`, matching CLI `--skill` resolution.
    pub id: String,
    /// POSIX-relative path from the mirror root to the skill directory.
    pub skill_path: String,
    pub name: String,
    pub description: String,
    /// Last-touching commit SHA for `skill_path`.
    pub provenance_sha: String,
    /// Git tree OID of `skill_path` at HEAD (content hash for update detection).
    pub content_hash: String,
    /// ISO-8601 commit date of the provenance SHA.
    pub updated_at: String,
    /// Optional grouping metadata from a plugin manifest.
    pub plugin_name: Option<String>,
}

/// Approximation of `String.prototype.localeCompare` for ordering identifiers:
/// case-insensitive first, lowercase before uppercase on ties.
pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}

fn to_posix_skill_path(mirror_path: &Path, skill_dir: &Path) -> String {
    skill_dir
        .strip_prefix(mirror_path)
        .unwrap_or(skill_dir)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Discover skills via the ported vercel-labs/skills rules, then attach git
/// provenance per discovered path. Malformed or internal skills are skipped, as
/// are skills whose git metadata cannot be read.
pub fn scan_skills(mirror_path: &Path) -> Vec<ScannedSkill> {
    let discovered =
        discover_skills(mirror_path, None, DiscoverSkillsOptions::default()).unwrap_or_default();
    let mut results = Vec::new();

    for skill in discovered {
        let skill_path = to_posix_skill_path(mirror_path, &skill.path);
        let metadata = (|| {
            Ok::<_, super::git_exec::GitError>((
                git(
                    mirror_path,
                    &["log", "-1", "--format=%H", "--", &skill_path],
                )?,
                git(mirror_path, &["rev-parse", &format!("HEAD:{skill_path}")])?,
                git(
                    mirror_path,
                    &["log", "-1", "--format=%cI", "--", &skill_path],
                )?,
            ))
        })();
        let (provenance_sha, content_hash, updated_at) = match metadata {
            Ok(values) => values,
            Err(error) => {
                eprintln!(
                    "[scan] skip {} ({skill_path}): git metadata failed: {error}",
                    skill.name
                );
                continue;
            }
        };
        results.push(ScannedSkill {
            id: skill.name.clone(),
            skill_path,
            name: skill.name,
            description: skill.description,
            provenance_sha,
            content_hash,
            updated_at,
            plugin_name: skill.plugin_name,
        });
    }

    results.sort_by(|a, b| locale_compare(&a.id, &b.id));
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mirror::test_support::{commit_all, git as run_git, make_repo, write_skill};
    use std::fs;

    fn paths(skills: &[ScannedSkill]) -> Vec<&str> {
        skills.iter().map(|s| s.skill_path.as_str()).collect()
    }

    fn ids(skills: &[ScannedSkill]) -> Vec<&str> {
        skills.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn discovers_flat_skills_with_id_from_frontmatter_name() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/alpha",
            Some("name: alpha\ndescription: First skill"),
        );
        write_skill(
            repo.path(),
            "skills/beta",
            Some("name: beta\ndescription: Second skill"),
        );
        commit_all(repo.path(), "add skills");

        let found = scan_skills(repo.path());
        assert_eq!(ids(&found), vec!["alpha", "beta"]);
        let alpha = &found[0];
        assert_eq!(alpha.name, "alpha");
        assert_eq!(alpha.description, "First skill");
        assert_eq!(alpha.skill_path, "skills/alpha");
    }

    #[test]
    fn discovers_nested_category_skills_with_install_key_and_path() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/engineering/code-review",
            Some("name: code-review\ndescription: Review code"),
        );
        commit_all(repo.path(), "nested skill");

        let found = scan_skills(repo.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "code-review");
        assert_eq!(found[0].skill_path, "skills/engineering/code-review");
        assert_eq!(found[0].description, "Review code");
    }

    #[test]
    fn discovers_skills_nested_three_levels_inside_a_skills_container() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/top",
            Some("name: top\ndescription: Flat skill"),
        );
        write_skill(
            repo.path(),
            "skills/eng/backend/api",
            Some("name: api\ndescription: Deep skill"),
        );
        commit_all(repo.path(), "deep nesting");

        assert_eq!(
            paths(&scan_skills(repo.path())),
            vec!["skills/eng/backend/api", "skills/top"]
        );
    }

    #[test]
    fn discovers_skills_in_agent_project_dirs_added_in_skills_1_7() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/top",
            Some("name: top\ndescription: Flat skill"),
        );
        write_skill(
            repo.path(),
            ".factory/skills/droid",
            Some("name: droid\ndescription: Factory skill"),
        );
        write_skill(
            repo.path(),
            ".posit/assistant/skills/helper",
            Some("name: helper\ndescription: Posit skill"),
        );
        commit_all(repo.path(), "agent dirs");

        assert_eq!(
            paths(&scan_skills(repo.path())),
            vec![
                ".factory/skills/droid",
                ".posit/assistant/skills/helper",
                "skills/top"
            ]
        );
    }

    #[test]
    fn skips_malformed_folders_without_failing() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/good",
            Some("name: good\ndescription: Valid"),
        );
        write_skill(repo.path(), "skills/no-desc", Some("name: broken"));
        write_skill(repo.path(), "skills/no-frontmatter", None);
        fs::create_dir_all(repo.path().join("skills/empty")).unwrap();
        commit_all(repo.path(), "mixed");

        assert_eq!(ids(&scan_skills(repo.path())), vec!["good"]);
    }

    #[test]
    fn hides_internal_skills_by_default() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/public",
            Some("name: public\ndescription: Visible"),
        );
        write_skill(
            repo.path(),
            "skills/internal",
            Some("name: internal\ndescription: Hidden\nmetadata:\n  internal: true"),
        );
        commit_all(repo.path(), "internal mix");

        assert_eq!(ids(&scan_skills(repo.path())), vec!["public"]);
    }

    #[test]
    fn dedupes_duplicate_names_first_discovered_wins() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/first",
            Some("name: dup\ndescription: First path"),
        );
        write_skill(
            repo.path(),
            "skills/second",
            Some("name: dup\ndescription: Second path"),
        );
        commit_all(repo.path(), "dupes");

        let found = scan_skills(repo.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].description, "First path");
    }

    #[test]
    fn discovers_skills_declared_in_plugin_json() {
        let repo = make_repo();
        fs::create_dir_all(repo.path().join(".claude-plugin")).unwrap();
        fs::write(
            repo.path().join(".claude-plugin/plugin.json"),
            r#"{"name":"solo-plugin","skills":["./skills/review"]}"#,
        )
        .unwrap();
        write_skill(
            repo.path(),
            "skills/review",
            Some("name: solo-review\ndescription: From plugin.json"),
        );
        commit_all(repo.path(), "plugin json");

        let found = scan_skills(repo.path());
        assert_eq!(ids(&found), vec!["solo-review"]);
        assert_eq!(found[0].plugin_name.as_deref(), Some("solo-plugin"));
    }

    #[test]
    fn uses_the_frontmatter_name_when_it_differs_from_the_directory() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/my-folder",
            Some("name: install-key\ndescription: Mismatch"),
        );
        commit_all(repo.path(), "mismatch");

        let found = scan_skills(repo.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "install-key");
        assert_eq!(found[0].skill_path, "skills/my-folder");
    }

    #[test]
    fn discovers_skills_declared_in_marketplace_json() {
        let repo = make_repo();
        fs::create_dir_all(repo.path().join(".claude-plugin")).unwrap();
        fs::write(
            repo.path().join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[{"source":"./plugins/demo","name":"demo-plugin","skills":["./skills/review"]}]}"#,
        )
        .unwrap();
        write_skill(
            repo.path(),
            "plugins/demo/skills/review",
            Some("name: plugin-review\ndescription: From manifest"),
        );
        commit_all(repo.path(), "plugin manifest");

        let found = scan_skills(repo.path());
        assert_eq!(ids(&found), vec!["plugin-review"]);
        assert_eq!(found[0].plugin_name.as_deref(), Some("demo-plugin"));
    }

    #[test]
    fn records_per_skill_git_provenance_at_the_skill_path() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/alpha",
            Some("name: alpha\ndescription: First"),
        );
        write_skill(
            repo.path(),
            "skills/beta",
            Some("name: beta\ndescription: Second"),
        );
        commit_all(repo.path(), "both");
        let first = run_git(repo.path(), &["rev-parse", "HEAD"]);
        write_skill(
            repo.path(),
            "skills/alpha",
            Some("name: alpha\ndescription: First updated"),
        );
        commit_all(repo.path(), "update alpha");
        let second = run_git(repo.path(), &["rev-parse", "HEAD"]);

        let found = scan_skills(repo.path());
        let alpha = found.iter().find(|s| s.id == "alpha").unwrap();
        let beta = found.iter().find(|s| s.id == "beta").unwrap();
        assert_eq!(alpha.provenance_sha, second);
        assert_eq!(beta.provenance_sha, first);
        assert_eq!(alpha.content_hash.len(), 40);
        assert_ne!(alpha.content_hash, beta.content_hash);
        assert_eq!(
            alpha.content_hash,
            run_git(repo.path(), &["rev-parse", "HEAD:skills/alpha"])
        );
        assert_eq!(
            beta.content_hash,
            run_git(repo.path(), &["rev-parse", "HEAD:skills/beta"])
        );
        assert!(alpha.updated_at.contains('T'));
    }

    #[test]
    fn records_nested_skill_provenance_at_the_nested_path() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/engineering/code-review",
            Some("name: code-review\ndescription: Review"),
        );
        commit_all(repo.path(), "nested");
        let sha = run_git(repo.path(), &["rev-parse", "HEAD"]);

        let found = scan_skills(repo.path());
        assert_eq!(found[0].provenance_sha, sha);
        assert_eq!(
            found[0].content_hash,
            run_git(
                repo.path(),
                &["rev-parse", "HEAD:skills/engineering/code-review"]
            )
        );
    }

    #[test]
    fn ignores_skill_md_outside_skill_container_paths() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/kept",
            Some("name: kept\ndescription: In skills"),
        );
        write_skill(
            repo.path(),
            "examples/foo",
            Some("name: example\ndescription: Outside"),
        );
        commit_all(repo.path(), "with example");

        assert_eq!(ids(&scan_skills(repo.path())), vec!["kept"]);
    }

    #[test]
    fn locale_compare_orders_case_insensitively() {
        let mut values = vec!["beta", "Alpha", "alpha", "Zed"];
        values.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(values, vec!["alpha", "Alpha", "beta", "Zed"]);
    }
}
