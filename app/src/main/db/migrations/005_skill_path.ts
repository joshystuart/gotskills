/**
 * Migration 005 — add skill_path for git provenance on nested registry layouts.
 *
 * skill_path stores the POSIX-relative path from the mirror root to the skill
 * directory containing SKILL.md. Backfill happens on the next sync.
 */
export const MIGRATION_005_SQL = `
ALTER TABLE skill ADD COLUMN skill_path TEXT;
`
