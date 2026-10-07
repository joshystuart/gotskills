#!/usr/bin/env bash
set -euo pipefail

built_bundle="${1:-$(ls -d dist/mac*/"Got Skills.app" | head -n 1)}"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

app_bundle="$work_dir/Got Skills.app"
ditto "$built_bundle" "$app_bundle"
binary="$app_bundle/Contents/MacOS/Got Skills"
cli_entry="$app_bundle/Contents/Resources/app.asar.unpacked/node_modules/skills/bin/cli.mjs"

ELECTRON_RUN_AS_NODE=1 "$binary" -e '
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(":memory:")
  const row = db.prepare("SELECT 42 AS answer").get()
  if (row.answer !== 42) throw new Error("Packaged SQLite query failed")
  db.close()
'

fixture="$work_dir/fixture/smoke-skill"
mkdir -p "$fixture" "$work_dir/home"
cat > "$fixture/SKILL.md" <<'SKILL'
---
name: smoke-skill
description: Fixture skill for the packaged CLI smoke test.
---

# Smoke skill
SKILL

HOME="$work_dir/home" ELECTRON_RUN_AS_NODE=1 CI=1 NO_COLOR=1 DO_NOT_TRACK=1 \
  "$binary" "$cli_entry" add "$work_dir/fixture" --skill smoke-skill -g -a claude-code -y --copy

installed="$work_dir/home/.claude/skills/smoke-skill/SKILL.md"
if [[ ! -f "$installed" ]]; then
  echo "Packaged CLI exited 0 but $installed is missing" >&2
  exit 1
fi
echo "Packaged CLI installed $installed"
