use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::types::{
    SkillFileContent, SkillFileEntry, SkillFileKind, SkillFileList, SkillFileReadRequest,
    SkillFileRequest, SkillFileUnavailable,
};

use super::scan::locale_compare;

/// Reads of larger files are cut off at this many bytes.
pub const SKILL_FILE_READ_CAP_BYTES: u64 = 512 * 1024;

const TEXT_EXTENSIONS: &[&str] = &[
    ".md",
    ".markdown",
    ".mdx",
    ".txt",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".csv",
    ".tsv",
    ".ini",
    ".cfg",
    ".conf",
    ".env",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".ps1",
    ".py",
    ".rb",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".mts",
    ".cts",
    ".jsx",
    ".tsx",
    ".css",
    ".scss",
    ".html",
    ".htm",
    ".sql",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".gitignore",
    ".gitattributes",
    ".dockerignore",
    ".editorconfig",
    ".lock",
];

const TEXT_FILENAMES: &[&str] = &["Dockerfile", "Makefile", "LICENSE", "NOTICE", "CHANGELOG"];

/// What the file readers need: the cache database and where each registry's
/// mirror lives.
pub struct SkillFilesDeps<'a> {
    pub conn: &'a Connection,
    pub mirror_path_for: &'a dyn Fn(&str) -> PathBuf,
}

/// Node-compatible `path.extname`: a leading dot alone is not an extension.
fn extname(name: &str) -> &str {
    match name.rfind('.') {
        Some(index) if index > 0 => &name[index..],
        _ => "",
    }
}

fn is_text_filename(name: &str) -> bool {
    if TEXT_FILENAMES.contains(&name) {
        return true;
    }
    let extension = extname(name).to_lowercase();
    !extension.is_empty() && TEXT_EXTENSIONS.contains(&extension.as_str())
}

fn basename_of(posix_path: &str) -> &str {
    posix_path.rsplit('/').next().unwrap_or(posix_path)
}

fn is_not_found(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}

fn is_confined(real: &Path, root: &Path) -> bool {
    real.starts_with(root)
}

/// Resolve a skill-relative POSIX path to an absolute path confined to the skill
/// directory. Returns `None` when the path escapes (`..`, absolute or symlink).
fn resolve_confined(skill_dir: &Path, relative_posix: &str) -> std::io::Result<Option<PathBuf>> {
    if relative_posix.is_empty()
        || relative_posix.starts_with('/')
        || relative_posix.split('/').any(|part| part == "..")
    {
        return Ok(None);
    }
    let root = fs::canonicalize(skill_dir)?;
    let absolute = relative_posix
        .split('/')
        .fold(root.clone(), |path, part| path.join(part));
    match fs::canonicalize(&absolute) {
        Ok(real) => Ok(if is_confined(&real, &root) {
            Some(real)
        } else {
            None
        }),
        Err(_) => Ok(Some(absolute)),
    }
}

fn walk(
    dir: &Path,
    prefix: &str,
    root: &Path,
    out: &mut Vec<SkillFileEntry>,
) -> std::io::Result<()> {
    let mut entries: Vec<(String, fs::FileType)> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            Some((entry.file_name().to_string_lossy().to_string(), file_type))
        })
        .collect();
    entries.sort_by(|a, b| locale_compare(&a.0, &b.0));

    for (name, file_type) in entries {
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let absolute = dir.join(&name);
        if file_type.is_dir() {
            walk(&absolute, &relative, root, out)?;
        } else if file_type.is_file() {
            out.push(SkillFileEntry {
                path: relative,
                size_bytes: fs::metadata(&absolute)?.len(),
                viewable: is_text_filename(&name),
            });
        } else if file_type.is_symlink() {
            let Ok(real) = fs::canonicalize(&absolute) else {
                continue;
            };
            if !is_confined(&real, root) {
                continue;
            }
            let metadata = fs::metadata(&absolute)?;
            if metadata.is_file() {
                out.push(SkillFileEntry {
                    path: relative,
                    size_bytes: metadata.len(),
                    viewable: is_text_filename(&name),
                });
            }
        }
    }
    Ok(())
}

fn skill_dir_for(
    deps: &SkillFilesDeps,
    registry_id: &str,
    folder_name: &str,
) -> AppResult<PathBuf> {
    let registry: Option<String> = deps
        .conn
        .query_row(
            "SELECT id FROM registry WHERE id = ?1",
            [registry_id],
            |row| row.get(0),
        )
        .optional()?;
    if registry.is_none() {
        return Err(AppError::not_found(format!(
            "Registry \"{registry_id}\" is not configured"
        )));
    }
    let skill: Option<Option<String>> = deps
        .conn
        .query_row(
            "SELECT skill_path FROM skill WHERE registry_id = ?1 AND folder_name = ?2 AND soft_deleted = 0",
            [registry_id, folder_name],
            |row| row.get(0),
        )
        .optional()?;
    let Some(skill_path) = skill else {
        return Err(AppError::not_found(format!(
            "Skill \"{folder_name}\" is not in the catalogue"
        )));
    };
    let mirror_root = (deps.mirror_path_for)(registry_id);
    Ok(match skill_path.filter(|path| !path.is_empty()) {
        Some(path) => path
            .split('/')
            .fold(mirror_root, |dir, part| dir.join(part)),
        None => mirror_root.join("skills").join(folder_name),
    })
}

fn missing(path: &str) -> SkillFileContent {
    SkillFileContent {
        path: path.to_string(),
        size_bytes: 0,
        kind: SkillFileKind::Missing,
        content: None,
        truncated: None,
    }
}

/// List the files of a skill as skill-relative POSIX paths, depth first.
pub fn list_skill_files(
    deps: &SkillFilesDeps,
    request: &SkillFileRequest,
) -> AppResult<SkillFileList> {
    let skill_dir = skill_dir_for(deps, &request.registry_id, &request.folder_name)?;
    let mut files = Vec::new();
    let unavailable = SkillFileList {
        files: Vec::new(),
        unavailable: Some(SkillFileUnavailable::Missing),
    };
    match fs::metadata(&skill_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Ok(unavailable),
        Err(error) if is_not_found(&error) => return Ok(unavailable),
        Err(error) => return Err(error.into()),
    }
    let root = match fs::canonicalize(&skill_dir) {
        Ok(root) => root,
        Err(error) if is_not_found(&error) => return Ok(unavailable),
        Err(error) => return Err(error.into()),
    };
    match walk(&skill_dir, "", &root, &mut files) {
        Ok(()) => Ok(SkillFileList {
            files,
            unavailable: None,
        }),
        Err(error) if is_not_found(&error) => Ok(unavailable),
        Err(error) => Err(error.into()),
    }
}

fn read_capped(path: &Path, size: u64) -> std::io::Result<Vec<u8>> {
    let length = size.min(SKILL_FILE_READ_CAP_BYTES);
    let mut buffer = Vec::with_capacity(length as usize);
    fs::File::open(path)?
        .take(length)
        .read_to_end(&mut buffer)?;
    Ok(buffer)
}

/// Read one file of a skill, confined to the skill directory. Binary or
/// non-allowlisted files report their size without content; large files are
/// truncated to [`SKILL_FILE_READ_CAP_BYTES`].
pub fn read_skill_file(
    deps: &SkillFilesDeps,
    request: &SkillFileReadRequest,
) -> AppResult<SkillFileContent> {
    let skill_dir = skill_dir_for(deps, &request.registry_id, &request.folder_name)?;
    let path = request.path.as_str();

    match fs::metadata(&skill_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Ok(missing(path)),
        Err(error) if is_not_found(&error) => return Ok(missing(path)),
        Err(error) => return Err(error.into()),
    }

    let absolute = match resolve_confined(&skill_dir, path) {
        Ok(Some(absolute)) => absolute,
        Ok(None) => {
            return Err(AppError::invalid(format!(
                "Path \"{path}\" resolves outside the skill directory"
            )))
        }
        Err(error) if is_not_found(&error) => return Ok(missing(path)),
        Err(error) => return Err(error.into()),
    };

    let file_metadata = match fs::metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if is_not_found(&error) => return Ok(missing(path)),
        Err(error) => return Err(error.into()),
    };
    if !file_metadata.is_file() {
        return Ok(missing(path));
    }

    let size = file_metadata.len();
    let buffer = match read_capped(&absolute, size) {
        Ok(buffer) => buffer,
        Err(error) if is_not_found(&error) => return Ok(missing(path)),
        Err(error) => return Err(error.into()),
    };

    if !is_text_filename(basename_of(path)) || buffer.contains(&0) {
        return Ok(SkillFileContent {
            path: path.to_string(),
            size_bytes: size,
            kind: SkillFileKind::Binary,
            content: None,
            truncated: None,
        });
    }
    Ok(SkillFileContent {
        path: path.to_string(),
        size_bytes: size,
        kind: SkillFileKind::Text,
        content: Some(String::from_utf8_lossy(&buffer).into_owned()),
        truncated: (size > SKILL_FILE_READ_CAP_BYTES).then_some(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;
    use crate::registries::{insert_registry, InsertRegistryInput};
    use crate::types::RegistrySource;
    use std::os::unix::fs::symlink;

    struct Fixture {
        _dir: tempfile::TempDir,
        conn: Connection,
        registry_id: String,
        mirror_root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let conn = open_database(&dir.path().join("cache.sqlite")).unwrap();
            let registry = insert_registry(
                &conn,
                &InsertRegistryInput {
                    source: RegistrySource::Git,
                    url: "https://github.com/example/skills".into(),
                    branch: "main".into(),
                    enabled: true,
                    auto_update: false,
                    github_owner: Some("example".into()),
                    github_repo: Some("skills".into()),
                    canonical_key: "github.com/example/skills".into(),
                },
            )
            .unwrap();
            let mirror_root = dir.path().join("mirrors").join(&registry.id);
            fs::create_dir_all(&mirror_root).unwrap();
            Fixture {
                _dir: dir,
                conn,
                registry_id: registry.id,
                mirror_root,
            }
        }

        fn deps<'a>(&'a self, mirror: &'a dyn Fn(&str) -> PathBuf) -> SkillFilesDeps<'a> {
            SkillFilesDeps {
                conn: &self.conn,
                mirror_path_for: mirror,
            }
        }

        fn add_skill(&self, folder: &str, skill_path: &str) {
            self.conn
                .execute(
                    "INSERT INTO skill (registry_id, folder_name, name, description, skill_path)
                     VALUES (?1, ?2, ?2, ?3, ?4)",
                    rusqlite::params![
                        self.registry_id,
                        folder,
                        format!("{folder} description"),
                        skill_path
                    ],
                )
                .unwrap();
        }

        fn write_skill_files(&self, skill_path: &str) -> PathBuf {
            let dir = skill_path
                .split('/')
                .fold(self.mirror_root.clone(), |dir, part| dir.join(part));
            fs::create_dir_all(dir.join("scripts")).unwrap();
            fs::create_dir_all(dir.join("references/deep")).unwrap();
            fs::write(dir.join("SKILL.md"), "# Skill\n").unwrap();
            fs::write(dir.join("scripts/run.sh"), "echo hi\n").unwrap();
            fs::write(dir.join("references/deep/notes.txt"), "notes\n").unwrap();
            fs::write(dir.join("logo.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();
            dir
        }

        fn list(&self, folder: &str) -> AppResult<SkillFileList> {
            let root = self.mirror_root.clone();
            let mirror = move |_: &str| root.clone();
            list_skill_files(
                &self.deps(&mirror),
                &SkillFileRequest {
                    registry_id: self.registry_id.clone(),
                    folder_name: folder.into(),
                },
            )
        }

        fn read(&self, folder: &str, path: &str) -> AppResult<SkillFileContent> {
            let root = self.mirror_root.clone();
            let mirror = move |_: &str| root.clone();
            read_skill_file(
                &self.deps(&mirror),
                &SkillFileReadRequest {
                    registry_id: self.registry_id.clone(),
                    folder_name: folder.into(),
                    path: path.into(),
                },
            )
        }
    }

    #[test]
    fn lists_nested_files_as_relative_posix_paths_with_sizes_and_viewable_flags() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        fx.write_skill_files("skills/alpha");

        let list = fx.list("alpha").unwrap();
        assert_eq!(list.unavailable, None);
        let mut paths: Vec<_> = list.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "SKILL.md",
                "logo.png",
                "references/deep/notes.txt",
                "scripts/run.sh"
            ]
        );
        let by_path = |path: &str| list.files.iter().find(|f| f.path == path).unwrap();
        assert!(by_path("SKILL.md").viewable);
        assert_eq!(by_path("SKILL.md").size_bytes, 8);
        assert!(by_path("scripts/run.sh").viewable);
        assert!(!by_path("logo.png").viewable);
        assert_eq!(by_path("logo.png").size_bytes, 4);
    }

    #[test]
    fn resolves_nested_skill_paths_from_the_persisted_skill_path() {
        let fx = Fixture::new();
        fx.add_skill("code-review", "skills/engineering/code-review");
        fx.write_skill_files("skills/engineering/code-review");
        let list = fx.list("code-review").unwrap();
        assert!(list.files.iter().any(|f| f.path == "SKILL.md"));
    }

    #[test]
    fn returns_utf8_content_with_kind_text() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        fx.write_skill_files("skills/alpha");
        let content = fx.read("alpha", "scripts/run.sh").unwrap();
        assert_eq!(content.kind, SkillFileKind::Text);
        assert_eq!(content.content.as_deref(), Some("echo hi\n"));
        assert_eq!(content.size_bytes, 8);
        assert_eq!(content.truncated, None);
    }

    #[test]
    fn returns_kind_binary_for_a_non_allowlisted_extension() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        fx.write_skill_files("skills/alpha");
        let content = fx.read("alpha", "logo.png").unwrap();
        assert_eq!(content.kind, SkillFileKind::Binary);
        assert_eq!(content.size_bytes, 4);
        assert_eq!(content.content, None);
    }

    #[test]
    fn returns_kind_binary_for_an_allowlisted_file_containing_a_null_byte() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        let dir = fx.write_skill_files("skills/alpha");
        fs::write(dir.join("data.txt"), [0x61, 0x00, 0x62]).unwrap();
        assert_eq!(
            fx.read("alpha", "data.txt").unwrap().kind,
            SkillFileKind::Binary
        );
    }

    #[test]
    fn truncates_content_beyond_the_read_cap() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        let dir = fx.write_skill_files("skills/alpha");
        let big = "x".repeat(SKILL_FILE_READ_CAP_BYTES as usize + 100);
        fs::write(dir.join("big.md"), &big).unwrap();

        let content = fx.read("alpha", "big.md").unwrap();
        assert_eq!(content.kind, SkillFileKind::Text);
        assert_eq!(content.truncated, Some(true));
        assert_eq!(content.size_bytes, SKILL_FILE_READ_CAP_BYTES + 100);
        assert_eq!(
            content.content.unwrap().len(),
            SKILL_FILE_READ_CAP_BYTES as usize
        );
    }

    #[test]
    fn rejects_a_request_path_resolving_outside_the_skill_directory() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        fx.write_skill_files("skills/alpha");
        for path in ["../../secret.txt", "/etc/passwd"] {
            let error = fx.read("alpha", path).unwrap_err();
            assert!(error.message().contains("outside"), "{path}");
        }
    }

    #[test]
    fn rejects_a_symlink_escape_outside_the_skill_directory() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        let dir = fx.write_skill_files("skills/alpha");
        let outside = fx.mirror_root.join("outside.txt");
        fs::write(&outside, "secret\n").unwrap();
        symlink(&outside, dir.join("leak.txt")).unwrap();
        let error = fx.read("alpha", "leak.txt").unwrap_err();
        assert!(error.message().contains("outside"));
    }

    #[test]
    fn lists_a_symlinked_file_whose_target_resolves_inside_the_skill() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        let dir = fx.write_skill_files("skills/alpha");
        symlink(dir.join("SKILL.md"), dir.join("alias.md")).unwrap();
        let list = fx.list("alpha").unwrap();
        let alias = list.files.iter().find(|f| f.path == "alias.md").unwrap();
        assert!(alias.viewable);
        assert_eq!(alias.size_bytes, 8);
    }

    #[test]
    fn omits_a_symlink_whose_target_escapes_the_skill_directory() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        let dir = fx.write_skill_files("skills/alpha");
        let outside = fx.mirror_root.join("outside.txt");
        fs::write(&outside, "secret\n").unwrap();
        symlink(&outside, dir.join("leak.txt")).unwrap();
        let list = fx.list("alpha").unwrap();
        assert!(!list.files.iter().any(|f| f.path == "leak.txt"));
    }

    #[test]
    fn a_missing_skill_directory_is_unavailable_for_listing_and_missing_for_reads() {
        let fx = Fixture::new();
        fx.add_skill("ghost", "skills/ghost");
        assert_eq!(
            fx.list("ghost").unwrap(),
            SkillFileList {
                files: Vec::new(),
                unavailable: Some(SkillFileUnavailable::Missing)
            }
        );
        assert_eq!(
            fx.read("ghost", "SKILL.md").unwrap().kind,
            SkillFileKind::Missing
        );
    }

    #[test]
    fn a_vanished_file_resolves_to_kind_missing_rather_than_failing() {
        let fx = Fixture::new();
        fx.add_skill("alpha", "skills/alpha");
        fx.write_skill_files("skills/alpha");
        assert_eq!(fx.read("alpha", "gone.md").unwrap(), missing("gone.md"));
    }

    #[test]
    fn unknown_registry_and_skill_are_typed_errors() {
        let fx = Fixture::new();
        let root = fx.mirror_root.clone();
        let mirror = move |_: &str| root.clone();
        let error = list_skill_files(
            &fx.deps(&mirror),
            &SkillFileRequest {
                registry_id: "nope".into(),
                folder_name: "alpha".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.message(), "Registry \"nope\" is not configured");
        assert!(matches!(error, AppError::NotFound { .. }));

        let error = fx.list("nope").unwrap_err();
        assert_eq!(error.message(), "Skill \"nope\" is not in the catalogue");
    }

    #[test]
    fn extension_matching_follows_node_extname() {
        assert!(is_text_filename("a.MD"));
        assert!(is_text_filename("Dockerfile"));
        assert!(!is_text_filename(".gitignore"));
        assert!(!is_text_filename("noext"));
        assert!(!is_text_filename("logo.png"));
    }
}
