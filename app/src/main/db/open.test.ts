import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATION_001_SQL } from './migrations/001_schema'
import { MIGRATION_002_SQL } from './migrations/002_telemetry'
import { MIGRATION_003_SQL } from './migrations/003_telemetry_targets'
import { MIGRATION_004_SQL } from './migrations/004_multi_registry'
import { MIGRATION_005_SQL } from './migrations/005_skill_path'
import { MIGRATION_007_SQL } from './migrations/007_install_target_ids'
import { MIGRATION_006_SQL } from './migrations/006_registry_auto_update'
import { listRegistries } from '../registries'
import { getAutoDownloadAppUpdates, setAutoDownloadAppUpdates } from '../appSettings'
import { openDatabase } from './open'

describe('openDatabase (PRAGMA user_version migrations)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stores App Update preferences across database opens with automatic downloads on by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igs-db-'))
    dirs.push(dir)
    const path = join(dir, 'cache.sqlite')
    const db = openDatabase(path)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'app_setting'").get()).toEqual({
      name: 'app_setting',
    })
    expect(getAutoDownloadAppUpdates(db)).toBe(true)
    setAutoDownloadAppUpdates(db, false)
    db.close()
    const reopened = openDatabase(path)
    expect(getAutoDownloadAppUpdates(reopened)).toBe(false)
    setAutoDownloadAppUpdates(reopened, true)
    expect(getAutoDownloadAppUpdates(reopened)).toBe(true)
    reopened.close()
  })

  it('opens an existing version-7 WAL database without changing stored data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igs-db-'))
    dirs.push(dir)
    const path = join(dir, 'cache.sqlite')
    const previous = new DatabaseSync(path)
    previous.exec('PRAGMA journal_mode = WAL')
    for (const sql of [
      MIGRATION_001_SQL,
      MIGRATION_002_SQL,
      MIGRATION_003_SQL,
      MIGRATION_004_SQL,
      MIGRATION_005_SQL,
      MIGRATION_006_SQL,
      MIGRATION_007_SQL,
    ]) {
      previous.exec(sql)
    }
    previous.exec('PRAGMA user_version = 7')
    previous.exec(`
      INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at)
      VALUES ('saved', 'https://example.test/saved.git', 'main', 'saved', '2026-01-01', '2026-01-01');
      INSERT INTO skill (registry_id, folder_name, name, description)
      VALUES ('saved', 'alpha', 'Alpha', 'Retained skill');
      INSERT INTO install_record (target, folder_name, registry_id, content_hash, provenance_sha,
        method, paths, cli_version, installed_at)
      VALUES ('~/.agents/skills', 'alpha', 'saved', 'hash', 'sha', 'copy', '["/saved"]', '1.7.0', '2026-01-01');
      INSERT INTO telemetry_event (event_id, occurred_at_utc, installation_id, session_id,
        event_type, schema_version, app_version)
      VALUES ('saved-event', '2026-01-01', 'installation', 'session', 'session_started', 2, '0.0.5');
    `)
    previous.close()
    const db = openDatabase(path)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(db.prepare('SELECT id, branch, colour FROM registry').get()).toEqual({
      id: 'saved',
      branch: 'main',
      colour: null,
    })
    expect(db.prepare('SELECT name, description FROM skill').get()).toEqual({
      name: 'Alpha',
      description: 'Retained skill',
    })
    expect(db.prepare('SELECT target, content_hash FROM install_record').get()).toEqual({
      target: '~/.agents/skills',
      content_hash: 'hash',
    })
    expect(db.prepare('SELECT installation_id FROM telemetry_event').get()).toEqual({
      installation_id: 'installation',
    })
    db.close()
  })

  it('applies the multi-registry schema to a fresh DB and sets user_version to 9', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igs-db-'))
    dirs.push(dir)
    const db = openDatabase(join(dir, 'cache.sqlite'))
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(9)

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toEqual(
      expect.arrayContaining([
        'registry',
        'registry_sync_marker',
        'skill',
        'version',
        'install_record',
        'telemetry_event',
      ])
    )

    db.prepare(
      `INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at)
       VALUES ('r1', 'https://example.test/skills.git', 'main', 'git:example', '2026-01-01', '2026-01-01')`
    ).run()
    expect(() =>
      db
        .prepare(
          `INSERT INTO skill (registry_id, folder_name, name, description)
           VALUES ('r1', 'alpha', 'Alpha', 'd')`
        )
        .run()
    ).not.toThrow()

    db.close()
  })

  it('moves schema 6 install records and telemetry to install target ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igs-db-'))
    dirs.push(dir)
    const path = join(dir, 'cache.sqlite')
    const previous = new DatabaseSync(path)
    for (const sql of [
      MIGRATION_001_SQL,
      MIGRATION_002_SQL,
      MIGRATION_003_SQL,
      MIGRATION_004_SQL,
      MIGRATION_005_SQL,
      MIGRATION_006_SQL,
    ]) {
      previous.exec(sql)
    }
    previous.exec('PRAGMA user_version = 6')
    previous.exec(`
      INSERT INTO install_record
        (target, folder_name, registry_id, content_hash, provenance_sha, method, paths, cli_version, installed_at)
      VALUES
        ('claude-code', 'alpha', 'r1', 'h1', 's1', 'symlink', '["/a"]', '1.7.0', '2026-01-01'),
        ('cursor', 'alpha', 'r1', 'h2', 's2', 'copy', '["/b"]', '1.7.0', '2026-01-02');
      INSERT INTO telemetry_event
        (event_id, occurred_at_utc, installation_id, session_id, event_type, schema_version,
         app_version, action, targets, target_app, outcome)
      VALUES
        ('e1', '2026-01-01', 'i', 's', 'install_requested', 2, '0.0.4', 'install',
         '["claude-code","cursor"]', NULL, NULL),
        ('e2', '2026-01-01', 'i', 's', 'install_target_completed', 2, '0.0.4', 'install',
         NULL, 'cursor', 'success');
    `)
    previous.close()

    const upgraded = openDatabase(path)
    expect(upgraded.prepare('PRAGMA user_version').get()!.user_version).toBe(9)
    expect(upgraded.prepare(`SELECT * FROM install_record ORDER BY installed_at`).all()).toEqual([
      {
        target: '~/.claude/skills',
        folder_name: 'alpha',
        registry_id: 'r1',
        content_hash: 'h1',
        provenance_sha: 's1',
        method: 'symlink',
        paths: '["/a"]',
        cli_version: '1.7.0',
        installed_at: '2026-01-01',
      },
      {
        target: '~/.agents/skills',
        folder_name: 'alpha',
        registry_id: 'r1',
        content_hash: 'h2',
        provenance_sha: 's2',
        method: 'copy',
        paths: '["/b"]',
        cli_version: '1.7.0',
        installed_at: '2026-01-02',
      },
    ])
    expect(
      upgraded
        .prepare(
          `SELECT event_id, targets, target_app, outcome FROM telemetry_event ORDER BY event_id`
        )
        .all()
    ).toEqual([
      {
        event_id: 'e1',
        targets: '["~/.claude/skills","~/.agents/skills"]',
        target_app: null,
        outcome: null,
      },
      { event_id: 'e2', targets: null, target_app: '~/.agents/skills', outcome: 'success' },
    ])

    const indexes = upgraded
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`)
      .all()
      .map((r) => (r as { name: string }).name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_install_provenance',
        'idx_telemetry_occurred',
        'idx_telemetry_operation',
        'idx_telemetry_type',
      ])
    )

    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO install_record
            (target, folder_name, registry_id, content_hash, provenance_sha, method, cli_version, installed_at)
           VALUES ('/opt/skills', 'alpha', 'r1', 'h', 's', 'copy', '1.0', '2020-01-01')`
        )
        .run()
    ).not.toThrow()
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO install_record
            (target, folder_name, registry_id, content_hash, provenance_sha, method, cli_version, installed_at)
           VALUES ('/opt/skills', 'alpha', 'r2', 'h', 's', 'copy', '1.0', '2020-01-01')`
        )
        .run()
    ).toThrow()
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO telemetry_event
            (event_id, occurred_at_utc, installation_id, session_id, event_type, schema_version,
             app_version, target_app)
           VALUES ('e3', '2026-01-01', 'i', 's', 'install_target_completed', 2, '0.0.5', '/opt/skills')`
        )
        .run()
    ).not.toThrow()
    upgraded.close()
  })

  it('preserves all Registries from schema 5 with Auto Update off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igs-db-'))
    dirs.push(dir)
    const path = join(dir, 'cache.sqlite')
    const previous = new DatabaseSync(path)
    for (const sql of [
      MIGRATION_001_SQL,
      MIGRATION_002_SQL,
      MIGRATION_003_SQL,
      MIGRATION_004_SQL,
      MIGRATION_005_SQL,
    ]) {
      previous.exec(sql)
    }
    previous.exec('PRAGMA user_version = 5')
    previous
      .prepare(
        `INSERT INTO registry (id, url, branch, canonical_key, enabled, created_at, updated_at)
      VALUES ('a', 'https://example.test/a', 'main', 'a', 1, '2026-01-01', '2026-01-01'),
             ('b', 'https://example.test/b', 'dev', 'b', 0, '2026-01-01', '2026-01-01')`
      )
      .run()
    previous.close()

    const upgraded = openDatabase(path)
    expect(listRegistries(upgraded)).toEqual([
      expect.objectContaining({ id: 'a', branch: 'main', enabled: true, autoUpdate: false }),
      expect.objectContaining({ id: 'b', branch: 'dev', enabled: false, autoUpdate: false }),
    ])
    upgraded.close()
  })

  it('is idempotent — opening an already-migrated DB does not re-apply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igs-db-'))
    dirs.push(dir)
    const path = join(dir, 'cache.sqlite')
    const first = openDatabase(path)
    first
      .prepare(
        `INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at)
         VALUES ('r1', 'https://example.test/skills.git', 'main', 'git:example', '2026-01-01', '2026-01-01')`
      )
      .run()
    first.close()

    const second = openDatabase(path)
    expect(second.prepare('PRAGMA user_version').get()!.user_version).toBe(9)
    const row = second.prepare(`SELECT id FROM registry WHERE id = 'r1'`).get() as
      { id: string } | undefined
    expect(row?.id).toBe('r1')
    second.close()
  })

  it('rebuilds registry-scoped tables on upgrade while preserving telemetry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igs-db-'))
    dirs.push(dir)
    const path = join(dir, 'cache.sqlite')
    const v3 = new DatabaseSync(path)
    v3.exec('PRAGMA foreign_keys = ON')
    v3.exec(MIGRATION_001_SQL)
    v3.exec(MIGRATION_002_SQL)
    v3.exec(MIGRATION_003_SQL)
    v3.exec('PRAGMA user_version = 3')
    v3.prepare(`INSERT INTO skill (id, name, description) VALUES ('legacy', 'Legacy', 'old')`).run()
    v3.prepare(
      `INSERT INTO telemetry_event
          (event_id, occurred_at_utc, installation_id, session_id, event_type,
           schema_version, app_version)
         VALUES
          ('event-a', '2026-07-10T12:06:00.000Z', 'install-a', 'session-a',
           'session_started', 1, '0.0.1')`
    ).run()
    v3.close()

    const upgraded = openDatabase(path)
    expect(upgraded.prepare('PRAGMA user_version').get()!.user_version).toBe(9)

    expect(
      upgraded
        .prepare(`SELECT installation_id FROM telemetry_event WHERE event_id = 'event-a'`)
        .get()
    ).toEqual({ installation_id: 'install-a' })

    const skillColumns = upgraded
      .prepare(`PRAGMA table_info(skill)`)
      .all()
      .map((c) => (c as { name: string }).name)
    expect(skillColumns).toContain('registry_id')
    expect(skillColumns).toContain('folder_name')
    expect(skillColumns).toContain('skill_path')
    upgraded.close()
  })

  it('rolls back a failed migration and its version advance together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'igs-db-'))
    dirs.push(dir)
    const path = join(dir, 'cache.sqlite')
    const v1 = new DatabaseSync(path)
    v1.exec('PRAGMA foreign_keys = ON')
    v1.exec(MIGRATION_001_SQL)
    v1.prepare(`INSERT INTO skill (id, name, description) VALUES ('keep', 'Keep', 'd')`).run()
    v1.exec(`CREATE INDEX idx_telemetry_occurred ON skill (name)`)
    v1.exec('PRAGMA user_version = 1')
    v1.close()

    expect(() => openDatabase(path)).toThrow()

    const inspected = new DatabaseSync(path, { readOnly: true })
    expect(inspected.prepare('PRAGMA user_version').get()!.user_version).toBe(1)
    expect(
      inspected
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'telemetry_event'`
        )
        .get()
    ).toBeUndefined()
    expect(inspected.prepare(`SELECT name FROM skill WHERE id = 'keep'`).get()).toEqual({
      name: 'Keep',
    })
    inspected.close()
  })
})
