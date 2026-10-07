# Install targets are skills folders, installed by copy

An Install Target is a skills folder, not an agent. Many agents (Cursor, Codex, GitHub Copilot and the others skills.sh calls "universal") read the one Shared Target, `~/.agents/skills`, while each agent with its own folder (Claude Code, Windsurf, …) is its own target. Every install uses the skills CLI's `--copy` mode so each target holds an independent copy. This refines ADR-0001: installation occupancy is install target plus folder name.

## Considered options

- **One target per agent, with the CLI's default symlinks.** Symlink mode links an own-folder agent to the copy in the Shared Target, so installing to Claude Code silently installs to Cursor too, and uninstalling it removes the skill from Cursor. Rejected because targets could never be reasoned about on their own.
- **One target per agent, installing shared agents as a group with a warning.** Same coupling, more UI.

## Consequences

A skill installed to Claude Code and to the Shared Target exists as two copies that are updated separately. Because a target is identified by its folder path, when a CLI upgrade moves an agent between its own folder and the Shared Target, existing installs stay attached to the folder they are in.
