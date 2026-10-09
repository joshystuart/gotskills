# Skill Catalogue

This context describes how skill sources contribute to the catalogue presented by the app.

## Language

**Registry**:
A configured Git repository with one selected branch that supplies skills to the app. A GitHub owner/repository can be configured only once; changing its branch changes that registry.
_Avoid_: Repo, source

**Registry Name**:
The name a registry is shown by across the app: a friendly name the user gives it, or, when none is given, `owner/repo` for GitHub and host/path otherwise. It is display only; a registry is identified by its id.
_Avoid_: Registry label, alias, nickname

**Private Registry**:
A registry hosted in a private GitHub repository and accessed over HTTPS using credentials already available to system Git. The app does not own a GitHub sign-in or credential.
_Avoid_: Private repo, authenticated source

**Registry Snapshot**:
The most recently synced set of skills from one registry. It remains part of the catalogue and may still supply installations when a later sync fails, while its revision and stale state are made explicit.
_Avoid_: Cache

**Disabled Registry**:
A registry whose configuration and snapshot are retained but which does not sync or contribute available skills to the catalogue. Skills already installed from it remain visible as installed-only entries.
_Avoid_: Removed registry, paused sync

**Registry Colour**:
The colour that marks a registry and its skills across the app, either chosen by the user or assigned automatically from a palette. A disabled registry is shown grey whatever its colour.
_Avoid_: Registry dot, tag colour

**Auto Update**:
A per-registry setting, off unless the user turns it on, under which every successful sync brings that registry's installed skills up to its latest snapshot. It only updates installed skills; it never installs, repairs or removes them.
_Avoid_: Auto sync, auto install

**App Update**:
A newer released version of the Got Skills app, which the app downloads and installs itself. It is separate from a registry's Auto Update, which updates installed skills.
_Avoid_: Auto update, self update

**Catalogue**:
The combined collection of skills supplied by all configured registries.
_Avoid_: Registry, repository

**Skill**:
A registry-scoped catalogue entry identified by its registry and install key (the `name` from `SKILL.md` frontmatter, matching how the vendored CLI resolves `--skill`). Stored as `folder_name` in the database and exposed as `folderName` over IPC. Skills from different registries may therefore share an install key.
_Avoid_: Installed skill

**Skill Path**:
The POSIX-relative path from a registry mirror root to the skill directory containing `SKILL.md`. Used for git provenance (content-hash, version history) and stored as `skill_path` in the database. May differ from the install key for nested catalog layouts (e.g. `skills/engineering/code-review/` with install key `code-review`).

**Skill Conflict**:
The condition where multiple registries supply skills with the same folder name. All remain visible in the catalogue.
_Avoid_: Duplicate skill

**Agent**:
An AI coding app that reads skills from an install target, such as Claude Code, Cursor or Codex.
_Avoid_: Application, tool

**Install Target**:
A skills folder the app installs into, identified by its path and read by one or more agents. An agent with its own folder is served by its own install target.
_Avoid_: Agent target, agent

**Shared Target**:
The install target `~/.agents/skills`, read by every agent that has no folder of its own (skills.sh calls these "universal" agents). It is labelled by the detected agents it serves.
_Avoid_: Universal folder, canonical folder

**Installed Skill**:
The single skill currently installed under a folder name in one install target, including the registry that supplied it. Different install targets may hold conflicting skills from different registries.
_Avoid_: Skill

**Installation Collision**:
The condition where an install target already contains a skill under the folder name being installed, either from another registry or from outside the app. Installation is blocked until the existing skill is removed.
_Avoid_: Skill conflict

**Orphaned Installation**:
An installed skill whose supplying registry has been removed. It remains installed and can be uninstalled, but cannot receive catalogue updates.
_Avoid_: Deleted skill
