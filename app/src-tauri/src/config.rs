/// Registry seeded on first run.
pub struct DefaultRegistry {
    pub url: &'static str,
    pub branch: &'static str,
}

/// The default registry (anthropics/skills on main).
pub const DEFAULT_REGISTRY: DefaultRegistry = DefaultRegistry {
    url: "https://github.com/anthropics/skills",
    branch: "main",
};
