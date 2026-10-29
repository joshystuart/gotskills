//! Git mirror, skill discovery, scanning and catalogue reads (work package B).

pub mod catalogue;
pub mod discovery {
    pub mod agents;
    pub mod constants;
    pub mod frontmatter;
    pub mod local_lock;
    pub mod paths;
    pub mod plugin_manifest;
    pub mod sanitize;
    pub mod skills;
}
pub mod git;
pub mod git_errors;
pub mod git_exec;
pub mod local;
pub mod scan;
pub mod skill_files;
pub mod sync;

#[cfg(test)]
pub(crate) mod test_support;
