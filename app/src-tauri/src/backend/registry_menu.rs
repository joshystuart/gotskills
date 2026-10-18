//! The sidebar registry menu: items for a registry and how a pick is handled.

use crate::types::{RegistryMenuAction, RegistryRecord};

/// Every action the menu offers, including those the backend handles itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuAction {
    Renderer(RegistryMenuAction),
    OpenGithub,
    CopyUrl,
}

const ID_PREFIX: &str = "registry-menu:";

impl MenuAction {
    /// The wire name, which is also the menu item id suffix.
    pub fn name(self) -> &'static str {
        match self {
            MenuAction::Renderer(RegistryMenuAction::Rename) => "rename",
            MenuAction::Renderer(RegistryMenuAction::Sync) => "sync",
            MenuAction::Renderer(RegistryMenuAction::ToggleEnabled) => "toggle-enabled",
            MenuAction::Renderer(RegistryMenuAction::ToggleAutoUpdate) => "toggle-auto-update",
            MenuAction::Renderer(RegistryMenuAction::ShowSettings) => "show-settings",
            MenuAction::Renderer(RegistryMenuAction::Remove) => "remove",
            MenuAction::OpenGithub => "open-github",
            MenuAction::CopyUrl => "copy-url",
        }
    }

    /// The id of the native menu item for this action.
    pub fn item_id(self) -> String {
        format!("{ID_PREFIX}{}", self.name())
    }

    /// The action behind a native menu item id, if it is one of ours.
    pub fn from_item_id(id: &str) -> Option<MenuAction> {
        let name = id.strip_prefix(ID_PREFIX)?;
        ALL_ACTIONS.into_iter().find(|action| action.name() == name)
    }
}

const ALL_ACTIONS: [MenuAction; 8] = [
    MenuAction::Renderer(RegistryMenuAction::Rename),
    MenuAction::Renderer(RegistryMenuAction::Sync),
    MenuAction::Renderer(RegistryMenuAction::ToggleEnabled),
    MenuAction::Renderer(RegistryMenuAction::ToggleAutoUpdate),
    MenuAction::Renderer(RegistryMenuAction::ShowSettings),
    MenuAction::Renderer(RegistryMenuAction::Remove),
    MenuAction::OpenGithub,
    MenuAction::CopyUrl,
];

/// One row of the menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryMenuItem {
    Separator,
    Normal {
        label: &'static str,
        action: MenuAction,
        enabled: bool,
    },
    Checkbox {
        label: &'static str,
        action: MenuAction,
        enabled: bool,
        checked: bool,
    },
}

fn normal(label: &'static str, action: RegistryMenuAction, enabled: bool) -> RegistryMenuItem {
    RegistryMenuItem::Normal {
        label,
        action: MenuAction::Renderer(action),
        enabled,
    }
}

/// Build the menu items from the registry and the busy flag.
pub fn registry_menu_template(registry: &RegistryRecord, busy: bool) -> Vec<RegistryMenuItem> {
    let is_github = registry.github_owner.is_some() && registry.github_repo.is_some();
    let mut items = vec![
        normal("Rename…", RegistryMenuAction::Rename, !busy),
        RegistryMenuItem::Separator,
        normal(
            "Sync Now",
            RegistryMenuAction::Sync,
            !busy && registry.enabled,
        ),
        RegistryMenuItem::Separator,
        RegistryMenuItem::Checkbox {
            label: "Enabled",
            action: MenuAction::Renderer(RegistryMenuAction::ToggleEnabled),
            enabled: !busy,
            checked: registry.enabled,
        },
        RegistryMenuItem::Checkbox {
            label: "Auto Update",
            action: MenuAction::Renderer(RegistryMenuAction::ToggleAutoUpdate),
            enabled: !busy && registry.enabled,
            checked: registry.auto_update,
        },
        RegistryMenuItem::Separator,
    ];
    if is_github {
        items.push(RegistryMenuItem::Normal {
            label: "Open on GitHub",
            action: MenuAction::OpenGithub,
            enabled: true,
        });
    }
    items.push(RegistryMenuItem::Normal {
        label: "Copy URL",
        action: MenuAction::CopyUrl,
        enabled: true,
    });
    items.push(normal(
        "Show in Settings",
        RegistryMenuAction::ShowSettings,
        true,
    ));
    items.push(RegistryMenuItem::Separator);
    items.push(normal("Remove…", RegistryMenuAction::Remove, !busy));
    items
}

/// The GitHub page of a GitHub registry.
pub fn github_url(registry: &RegistryRecord) -> Option<String> {
    match (&registry.github_owner, &registry.github_repo) {
        (Some(owner), Some(repo)) => Some(format!("https://github.com/{owner}/{repo}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RegistrySyncStatus, SyncPhase};

    fn registry(owner: Option<&str>, repo: Option<&str>) -> RegistryRecord {
        RegistryRecord {
            id: "r1".into(),
            url: "https://example.test/r1".into(),
            branch: "main".into(),
            enabled: true,
            auto_update: false,
            github_owner: owner.map(String::from),
            github_repo: repo.map(String::from),
            colour: None,
            name: None,
            sync_status: RegistrySyncStatus {
                registry_id: "r1".into(),
                phase: SyncPhase::Synced,
                last_synced_at: None,
                reason: None,
                revision: None,
                visible_skill_count: None,
                stale: None,
            },
        }
    }

    fn labels(items: &[RegistryMenuItem]) -> Vec<&'static str> {
        items
            .iter()
            .filter_map(|item| match item {
                RegistryMenuItem::Separator => None,
                RegistryMenuItem::Normal { label, .. }
                | RegistryMenuItem::Checkbox { label, .. } => Some(*label),
            })
            .collect()
    }

    fn item<'a>(items: &'a [RegistryMenuItem], wanted: &str) -> &'a RegistryMenuItem {
        items
            .iter()
            .find(|item| labels(std::slice::from_ref(*item)) == [wanted])
            .unwrap()
    }

    #[test]
    fn lists_the_github_item_only_for_github_registries() {
        let github = registry_menu_template(&registry(Some("o"), Some("r")), false);
        assert_eq!(
            labels(&github),
            [
                "Rename…",
                "Sync Now",
                "Enabled",
                "Auto Update",
                "Open on GitHub",
                "Copy URL",
                "Show in Settings",
                "Remove…"
            ]
        );
        let plain = registry_menu_template(&registry(None, None), false);
        assert!(!labels(&plain).contains(&"Open on GitHub"));
    }

    #[test]
    fn busy_disables_the_changing_items_only() {
        let items = registry_menu_template(&registry(Some("o"), Some("r")), true);
        for label in ["Rename…", "Sync Now", "Enabled", "Auto Update", "Remove…"] {
            assert!(
                matches!(
                    item(&items, label),
                    RegistryMenuItem::Normal { enabled: false, .. }
                        | RegistryMenuItem::Checkbox { enabled: false, .. }
                ),
                "{label}"
            );
        }
        for label in ["Open on GitHub", "Copy URL", "Show in Settings"] {
            assert!(matches!(
                item(&items, label),
                RegistryMenuItem::Normal { enabled: true, .. }
            ));
        }
    }

    #[test]
    fn a_disabled_registry_cannot_sync_or_auto_update() {
        let mut disabled = registry(None, None);
        disabled.enabled = false;
        let items = registry_menu_template(&disabled, false);
        assert!(matches!(
            item(&items, "Sync Now"),
            RegistryMenuItem::Normal { enabled: false, .. }
        ));
        assert!(matches!(
            item(&items, "Auto Update"),
            RegistryMenuItem::Checkbox { enabled: false, .. }
        ));
        assert!(matches!(
            item(&items, "Enabled"),
            RegistryMenuItem::Checkbox {
                enabled: true,
                checked: false,
                ..
            }
        ));
    }

    #[test]
    fn checkboxes_reflect_the_registry() {
        let mut auto = registry(None, None);
        auto.auto_update = true;
        let items = registry_menu_template(&auto, false);
        assert!(matches!(
            item(&items, "Auto Update"),
            RegistryMenuItem::Checkbox { checked: true, .. }
        ));
    }

    #[test]
    fn item_ids_round_trip() {
        for action in ALL_ACTIONS {
            assert_eq!(MenuAction::from_item_id(&action.item_id()), Some(action));
        }
        assert_eq!(MenuAction::from_item_id("other:rename"), None);
        assert_eq!(MenuAction::from_item_id("registry-menu:nope"), None);
    }

    #[test]
    fn builds_the_github_url() {
        assert_eq!(
            github_url(&registry(Some("o"), Some("r"))).as_deref(),
            Some("https://github.com/o/r")
        );
        assert_eq!(github_url(&registry(None, None)), None);
    }
}
