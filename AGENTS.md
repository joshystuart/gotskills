## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

# Code Standards

- No `//` or `/* */` comments; JSDoc on declarations is fine. If code needs explaining, simplify it. A test enforces this.

## Checks

Run `npm run check` from the repository root before handing back work.

## Releases

For a feature or a fix, bump the patch version in `app/package.json` and `app/package-lock.json` in the same PR, because merging a new version to `main` publishes a release. Refactors, tests and docs don't bump.
