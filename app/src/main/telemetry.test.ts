import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type Backend } from './backend'
import { openDatabase } from './db/open'
import { upsertInstallRecord } from './installer/records'
import type { RunSkillsCli } from './installer/cli'
import { fakeHomeDetection } from './fakeHome'

async function withoutDefault(backend: Backend): Promise<void> {
  for (const r of await backend.listRegistries()) await backend.removeRegistry(r.id)
}

const DISALLOWED_FIELD_KEYS = [
  'name',
  'email',
  'username',
  'os_username',
  'path',
  'paths',
  'filename',
  'file_name',
  'error',
  'stderr',
  'stdout',
  'message',
  'raw_output',
  'command',
  'argv',
] as const

const DISALLOWED_EVENT_TYPES = [
  'search',
  'filter',
  'detail_view',
  'dwell',
  'funnel',
  'click',
  'os_profile',
  'hardware_profile',
  'skill_runtime',
] as const

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function writeSkill(root: string, id: string, name: string, description: string): void {
  const dir = join(root, 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8'
  )
}

function makeRemote(skillIds: string[]): string {
  const remote = mkdtempSync(join(tmpdir(), 'igs-telem-remote-'))
  git(remote, 'init', '-b', 'main')
  git(remote, 'config', 'user.email', 'test@example.com')
  git(remote, 'config', 'user.name', 'Test')
  for (const id of skillIds) {
    writeSkill(remote, id, id, `${id} description`)
  }
  git(remote, 'add', '.')
  git(remote, 'commit', '-m', 'seed')
  return remote
}

function parseJsonl(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
    return into
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.add(k)
      collectKeys(v, into)
    }
  }
  return into
}

function seedRecord(userData: string, target: string, folderName: string): void {
  const db = openDatabase(join(userData, 'cache.sqlite'))
  upsertInstallRecord(db, {
    target,
    folderName,
    registryId: 'reg-seed',
    contentHash: 'hash',
    provenanceSha: 'sha',
    method: 'copy',
    paths: [],
    cliVersion: '1.7.0',
    installedAt: '2026-01-01T00:00:00.000Z',
  })
  db.close()
}

function readStoredInstallEvents(
  userData: string
): { event_type: string; targets: string | null; target_app: string | null }[] {
  const db = openDatabase(join(userData, 'cache.sqlite'))
  const rows = db
    .prepare(
      `SELECT event_type, targets, target_app FROM telemetry_event
       WHERE event_type IN ('install_requested', 'install_target_completed')`
    )
    .all() as { event_type: string; targets: string | null; target_app: string | null }[]
  db.close()
  return rows
}

const copyIntoStagingHome: RunSkillsCli = async (args, opts) => {
  const skillId = args[args.indexOf('--skill') + 1]!
  const dest = join(opts.home, '.agents', 'skills', skillId)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'SKILL.md'), '# ok\n', 'utf8')
  return { code: 0, stdout: '', stderr: '' }
}

describe('telemetry & JSONL export (AppApi seam)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stores install target ids and drops ids that are not known install targets', () => {
    const userData = mkdtempSync(join(tmpdir(), 'igs-telem-'))
    dirs.push(userData)
    const home = mkdtempSync(join(tmpdir(), 'igs-telem-home-'))
    dirs.push(home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })

    backend.telemetry.emit({
      event_type: 'install_requested',
      targets: ['~/.claude/skills', '/private/elsewhere/skills', 'claude-code', '~/.agents/skills'],
    })
    backend.telemetry.emit({
      event_type: 'install_target_completed',
      target_app: '~/.agents/skills',
      outcome: 'success',
    })
    backend.telemetry.emit({
      event_type: 'install_target_completed',
      target_app: '/private/elsewhere/skills',
      outcome: 'success',
    })

    const events = parseJsonl(backend.telemetry.exportJsonl())
    backend.close()

    expect(events.find((e) => e.event_type === 'install_requested')?.targets).toEqual([
      '~/.claude/skills',
      '~/.agents/skills',
    ])
    expect(
      new Set(
        events.filter((e) => e.event_type === 'install_target_completed').map((e) => e.target_app)
      )
    ).toEqual(new Set(['~/.agents/skills', null]))
  })

  it('keeps a records-only target under home in stored install events', async () => {
    const remote = makeRemote(['alpha'])
    dirs.push(remote)
    const userData = mkdtempSync(join(tmpdir(), 'igs-telem-'))
    dirs.push(userData)
    const home = mkdtempSync(join(tmpdir(), 'igs-telem-home-'))
    dirs.push(home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: copyIntoStagingHome,
    })
    await withoutDefault(backend)
    const registry = await backend.addRegistry({ url: remote, branch: 'main' })
    const revision = (await backend.getCatalogue()).syncStatus.registries[0].revision!
    seedRecord(userData, '~/.cursor/skills', 'beta')

    const result = await backend.install({
      registryId: registry.id,
      folderName: 'alpha',
      targets: ['~/.cursor/skills'],
      mirrorRevision: revision,
    })
    backend.close()

    expect(result.perTarget.map((t) => t.outcome)).toEqual(['installed'])
    expect(readStoredInstallEvents(userData)).toEqual([
      { event_type: 'install_requested', targets: '["~/.cursor/skills"]', target_app: null },
      { event_type: 'install_target_completed', targets: null, target_app: '~/.cursor/skills' },
    ])
  }, 20_000)

  it('stores no target for a records-only folder outside home', async () => {
    const remote = makeRemote(['alpha'])
    dirs.push(remote)
    const userData = mkdtempSync(join(tmpdir(), 'igs-telem-'))
    dirs.push(userData)
    const home = mkdtempSync(join(tmpdir(), 'igs-telem-home-'))
    dirs.push(home)
    const outside = mkdtempSync(join(tmpdir(), 'igs-telem-outside-'))
    dirs.push(outside)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: copyIntoStagingHome,
    })
    await withoutDefault(backend)
    const registry = await backend.addRegistry({ url: remote, branch: 'main' })
    const revision = (await backend.getCatalogue()).syncStatus.registries[0].revision!
    seedRecord(userData, outside, 'beta')

    const result = await backend.install({
      registryId: registry.id,
      folderName: 'alpha',
      targets: [outside],
      mirrorRevision: revision,
    })
    backend.close()

    expect(result.perTarget.map((t) => t.outcome)).toEqual(['installed'])
    expect(readStoredInstallEvents(userData)).toEqual([
      { event_type: 'install_requested', targets: '[]', target_app: null },
      { event_type: 'install_target_completed', targets: null, target_app: null },
    ])
  }, 20_000)

  it('exports stored targets only when they are known targets under home', () => {
    const userData = mkdtempSync(join(tmpdir(), 'igs-telem-'))
    dirs.push(userData)
    const home = mkdtempSync(join(tmpdir(), 'igs-telem-home-'))
    dirs.push(home)
    const outside = mkdtempSync(join(tmpdir(), 'igs-telem-outside-'))
    dirs.push(outside)
    seedRecord(userData, '~/.cursor/skills', 'beta')
    seedRecord(userData, outside, 'beta')
    const db = openDatabase(join(userData, 'cache.sqlite'))
    const insert = db.prepare(
      `INSERT INTO telemetry_event (
        event_id, occurred_at_utc, installation_id, session_id, event_type,
        schema_version, app_version, targets, target_app
      ) VALUES (?, ?, 'installation', 'session', ?, 2, '0.0.0', ?, ?)`
    )
    insert.run(
      'e1',
      '2026-01-01T00:00:00.000Z',
      'install_requested',
      JSON.stringify(['~/.cursor/skills', outside, '~/.unrecorded/skills']),
      null
    )
    insert.run(
      'e2',
      '2026-01-01T00:00:01.000Z',
      'install_target_completed',
      null,
      '~/.cursor/skills'
    )
    insert.run('e3', '2026-01-01T00:00:02.000Z', 'install_target_completed', null, outside)
    db.close()

    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    const events = parseJsonl(backend.telemetry.exportJsonl())
    backend.close()

    expect(
      events
        .filter((e) => ['e1', 'e2', 'e3'].includes(String(e.event_id)))
        .map(({ targets, target_app }) => ({ targets, target_app }))
    ).toEqual([
      { targets: ['~/.cursor/skills'], target_app: null },
      { targets: null, target_app: '~/.cursor/skills' },
      { targets: null, target_app: null },
    ])
  })

  it('persists installation_id once and emits correlated events without disallowed fields', async () => {
    const remote = makeRemote(['alpha'])
    dirs.push(remote)
    const alphaCommit = git(remote, 'log', '-1', '--format=%H', '--', 'skills/alpha')
    const alphaContentHash = git(remote, 'rev-parse', `${alphaCommit}:skills/alpha`)
    writeFileSync(join(remote, 'README.md'), '# Registry\n', 'utf8')
    git(remote, 'add', 'README.md')
    git(remote, 'commit', '-m', 'change repository without touching alpha')
    const repositoryHead = git(remote, 'rev-parse', 'HEAD')
    expect(repositoryHead).not.toBe(alphaCommit)
    const userData = mkdtempSync(join(tmpdir(), 'igs-telem-'))
    dirs.push(userData)
    const home = mkdtempSync(join(tmpdir(), 'igs-telem-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })

    const runSkillsCli: RunSkillsCli = async (args, opts) => {
      const skillIdx = args.indexOf('--skill')
      const skillId = skillIdx >= 0 ? args[skillIdx + 1]! : 'alpha'
      const targetIdx = args.indexOf('-a')
      const target = targetIdx >= 0 ? args[targetIdx + 1]! : 'claude-code'
      const dest =
        target === 'claude-code'
          ? join(opts.home, '.claude', 'skills', skillId)
          : join(opts.home, '.agents', 'skills', skillId)
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), '# ok\n', 'utf8')
      return { code: 0, stdout: '', stderr: '' }
    }

    const first = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli,
    })

    await withoutDefault(first)
    const registry = await first.addRegistry({ url: remote, branch: 'main' })
    const registryId = registry.id
    const catalogue = await first.getCatalogue()
    expect(catalogue.syncStatus.phase).toBe('synced')
    const revision = catalogue.syncStatus.registries[0].revision
    expect(revision).toBe(repositoryHead)

    const installResult = await first.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills', '~/.agents/skills'],
      mirrorRevision: revision!,
    })
    expect(installResult.perTarget.every((t) => t.outcome === 'installed')).toBe(true)

    const export1 = first.telemetry.exportJsonl()
    const events1 = parseJsonl(export1)
    first.close()

    const installationIds = new Set(events1.map((e) => e.installation_id))
    expect(installationIds.size).toBe(1)
    const installationId = [...installationIds][0]
    expect(typeof installationId).toBe('string')
    expect(String(installationId).length).toBeGreaterThan(8)

    const second = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli,
    })
    const export2 = second.telemetry.exportJsonl()
    const events2 = parseJsonl(export2)
    expect(new Set(events2.map((e) => e.installation_id))).toEqual(new Set([installationId]))
    second.close()

    const types = events1.map((e) => e.event_type)
    expect(types).toContain('session_started')
    expect(types).toContain('sync_completed')
    expect(types).toContain('install_requested')
    expect(types).toContain('install_target_completed')

    for (const banned of DISALLOWED_EVENT_TYPES) {
      expect(types).not.toContain(banned)
    }

    const keys = collectKeys(events1)
    for (const banned of DISALLOWED_FIELD_KEYS) {
      expect(keys.has(banned)).toBe(false)
    }

    expect(export1).not.toMatch(/test@example\.com/)
    expect(export1).not.toMatch(/\/Users\//)
    expect(export1).not.toMatch(/SKILL\.md/)
    expect(export1).not.toMatch(/install failed/)

    const syncEvents = events1.filter((e) => e.event_type === 'sync_completed')
    expect(syncEvents.length).toBeGreaterThanOrEqual(1)
    expect(syncEvents[0]).toMatchObject({
      registry_revision: revision,
      visible_skill_count: 1,
    })

    const requested = events1.filter((e) => e.event_type === 'install_requested')
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({
      action: 'install',
      skill_id: `${registryId}/alpha`,
      commit_sha: alphaCommit,
      content_hash: alphaContentHash,
      targets: ['~/.claude/skills', '~/.agents/skills'],
      operation_id: expect.any(String),
    })
    expect(requested[0]?.commit_sha).not.toBe(repositoryHead)
    expect(requested[0]!.operation_id).toBeTruthy()
    const operationId = requested[0]!.operation_id

    const completed = events1.filter((e) => e.event_type === 'install_target_completed')
    expect(completed).toHaveLength(2)
    expect(completed.every((e) => e.operation_id === operationId)).toBe(true)
    expect(completed.map((e) => e.target_app).sort()).toEqual([
      '~/.agents/skills',
      '~/.claude/skills',
    ])
    for (const ev of completed) {
      expect(ev.targets).toBeNull()
      expect(ev.outcome).toBe('success')
      expect(typeof ev.duration_ms).toBe('number')
      expect(ev.error_category == null || ev.error_category === null).toBe(true)
    }

    for (const ev of events1) {
      expect(ev).toMatchObject({
        event_id: expect.any(String),
        occurred_at_utc: expect.any(String),
        installation_id: installationId,
        session_id: expect.any(String),
        event_type: expect.any(String),
        schema_version: expect.any(Number),
        app_version: expect.any(String),
      })
    }
  }, 20_000)

  it('records install_requested even when the operation fails before targets finish', async () => {
    const remote = makeRemote(['alpha'])
    dirs.push(remote)
    const userData = mkdtempSync(join(tmpdir(), 'igs-telem-abandon-'))
    dirs.push(userData)
    const home = mkdtempSync(join(tmpdir(), 'igs-telem-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })

    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: async () => ({
        code: 1,
        stdout: '',
        stderr: '/home/test-user/secret/path failed',
      }),
    })

    await withoutDefault(backend)
    const registry = await backend.addRegistry({ url: remote, branch: 'main' })
    const revision = (await backend.getCatalogue()).syncStatus.registries[0].revision!

    const result = await backend.install({
      registryId: registry.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revision,
    })
    expect(result.perTarget[0]?.outcome).toBe('failed')

    const events = parseJsonl(backend.telemetry.exportJsonl())
    backend.close()

    const requested = events.find((e) => e.event_type === 'install_requested')
    const completed = events.filter((e) => e.event_type === 'install_target_completed')
    expect(requested?.operation_id).toBeTruthy()
    expect(requested?.targets).toEqual(['~/.claude/skills'])
    expect(completed).toHaveLength(1)
    expect(completed[0]?.operation_id).toBe(requested?.operation_id)
    expect(completed[0]?.outcome).toBe('failure')
    expect(['link_failed', 'cli_failed', 'revision_mismatch', 'unknown']).toContain(
      completed[0]?.error_category
    )

    const exportText = JSON.stringify(events)
    expect(exportText).not.toMatch(/\/home\/test-user/)
    expect(exportText).not.toMatch(/secret/)
    expect(collectKeys(events).has('error')).toBe(false)
  }, 20_000)
})
