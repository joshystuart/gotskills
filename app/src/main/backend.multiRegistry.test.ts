import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, runWithConcurrency, MAX_CONCURRENT_SYNCS, type Backend } from './backend'
import { createSkillsCliRunner } from './installer/cli'
import { InstallationCollisionError } from '../shared/ipc'
import { fakeHomeDetection } from './fakeHome'

/** Count telemetry rows of a given event type in an exported JSONL blob. */
function countEvents(jsonl: string, eventType: string): number {
  return jsonl
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { event_type: string })
    .filter((row) => row.event_type === eventType).length
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
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

describe('multi-registry sync isolation, aggregation, and lifecycle', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function makeRemote(ids: string[]): string {
    const remote = mkdtempSync(join(tmpdir(), 'igs-mr-remote-'))
    dirs.push(remote)
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    for (const id of ids) writeSkill(remote, id, id, `${id} description`)
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'seed')
    return remote
  }

  function newBackend(home: string): { backend: Backend; userData: string } {
    const userData = mkdtempSync(join(tmpdir(), 'igs-mr-ud-'))
    dirs.push(userData)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: createSkillsCliRunner(),
    })
    return { backend, userData }
  }

  /** Recreate a backend against an existing userData to model an app relaunch. */
  function reopenBackend(userData: string, home: string): Backend {
    return createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: createSkillsCliRunner(),
    })
  }

  async function withoutDefault(backend: Backend): Promise<void> {
    for (const r of await backend.listRegistries()) await backend.removeRegistry(r.id)
  }

  it('defaults seeded and newly added Registries to Auto Update off', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    const { backend } = newBackend(home)
    expect(await backend.listRegistries()).toEqual([expect.objectContaining({ autoUpdate: false })])
    const added = await backend.addRegistry({ url: makeRemote(['alpha']), branch: 'main' })
    expect(added.autoUpdate).toBe(false)
    backend.close()
  })

  it('persists Auto Update across restarts and disable/re-enable and applies pending updates', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const remote = makeRemote(['alpha'])
    const { backend, userData } = newBackend(home)
    await withoutDefault(backend)
    const added = await backend.addRegistry({ url: remote, branch: 'main' })
    await backend.install({
      registryId: added.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: added.syncStatus.revision!,
    })
    const before = readFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')
    writeSkill(remote, 'alpha', 'alpha', 'new description')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'change skill')
    await backend.syncRegistry(added.id)
    const syncs = countEvents(backend.telemetry.exportJsonl(), 'sync_completed')
    expect((await backend.updateRegistry({ id: added.id, autoUpdate: true })).autoUpdate).toBe(true)
    expect(readFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')).not.toBe(
      before
    )
    expect(countEvents(backend.telemetry.exportJsonl(), 'sync_completed')).toBe(syncs + 1)
    expect((await backend.updateRegistry({ id: added.id, enabled: false })).autoUpdate).toBe(true)
    backend.close()

    const reopened = reopenBackend(userData, home)
    expect(await reopened.listRegistries()).toEqual([
      expect.objectContaining({ id: added.id, autoUpdate: true, enabled: false }),
    ])
    expect((await reopened.updateRegistry({ id: added.id, enabled: true })).autoUpdate).toBe(true)
    expect((await reopened.updateRegistry({ id: added.id, autoUpdate: false })).autoUpdate).toBe(
      false
    )
    reopened.close()
  })

  it('keeps independent mirrors and reports per-Registry outcomes on refresh; one failure is partial', async () => {
    const remoteA = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    const { backend, userData } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const b = await backend.addRegistry({ url: join(userData, 'missing-remote'), branch: 'main' })

    expect(existsSync(join(userData, 'mirrors', a.id))).toBe(true)

    const result = await backend.refresh()
    const byId = new Map(result.registries.map((r) => [r.registryId, r]))
    expect(byId.get(a.id)?.phase).toBe('synced')
    expect(byId.get(b.id)?.phase).toBe('failed')

    const status = await backend.getSyncStatus()
    expect(status.phase).toBe('partial')
    const skills = (await backend.getCatalogue()).skills
    expect(skills.map((s) => s.folderName)).toContain('alpha')

    backend.close()
  })

  it('retains the last successful snapshot and marks it stale when a later sync fails', async () => {
    const remoteA = makeRemote(['alpha', 'beta'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    expect((await backend.getCatalogue()).skills).toHaveLength(2)

    rmSync(remoteA, { recursive: true, force: true })
    dirs.splice(dirs.indexOf(remoteA), 1)
    const status = await backend.syncRegistry(a.id)
    expect(status.phase).toBe('failed')
    expect(status.stale).toBe(true)

    const catalogue = await backend.getCatalogue()
    expect(catalogue.skills).toHaveLength(2)
    expect(catalogue.skills.every((s) => s.stale)).toBe(true)

    backend.close()
  })

  it('blocks an installation collision from another Registry until uninstall', async () => {
    const remoteA = makeRemote(['alpha'])
    const remoteB = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const b = await backend.addRegistry({ url: remoteB, branch: 'main' })
    const revA = a.syncStatus.revision!
    const revB = b.syncStatus.revision!

    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revA,
    })

    await expect(
      backend.install({
        registryId: b.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: revB,
      })
    ).rejects.toBeInstanceOf(InstallationCollisionError)

    await backend.uninstall({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
    })
    const installedB = await backend.install({
      registryId: b.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revB,
    })
    expect(installedB.perTarget[0]?.outcome).toBe('installed')

    backend.close()
  })

  it('orphans installations when a Registry is removed and retains the mirror until last uninstall', async () => {
    const remoteA = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend, userData } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: a.syncStatus.revision!,
    })

    await backend.removeRegistry(a.id)
    expect(await backend.listRegistries()).toHaveLength(0)
    const catalogue = await backend.getCatalogue()
    const alpha = catalogue.skills.find((s) => s.folderName === 'alpha')
    expect(alpha?.orphaned).toBe(true)
    expect(alpha?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe('installed')
    expect(existsSync(join(userData, 'mirrors', a.id))).toBe(true)

    await backend.uninstall({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
    })
    expect(existsSync(join(userData, 'mirrors', a.id))).toBe(false)
    expect((await backend.getCatalogue()).skills).toHaveLength(0)

    backend.close()
  })

  it('blocks installing a same-name Skill over an Orphaned Installation until uninstall', async () => {
    const remoteA = makeRemote(['alpha'])
    const remoteB = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const b = await backend.addRegistry({ url: remoteB, branch: 'main' })
    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: a.syncStatus.revision!,
    })
    await backend.removeRegistry(a.id)

    await expect(
      backend.install({
        registryId: b.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: b.syncStatus.revision!,
      })
    ).rejects.toBeInstanceOf(InstallationCollisionError)

    await backend.uninstall({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
    })
    const installed = await backend.install({
      registryId: b.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: b.syncStatus.revision!,
    })
    expect(installed.perTarget[0]?.outcome).toBe('installed')

    backend.close()
  })

  it('retains a removed Registry mirror while a live symlink still resolves into it', async () => {
    const remoteA = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend, userData } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: a.syncStatus.revision!,
    })
    await backend.removeRegistry(a.id)

    const { openDatabase } = await import('./db/open')
    const { symlinkSync, rmSync: rm } = await import('node:fs')
    const db = openDatabase(join(userData, 'cache.sqlite'))
    db.prepare(`DELETE FROM install_record WHERE folder_name = 'alpha'`).run()
    db.close()

    const mirrorSkill = join(userData, 'mirrors', a.id, 'skills', 'alpha')
    const agentLink = join(home, '.claude', 'skills', 'alpha')
    rm(agentLink, { recursive: true, force: true })
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    symlinkSync(mirrorSkill, agentLink)
    backend.close()

    const restarted = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: createSkillsCliRunner(),
    })
    expect(existsSync(join(userData, 'mirrors', a.id))).toBe(true)
    expect(existsSync(agentLink)).toBe(true)
    restarted.close()

    rm(agentLink, { recursive: true, force: true })

    const swept = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: createSkillsCliRunner(),
    })
    expect(existsSync(join(userData, 'mirrors', a.id))).toBe(false)
    swept.close()
  })

  it('does not offer updates from a Disabled Registry or Orphaned Installation', async () => {
    const remoteA = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend, userData } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: a.syncStatus.revision!,
    })

    const { openDatabase } = await import('./db/open')
    const db = openDatabase(join(userData, 'cache.sqlite'))
    db.prepare(
      `UPDATE skill SET head_content_hash = 'deadbeef' WHERE registry_id = ? AND folder_name = 'alpha'`
    ).run(a.id)
    db.close()

    let alpha = (await backend.getCatalogue()).skills.find((s) => s.folderName === 'alpha')
    expect(alpha?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe(
      'update-available'
    )

    await backend.updateRegistry({ id: a.id, enabled: false })
    alpha = (await backend.getCatalogue()).skills.find((s) => s.folderName === 'alpha')
    expect(alpha?.orphaned).toBe(false)
    expect(alpha?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe('installed')

    await backend.updateRegistry({ id: a.id, enabled: true })
    await backend.removeRegistry(a.id)
    alpha = (await backend.getCatalogue()).skills.find((s) => s.folderName === 'alpha')
    expect(alpha?.orphaned).toBe(true)
    expect(alpha?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe('installed')

    backend.close()
  })

  it('allows re-adding a GitHub Registry after soft-remove while an Orphaned Installation remains', async () => {
    const remote = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend, userData } = newBackend(home)
    await withoutDefault(backend)

    const local = await backend.addRegistry({ url: remote, branch: 'main' })
    await backend.install({
      registryId: local.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: local.syncStatus.revision!,
    })

    const { openDatabase } = await import('./db/open')
    const db = openDatabase(join(userData, 'cache.sqlite'))
    db.prepare(
      `UPDATE registry
       SET url = ?, github_owner = ?, github_repo = ?, canonical_key = ?
       WHERE id = ?`
    ).run(
      'https://github.com/example-org/skills-fixture',
      'example-org',
      'skills-fixture',
      'github:example-org/skills-fixture',
      local.id
    )
    db.close()

    await backend.removeRegistry(local.id)
    expect(await backend.listRegistries()).toHaveLength(0)
    expect((await backend.getCatalogue()).skills.some((s) => s.orphaned)).toBe(true)

    const again = await backend.addRegistry({
      url: 'https://github.com/example-org/skills-fixture',
      branch: 'develop',
    })
    expect(again.id).not.toBe(local.id)
    expect(again.branch).toBe('develop')
    expect((await backend.listRegistries()).map((r) => r.id)).toEqual([again.id])

    backend.close()
  })

  it('persists installs and provenance from two Registries across a backend restart', async () => {
    const remoteA = makeRemote(['alpha'])
    const remoteB = makeRemote(['beta'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend, userData } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const b = await backend.addRegistry({ url: remoteB, branch: 'main' })

    const installedA = await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: a.syncStatus.revision!,
    })
    const installedB = await backend.install({
      registryId: b.id,
      folderName: 'beta',
      targets: ['~/.claude/skills'],
      mirrorRevision: b.syncStatus.revision!,
    })
    expect(installedA.perTarget[0]?.outcome).toBe('installed')
    expect(installedB.perTarget[0]?.outcome).toBe('installed')

    backend.close()

    const reopened = reopenBackend(userData, home)
    const catalogue = await reopened.getCatalogue()

    const alpha = catalogue.skills.find((s) => s.folderName === 'alpha')
    const beta = catalogue.skills.find((s) => s.folderName === 'beta')
    expect(alpha?.registryId).toBe(a.id)
    expect(beta?.registryId).toBe(b.id)
    expect(alpha?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe('installed')
    expect(beta?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe('installed')

    const { openDatabase } = await import('./db/open')
    const db = openDatabase(join(userData, 'cache.sqlite'))
    const { readInstallRecords } = await import('./installer/records')
    const records = readInstallRecords(db)
    db.close()
    expect(records).toHaveLength(2)
    expect(records.find((r) => r.folderName === 'alpha')?.registryId).toBe(a.id)
    expect(records.find((r) => r.folderName === 'alpha')?.provenanceSha).toBe(
      installedA.provenanceSha
    )
    expect(records.find((r) => r.folderName === 'beta')?.registryId).toBe(b.id)
    expect(records.find((r) => r.folderName === 'beta')?.provenanceSha).toBe(
      installedB.provenanceSha
    )

    reopened.close()
  })

  it('blocks install when an unmanaged external folder occupies the target and does not overwrite it', async () => {
    const remoteA = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    const externalDir = join(home, '.claude', 'skills', 'alpha')
    mkdirSync(externalDir, { recursive: true })
    const externalMarker = join(externalDir, 'HAND_MADE.md')
    writeFileSync(externalMarker, 'external content the app must not touch', 'utf8')
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })

    await expect(
      backend.install({
        registryId: a.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: a.syncStatus.revision!,
      })
    ).rejects.toBeInstanceOf(InstallationCollisionError)

    expect(existsSync(externalMarker)).toBe(true)
    expect(readFileSync(externalMarker, 'utf8')).toBe('external content the app must not touch')

    backend.close()
  })

  it('allows the same folder name from different Registries on different targets (per-target independence)', async () => {
    const remoteA = makeRemote(['alpha'])
    const remoteB = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const b = await backend.addRegistry({ url: remoteB, branch: 'main' })

    const installedA = await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: a.syncStatus.revision!,
    })
    const installedB = await backend.install({
      registryId: b.id,
      folderName: 'alpha',
      targets: ['~/.agents/skills'],
      mirrorRevision: b.syncStatus.revision!,
    })

    expect(installedA.perTarget[0]?.outcome).toBe('installed')
    expect(installedB.perTarget[0]?.outcome).toBe('installed')

    backend.close()
  })

  it('reports a target held by another Registry and installs to the other targets', async () => {
    const remoteA = makeRemote(['alpha'])
    const remoteB = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const b = await backend.addRegistry({ url: remoteB, branch: 'main' })
    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: a.syncStatus.revision!,
    })

    const before = await backend.reconcile({ registryId: b.id, folderName: 'alpha' })
    expect(Object.fromEntries(before.entries.map((e) => [e.target, e.state]))).toEqual({
      '~/.claude/skills': 'other-registry',
      '~/.agents/skills': 'not-installed',
    })

    const installedB = await backend.install({
      registryId: b.id,
      folderName: 'alpha',
      targets: ['~/.agents/skills'],
      mirrorRevision: b.syncStatus.revision!,
    })
    expect(installedB.perTarget.map((t) => [t.target, t.outcome])).toEqual([
      ['~/.agents/skills', 'installed'],
    ])

    const after = await backend.reconcile({ registryId: b.id, folderName: 'alpha' })
    expect(Object.fromEntries(after.entries.map((e) => [e.target, e.state]))).toEqual({
      '~/.claude/skills': 'other-registry',
      '~/.agents/skills': 'installed',
    })
    const ownerA = await backend.reconcile({ registryId: a.id, folderName: 'alpha' })
    expect(ownerA.entries.find((e) => e.target === '~/.claude/skills')?.state).toBe('installed')

    backend.close()
  })

  it('keeps blocking a managed collision from another Registry after a backend restart', async () => {
    const remoteA = makeRemote(['alpha'])
    const remoteB = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend, userData } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const b = await backend.addRegistry({ url: remoteB, branch: 'main' })
    const revB = b.syncStatus.revision!

    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: a.syncStatus.revision!,
    })
    backend.close()

    const reopened = reopenBackend(userData, home)
    await expect(
      reopened.install({
        registryId: b.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: revB,
      })
    ).rejects.toBeInstanceOf(InstallationCollisionError)

    reopened.close()
  })

  it('refuses install and repair from a Disabled Registry while uninstall stays available', async () => {
    const remoteA = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const rev = a.syncStatus.revision!
    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: rev,
    })

    await backend.updateRegistry({ id: a.id, enabled: false })

    await expect(
      backend.install({
        registryId: a.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: rev,
      })
    ).rejects.toThrow(/disabled/i)
    await expect(
      backend.repair({
        registryId: a.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: rev,
      })
    ).rejects.toThrow(/disabled/i)

    const removed = await backend.uninstall({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
    })
    expect(removed.perTarget[0]?.outcome).not.toBe('failed')
    expect(existsSync(join(home, '.claude', 'skills', 'alpha'))).toBe(false)

    backend.close()
  })

  it('refuses install and repair from a soft-removed (orphaned) Registry', async () => {
    const remoteA = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const rev = a.syncStatus.revision!
    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: rev,
    })

    await backend.removeRegistry(a.id)

    await expect(
      backend.install({
        registryId: a.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: rev,
      })
    ).rejects.toThrow()
    await expect(
      backend.repair({
        registryId: a.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: rev,
      })
    ).rejects.toThrow()

    backend.close()
  })

  it('keeps a Registry disabled and installed-only after a backend restart', async () => {
    const remoteA = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend, userData } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const rev = a.syncStatus.revision!
    await backend.install({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: rev,
    })
    await backend.updateRegistry({ id: a.id, enabled: false })
    backend.close()

    const reopened = reopenBackend(userData, home)

    const registries = await reopened.listRegistries()
    expect(registries.find((r) => r.id === a.id)?.enabled).toBe(false)

    const catalogue = await reopened.getCatalogue()
    const alpha = catalogue.skills.find((s) => s.folderName === 'alpha')
    expect(alpha?.orphaned).toBe(false)
    expect(alpha?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe('installed')

    await expect(
      reopened.install({
        registryId: a.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: rev,
      })
    ).rejects.toThrow(/disabled/i)

    const removed = await reopened.uninstall({
      registryId: a.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
    })
    expect(removed.perTarget[0]?.outcome).not.toBe('failed')
    expect(existsSync(join(home, '.claude', 'skills', 'alpha'))).toBe(false)

    reopened.close()
  })

  it('coalesces concurrent syncRegistry calls for the same Registry', async () => {
    const remoteA = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })

    const before = countEvents(backend.telemetry.exportJsonl(), 'sync_completed')
    const [first, second] = await Promise.all([
      backend.syncRegistry(a.id),
      backend.syncRegistry(a.id),
    ])
    const after = countEvents(backend.telemetry.exportJsonl(), 'sync_completed')

    expect(first).toBe(second)
    expect(after - before).toBe(1)

    backend.close()
  })

  it('refreshes more Registries than the concurrency bound and returns a result for each', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-mr-home-'))
    dirs.push(home)
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const count = MAX_CONCURRENT_SYNCS + 2
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const remote = makeRemote([`skill-${i}`])
      const added = await backend.addRegistry({ url: remote, branch: 'main' })
      ids.push(added.id)
    }

    const result = await backend.refresh()
    expect(result.registries).toHaveLength(count)
    expect(result.registries.every((r) => r.phase === 'synced')).toBe(true)
    const folders = (await backend.getCatalogue()).skills.map((s) => s.folderName).sort()
    expect(folders).toEqual(ids.map((_, i) => `skill-${i}`).sort())

    backend.close()
  })
})

describe('bounded sync concurrency primitive (#5)', () => {
  it('never runs more than the limit concurrently and preserves order', async () => {
    const bound = 3
    let active = 0
    let peak = 0
    const items = Array.from({ length: 9 }, (_, i) => i)

    const results = await runWithConcurrency(items, bound, async (item) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return item * 2
    })

    expect(peak).toBeLessThanOrEqual(bound)
    expect(peak).toBe(bound)
    expect(results).toEqual(items.map((i) => i * 2))
  })

  it('pins the global refresh bound at 3', () => {
    expect(MAX_CONCURRENT_SYNCS).toBe(3)
  })
})
