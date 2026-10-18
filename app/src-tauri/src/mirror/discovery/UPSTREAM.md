# Upstream discovery and agent port

This directory contains a vendored copy of skill-discovery logic and the agent table from [vercel-labs/skills](https://github.com/vercel-labs/skills).

## Source version

| Field   | Value                                      |
| ------- | ------------------------------------------ |
| Package | `skills@1.7.0`                             |
| Git tag | `v1.7.0`                                   |
| Commit  | `7407f3893ad4dceab546ac002c3ef806e4000c73` |
| License | MIT                                        |

## Ported modules

| Local file           | Upstream source (`src/`)            |
| -------------------- | ----------------------------------- |
| `skills.ts`          | `skills.ts`                         |
| `frontmatter.ts`     | `frontmatter.ts`                    |
| `sanitize.ts`        | `sanitize.ts`                       |
| `plugin-manifest.ts` | `plugin-manifest.ts`                |
| `constants.ts`       | `constants.ts` (discovery subset)   |
| `local-lock.ts`      | `local-lock.ts` (read-only subset)  |
| `types.ts`           | `types.ts` (`Skill` interface only) |
| `agents.ts`          | `agents.ts` (agent table, trimmed)  |

## Refresh process

When bumping the `skills` dependency in `app/package.json`:

1. **Note the new version** — check `app/package.json` and the upstream release tag.
2. **Clone or fetch upstream** at that tag:
   ```bash
   git clone --depth 1 --branch vX.Y.Z https://github.com/vercel-labs/skills.git /tmp/skills-upstream
   cd /tmp/skills-upstream && git rev-parse HEAD
   ```
3. **Diff each ported file** against `src/` in the upstream repo:
   ```bash
   diff -u app/src/main/mirror/discovery/skills.ts /tmp/skills-upstream/src/skills.ts
   # repeat for frontmatter.ts, sanitize.ts, plugin-manifest.ts, constants.ts, local-lock.ts, types.ts, agents.ts
   ```
4. **Reconcile changes** — port intentional upstream fixes; keep Got Skills–specific trims (e.g. `local-lock.ts` write/hash helpers omitted; `types.ts` minimal; the `agents.ts` trims below).
5. **Update this file** — bump the version table (package, tag, commit).
6. **Update attribution headers** — change `@<old version>` in each file's header comment to the new version.
7. **Run typecheck and tests** — `npm run typecheck` and `npm test` in `app/`. The agent table contract test (`agents.contract.test.ts`) runs the real vendored CLI and fails when an agent's install folder moves upstream.

## Agent table trims

`agents.ts` keeps upstream's agents, folders and detection rules, with these Got Skills changes:

- **Injected environment.** `agentTable({ home, env, exists })` builds the table on demand. Loading the module reads nothing from the real home, environment or file system. Upstream's `homedir()`, `process.env` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `VIBE_HOME`, `HERMES_HOME`, `AUTOHAND_HOME`, `GROK_HOME`, `SARVAM_HOME`, `APPDATA`, `FLATPAK_XDG_CONFIG_HOME`) and `existsSync` all come from those arguments, including absolute checks such as `/Applications/ZCode.app` and `/etc/codex`. `XDG_CONFIG_HOME` replaces the `xdg-basedir` import with the same fallback (`<home>/.config`).
- **Left-out agents.** The `universal` pseudo-agent and the agents with no global folder (`eve`, `promptscript`) are not in the table.
- **No working-directory checks.** Detection checks against `process.cwd()` are dropped (AstrBot, CodeBuddy, Continue, Jazz, Replit). Replit's only check was the working directory, so it is never detected.
- **Detection is synchronous** and the prompt-only fields (`showInUniversalList`, `showInUniversalPrompt`, `createProjectSkillsDirByDefault`) and helper exports (`detectInstalledAgents`, `getUniversalAgents`, Eve subagents and the like) are omitted.
- **Install folder.** Each entry carries `installFolder`: `<home>/.agents/skills` (the Shared Target) for agents whose `skillsDir` is `.agents/skills`, which upstream's `isUniversalAgent` treats as universal, and the agent's own global folder otherwise. This mirrors upstream's `getAgentBaseDir` for global installs.

## Scope

Only discovery, frontmatter parsing and the agent table are ported. Install, telemetry, git clone, and CLI prompt code remain in the vendored `skills` npm package.
