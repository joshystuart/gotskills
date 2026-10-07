export const MIGRATION_006_SQL = `
ALTER TABLE registry ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 0 CHECK (auto_update IN (0, 1));
`
