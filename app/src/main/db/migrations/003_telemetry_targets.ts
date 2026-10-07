/** Migration 003 — requested target apps on install_requested telemetry. */
export const MIGRATION_003_SQL = `
ALTER TABLE telemetry_event ADD COLUMN targets TEXT;
`
