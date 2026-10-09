import { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction'
import { MIGRATION_001_SQL } from './migrations/001_schema'
import { MIGRATION_002_SQL } from './migrations/002_telemetry'
import { MIGRATION_003_SQL } from './migrations/003_telemetry_targets'
import { MIGRATION_004_SQL } from './migrations/004_multi_registry'
import { MIGRATION_005_SQL } from './migrations/005_skill_path'
import { MIGRATION_006_SQL } from './migrations/006_registry_auto_update'
import { MIGRATION_007_SQL } from './migrations/007_install_target_ids'

import { MIGRATION_008_SQL } from './migrations/008_app_setting'
import { MIGRATION_009_SQL } from './migrations/009_registry_colour'
import { MIGRATION_010_SQL } from './migrations/010_registry_name'

const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: MIGRATION_001_SQL },
  { version: 2, sql: MIGRATION_002_SQL },
  { version: 3, sql: MIGRATION_003_SQL },
  { version: 4, sql: MIGRATION_004_SQL },
  { version: 5, sql: MIGRATION_005_SQL },
  { version: 6, sql: MIGRATION_006_SQL },
  { version: 7, sql: MIGRATION_007_SQL },
  { version: 8, sql: MIGRATION_008_SQL },
  { version: 9, sql: MIGRATION_009_SQL },
  { version: 10, sql: MIGRATION_010_SQL },
]

/**
 * Open (or create) the local cache DB and apply numbered migrations via
 * PRAGMA user_version. Schema is the accepted 011 DDL plus telemetry (002).
 */
export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)

  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')

    const current = db.prepare('PRAGMA user_version').get()!.user_version as number
    for (const step of MIGRATIONS) {
      if (current >= step.version) continue

      transaction(db, () => {
        db.exec(step.sql)
        db.exec(`PRAGMA user_version = ${step.version}`)
      })
    }

    return db
  } catch (error) {
    db.close()
    throw error
  }
}
