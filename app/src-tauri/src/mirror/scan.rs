use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::discovery::skills::{discover_skills, DiscoverSkillsOptions};
use super::git_exec::{git, git_output};

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

struct HistoryCommit {
    date: String,
    parents: Vec<String>,
    changed_paths: HashMap<String, HashSet<String>>,
}

fn path_provenance(log: &str, paths: &[String]) -> Option<HashMap<String, (String, String)>> {
    let mut remaining = log;
    let mut commits = HashMap::<String, HistoryCommit>::new();
    let mut head = None;
    while !remaining.is_empty() {
        let (header, tail) = remaining.split_once('\n')?;
        let mut fields = header.strip_prefix("commit ")?.split_whitespace();
        let sha = fields.next()?.to_string();
        let from = fields
            .nth(1)
            .map(|parent| parent.trim_end_matches(')').to_string());
        head.get_or_insert_with(|| sha.clone());
        let (size, tail) = tail.split_once('\n')?;
        let size: usize = size.strip_prefix("log size ")?.parse().ok()?;
        let body = tail.get(..size)?;
        remaining = tail.get(size..)?;
        let parents: Vec<String> = body
            .lines()
            .filter_map(|line| line.strip_prefix("parent ").map(str::to_string))
            .collect();
        let committer = body
            .lines()
            .find_map(|line| line.strip_prefix("committer "))?;
        let mut date_fields = committer.rsplitn(3, ' ');
        let zone = date_fields.next()?;
        let stamp = date_fields.next()?;
        let date = chrono::DateTime::parse_from_str(&format!("{stamp} {zone}"), "%s %z")
            .ok()?
            .format("%Y-%m-%dT%H:%M:%S%:z")
            .to_string();
        let parent = from
            .or_else(|| parents.first().cloned())
            .unwrap_or_default();
        let commit = commits.entry(sha).or_insert_with(|| HistoryCommit {
            date,
            parents,
            changed_paths: HashMap::new(),
        });
        let changed = commit.changed_paths.entry(parent).or_default();
        if let Some(files) = remaining.strip_prefix('\n') {
            remaining = files;
            while !remaining.is_empty() {
                let (file, tail) = remaining.split_once('\0')?;
                remaining = tail;
                if file.is_empty() {
                    break;
                }
                for path in paths {
                    if path.is_empty()
                        || file
                            .strip_prefix(path)
                            .is_some_and(|suffix| suffix.starts_with('/'))
                    {
                        changed.insert(path.clone());
                    }
                }
            }
        } else {
            remaining = remaining.strip_prefix('\0').unwrap_or(remaining);
        }
    }
    let mut result = HashMap::new();
    for path in paths {
        let mut sha = head.as_ref()?;
        while let Some(commit) = commits.get(sha) {
            let unchanged_parent = commit.parents.iter().find(|parent| {
                !commit
                    .changed_paths
                    .get(*parent)
                    .is_some_and(|changed| changed.contains(path))
            });
            if let Some(parent) = unchanged_parent {
                sha = parent;
            } else {
                if commit
                    .changed_paths
                    .values()
                    .any(|changed| changed.contains(path))
                {
                    result.insert(path.clone(), (sha.clone(), commit.date.clone()));
                }
                break;
            }
        }
    }
    Some(result)
}

/// Discover skills via the ported vercel-labs/skills rules, then attach git
/// provenance per discovered path. Malformed or internal skills are skipped, as
/// are skills whose git metadata cannot be read.
pub fn scan_skills(mirror_path: &Path) -> Vec<ScannedSkill> {
    let discovered =
        discover_skills(mirror_path, None, DiscoverSkillsOptions::default()).unwrap_or_default();
    if discovered.is_empty() {
        return Vec::new();
    }
    let paths: Vec<_> = discovered
        .iter()
        .map(|skill| to_posix_skill_path(mirror_path, &skill.path))
        .collect();
    let metadata = (|| {
        let listing = git(mirror_path, &["ls-tree", "-r", "-d", "-z", "HEAD"])?;
        let mut hashes: HashMap<String, String> = listing
            .split('\0')
            .filter_map(|entry| {
                let (metadata, path) = entry.split_once('\t')?;
                Some((
                    path.to_string(),
                    metadata.split_whitespace().nth(2)?.to_string(),
                ))
            })
            .collect();
        hashes.insert(
            String::new(),
            git(mirror_path, &["rev-parse", "HEAD^{tree}"])?,
        );
        let mut args = vec![
            "log",
            "--full-history",
            "--sparse",
            "-m",
            "--no-renames",
            "--name-only",
            "-z",
            "--pretty=raw",
            "--log-size",
            "--",
        ];
        let pathspecs: Vec<_> = paths
            .iter()
            .map(|path| format!(":(literal){}", if path.is_empty() { "." } else { path }))
            .collect();
        args.extend(pathspecs.iter().map(String::as_str));
        let log = git_output(mirror_path, &args)?;
        let provenance = path_provenance(&log, &paths)
            .ok_or_else(|| super::git_exec::GitError::new("Invalid git history output"))?;
        Ok::<_, super::git_exec::GitError>((hashes, provenance))
    })();
    let (hashes, provenance) = match metadata {
        Ok(metadata) => metadata,
        Err(error) => {
            eprintln!("[scan] git metadata failed: {error}");
            return Vec::new();
        }
    };
    let mut results = Vec::new();
    for (skill, skill_path) in discovered.into_iter().zip(paths) {
        let (Some(content_hash), Some((provenance_sha, updated_at))) =
            (hashes.get(&skill_path), provenance.get(&skill_path))
        else {
            eprintln!(
                "[scan] skip {} ({skill_path}): git metadata unavailable",
                skill.name
            );
            continue;
        };
        results.push(ScannedSkill {
            id: skill.name.clone(),
            skill_path,
            name: skill.name,
            description: skill.description,
            provenance_sha: provenance_sha.clone(),
            content_hash: content_hash.clone(),
            updated_at: updated_at.clone(),
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
    fn conflict_resolution_is_the_skills_last_commit() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/alpha",
            Some("name: alpha\ndescription: Base"),
        );
        commit_all(repo.path(), "base");
        run_git(repo.path(), &["checkout", "-b", "side"]);
        write_skill(
            repo.path(),
            "skills/alpha",
            Some("name: alpha\ndescription: Side"),
        );
        commit_all(repo.path(), "side");
        run_git(repo.path(), &["checkout", "main"]);
        write_skill(
            repo.path(),
            "skills/alpha",
            Some("name: alpha\ndescription: Main"),
        );
        commit_all(repo.path(), "main");
        let merge = std::process::Command::new("git")
            .args(["merge", "side"])
            .current_dir(repo.path())
            .output()
            .unwrap();
        assert!(!merge.status.success());
        write_skill(
            repo.path(),
            "skills/alpha",
            Some("name: alpha\ndescription: Resolved"),
        );
        commit_all(repo.path(), "resolve");
        let found = scan_skills(repo.path());
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].provenance_sha,
            run_git(repo.path(), &["rev-parse", "HEAD"])
        );
        assert_eq!(
            found[0].updated_at,
            run_git(
                repo.path(),
                &["log", "-1", "--format=%cI", "--", "skills/alpha"]
            )
        );
    }

    #[test]
    fn merge_provenance_matches_each_skill_directory_history() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/alpha",
            Some("name: alpha\ndescription: Skill"),
        );
        write_skill(
            repo.path(),
            "skills/beta",
            Some("name: beta\ndescription: Skill"),
        );
        commit_all(repo.path(), "base");
        run_git(repo.path(), &["checkout", "-b", "side"]);
        fs::write(repo.path().join("skills/alpha/side"), "side").unwrap();
        fs::write(repo.path().join("skills/beta/side"), "side").unwrap();
        commit_all(repo.path(), "side");
        run_git(repo.path(), &["checkout", "main"]);
        fs::write(repo.path().join("skills/alpha/main"), "main").unwrap();
        commit_all(repo.path(), "main");
        run_git(repo.path(), &["merge", "side", "-m", "merge"]);
        let found = scan_skills(repo.path());
        assert_eq!(found.len(), 2);
        for skill in found {
            assert_eq!(
                skill.provenance_sha,
                run_git(
                    repo.path(),
                    &["log", "-1", "--format=%H", "--", &skill.skill_path]
                )
            );
            assert_eq!(
                skill.updated_at,
                run_git(
                    repo.path(),
                    &["log", "-1", "--format=%cI", "--", &skill.skill_path]
                )
            );
        }
    }

    #[test]
    fn skips_an_untracked_skill_without_losing_committed_skills() {
        let repo = make_repo();
        fs::write(repo.path().join("README.md"), "registry").unwrap();
        commit_all(repo.path(), "before skills");
        write_skill(
            repo.path(),
            "skills/tracked",
            Some("name: tracked\ndescription: Saved"),
        );
        commit_all(repo.path(), "tracked");
        write_skill(
            repo.path(),
            "skills/untracked",
            Some("name: untracked\ndescription: No metadata"),
        );
        assert_eq!(ids(&scan_skills(repo.path())), vec!["tracked"]);
    }

    #[test]
    fn provenance_matches_path_history_after_a_move_and_move_back() {
        let repo = make_repo();
        write_skill(
            repo.path(),
            "skills/first/alpha",
            Some("name: alpha\ndescription: Moved"),
        );
        write_skill(
            repo.path(),
            "skills/beta",
            Some("name: beta\ndescription: Unchanged"),
        );
        commit_all(repo.path(), "seed");
        fs::create_dir_all(repo.path().join("skills/second")).unwrap();
        run_git(
            repo.path(),
            &["mv", "skills/first/alpha", "skills/second/alpha"],
        );
        commit_all(repo.path(), "move");
        fs::create_dir_all(repo.path().join("skills/first")).unwrap();
        run_git(
            repo.path(),
            &["mv", "skills/second/alpha", "skills/first/alpha"],
        );
        commit_all(repo.path(), "move back");
        for skill in scan_skills(repo.path()) {
            assert_eq!(
                skill.provenance_sha,
                run_git(
                    repo.path(),
                    &["log", "-1", "--format=%H", "--", &skill.skill_path]
                )
            );
            assert_eq!(
                skill.updated_at,
                run_git(
                    repo.path(),
                    &["log", "-1", "--format=%cI", "--", &skill.skill_path]
                )
            );
            assert_eq!(
                skill.content_hash,
                run_git(
                    repo.path(),
                    &["rev-parse", &format!("HEAD:{}", skill.skill_path)]
                )
            );
        }
    }

    #[test]
    fn records_root_skill_tree_and_provenance() {
        let repo = make_repo();
        write_skill(repo.path(), "", Some("name: root\ndescription: Root skill"));
        commit_all(repo.path(), "root");
        let found = scan_skills(repo.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].skill_path, "");
        assert_eq!(
            found[0].content_hash,
            run_git(repo.path(), &["rev-parse", "HEAD:"])
        );
        assert_eq!(
            found[0].provenance_sha,
            run_git(repo.path(), &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn git_process_count_does_not_grow_with_skills_or_history() {
        fn count(skills: usize, commits: usize) -> usize {
            let repo = make_repo();
            for index in 0..skills {
                write_skill(
                    repo.path(),
                    &format!("skills/skill-{index}"),
                    Some(&format!("name: skill-{index}\ndescription: Skill")),
                );
            }
            commit_all(repo.path(), "skills");
            for index in 1..commits {
                fs::write(repo.path().join("skills/skill-0/data"), index.to_string()).unwrap();
                commit_all(repo.path(), "update");
            }
            let (found, calls) =
                crate::mirror::git_exec::count_git_invocations(|| scan_skills(repo.path()));
            assert_eq!(found.len(), skills);
            assert!(calls <= 3, "scan used {calls} git processes");
            calls
        }
        assert_eq!(count(2, 1), count(20, 50));
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
