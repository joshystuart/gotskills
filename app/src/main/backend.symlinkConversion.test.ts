import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend } from './backend'
import { openDatabase } from './db/open'
import { readInstallRecords } from './installer/records'
import { MIGRATION_001_SQL } from './db/migrations/001_schema'
import { MIGRATION_002_SQL } from './db/migrations/002_telemetry'
import { MIGRATION_003_SQL } from './db/migrations/003_telemetry_targets'
import { MIGRATION_004_SQL } from './db/migrations/004_multi_registry'
import { MIGRATION_005_SQL } from './db/migrations/005_skill_path'
import { MIGRATION_006_SQL } from './db/migrations/006_registry_auto_update'
import { DatabaseSync } from 'node:sqlite'
import type { InstallRecord } from '../shared/ipc'
import { fakeHomeDetection } from './fakeHome'

function seedSchema6Records(path: string, rows: string[][]): void {
  const db = new DatabaseSync(path)
  for (const sql of [
    MIGRATION_001_SQL,
    MIGRATION_002_SQL,
    MIGRATION_003_SQL,
    MIGRATION_004_SQL,
    MIGRATION_005_SQL,
    MIGRATION_006_SQL,
  ]) {
    db.exec(sql)
  }
  db.exec('PRAGMA user_version = 6')
  const insert = db.prepare(
    `INSERT INTO install_record
      (target, folder_name, registry_id, content_hash, provenance_sha, method, paths, cli_version, installed_at)
     VALUES (?, ?, ?, ?, ?, 'symlink', ?, '1.6.0', ?)`
  )
  for (const row of rows) insert.run(...row)
  db.close()
}

function writeSkillFolder(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8')
}

function visibleSkills(folder: string): Record<string, string> {
  const seen: Record<string, string> = {}
  for (const name of readdirSync(folder)) {
    seen[name] = readFileSync(join(folder, name, 'SKILL.md'), 'utf8')
  }
  return seen
}

function snapshotTree(root: string): string[] {
  const entries: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file'
      const content = kind === 'file' ? readFileSync(path, 'utf8') : ''
      entries.push(`${path} ${kind} ${stat.mtimeMs} ${content}`)
      if (kind === 'dir') walk(path)
    }
  }
  walk(root)
  return entries
}

describe('startup conversion of symlink installs', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  function startOnce(userData: string, home: string): void {
    createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    }).close()
  }

  function records(userData: string): InstallRecord[] {
    const db = openDatabase(join(userData, 'cache.sqlite'))
    const rows = readInstallRecords(db).sort((a, b) =>
      `${a.target}/${a.folderName}`.localeCompare(`${b.target}/${b.folderName}`)
    )
    db.close()
    return rows
  }

  it('turns migrated old-layout symlink installs into independent copies without losing any skill', () => {
    const home = temp('igs-conv-home-')
    const userData = temp('igs-conv-ud-')
    const claudeSkills = join(home, '.claude', 'skills')
    const sharedSkills = join(home, '.agents', 'skills')
    const cursorSkills = join(home, '.cursor', 'skills')

    writeSkillFolder(join(sharedSkills, 'alpha'), 'alpha body')
    writeSkillFolder(join(sharedSkills, 'beta'), 'beta body')
    mkdirSync(claudeSkills, { recursive: true })
    mkdirSync(cursorSkills, { recursive: true })
    symlinkSync(join(sharedSkills, 'alpha'), join(claudeSkills, 'alpha'))
    symlinkSync(join(sharedSkills, 'beta'), join(cursorSkills, 'beta'))

    seedSchema6Records(join(userData, 'cache.sqlite'), [
      [
        'claude-code',
        'alpha',
        'reg-a',
        'hash-alpha',
        'sha-alpha',
        JSON.stringify([join(claudeSkills, 'alpha'), join(sharedSkills, 'alpha')]),
        '2026-01-02T03:04:05.000Z',
      ],
      [
        'cursor',
        'beta',
        'reg-b',
        'hash-beta',
        'sha-beta',
        JSON.stringify([join(cursorSkills, 'beta'), join(sharedSkills, 'beta')]),
        '2026-02-03T04:05:06.000Z',
      ],
    ])

    startOnce(userData, home)

    expect(lstatSync(join(claudeSkills, 'alpha')).isDirectory()).toBe(true)
    expect(visibleSkills(claudeSkills)).toEqual({ alpha: 'alpha body' })
    expect(visibleSkills(sharedSkills)).toEqual({ alpha: 'alpha body', beta: 'beta body' })
    expect(readdirSync(cursorSkills)).toEqual([])

    expect(records(userData)).toEqual([
      {
        target: '~/.agents/skills',
        folderName: 'alpha',
        registryId: 'reg-a',
        contentHash: 'hash-alpha',
        provenanceSha: 'sha-alpha',
        method: 'copy',
        paths: [join(sharedSkills, 'alpha')],
        cliVersion: '1.6.0',
        installedAt: '2026-01-02T03:04:05.000Z',
      },
      {
        target: '~/.agents/skills',
        folderName: 'beta',
        registryId: 'reg-b',
        contentHash: 'hash-beta',
        provenanceSha: 'sha-beta',
        method: 'copy',
        paths: [join(sharedSkills, 'beta')],
        cliVersion: '1.6.0',
        installedAt: '2026-02-03T04:05:06.000Z',
      },
      {
        target: '~/.claude/skills',
        folderName: 'alpha',
        registryId: 'reg-a',
        contentHash: 'hash-alpha',
        provenanceSha: 'sha-alpha',
        method: 'copy',
        paths: [join(claudeSkills, 'alpha')],
        cliVersion: '1.6.0',
        installedAt: '2026-01-02T03:04:05.000Z',
      },
    ])

    const filesBefore = snapshotTree(home)
    const recordsBefore = records(userData)
    startOnce(userData, home)
    expect(snapshotTree(home)).toEqual(filesBefore)
    expect(records(userData)).toEqual(recordsBefore)
  })
})
