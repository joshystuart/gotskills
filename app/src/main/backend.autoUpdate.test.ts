import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type Backend, type BackendOptions } from './backend'
import { createSkillsCliRunner } from './installer/cli'
import { readInstallRecords, upsertInstallRecord } from './installer/records'
import { openDatabase } from './db/open'
import { syncRegistry } from './sync'
import type { AutoUpdateResult, RegistryRecord } from '../shared/ipc'
import { fakeHomeDetection } from './fakeHome'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function writeSkill(remote: string, folderName: string, description: string): void {
  const path = join(remote, 'skills', folderName)
  mkdirSync(path, { recursive: true })
  writeFileSync(
    join(path, 'SKILL.md'),
    `---\nname: ${folderName}\ndescription: ${description}\n---\n\n# ${folderName}\n`
  )
}

function pausePoint() {
  let start!: () => void
  let resume!: () => void
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  const resumed = new Promise<void>((resolve) => {
    resume = resolve
  })
  return {
    started,
    resume,
    wait: async () => {
      start()
      await resumed
    },
  }
}

describe('Registry Auto Update', () => {
  const dirs: string[] = []
  const backends: Backend[] = []

  afterEach(() => {
    for (const backend of backends.splice(0)) backend.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  async function setup(ids = ['alpha'], options: Partial<BackendOptions> = {}) {
    const remote = temp('igs-au-remote-')
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    for (const id of ids) writeSkill(remote, id, 'original')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'seed')
    const home = temp('igs-au-home-')
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const results: AutoUpdateResult[] = []
    const userData = temp('igs-au-ud-')
    const backend = createBackend({
      paths: { userData },
      homeDir: home,
      ...fakeHomeDetection(home),
      syncIntervalMs: 0,
      runSkillsCli: createSkillsCliRunner(),
      onAutoUpdateResult: (result) => results.push(result),
      ...options,
    })
    backends.push(backend)
    for (const registry of await backend.listRegistries()) await backend.removeRegistry(registry.id)
    const registry = await backend.addRegistry({ url: remote, branch: 'main' })
    return { backend, registry, remote, home, userData, results }
  }

  async function install(
    backend: Backend,
    registry: RegistryRecord,
    folderName = 'alpha',
    targets: string[] = ['~/.claude/skills']
  ) {
    return backend.install({
      registryId: registry.id,
      folderName,
      targets,
      mirrorRevision: registry.syncStatus.revision!,
    })
  }

  function change(remote: string, ids = ['alpha']) {
    for (const id of ids) writeSkill(remote, id, 'changed')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'change skills')
  }

  async function state(
    backend: Backend,
    registryId: string,
    folderName = 'alpha',
    target = '~/.claude/skills'
  ) {
    const report = await backend.reconcile({ registryId, folderName })
    return report.entries.find((entry) => entry.target === target)!
  }

  function copyIntoUndetectedTarget(home: string, userData: string, folderName = 'alpha'): string {
    const target = temp('igs-au-undetected-')
    cpSync(join(home, '.claude', 'skills', folderName), join(target, folderName), {
      recursive: true,
    })
    const db = openDatabase(join(userData, 'cache.sqlite'))
    const [claude] = readInstallRecords(db, { folderName })
    upsertInstallRecord(db, { ...claude, target, paths: [join(target, folderName)] })
    db.close()
    return target
  }

  it('Auto Update brings an out-of-date install in an undetected target current', async () => {
    const { backend, registry, remote, home, userData, results } = await setup()
    await install(backend, registry)
    const undetected = copyIntoUndetectedTarget(home, userData)
    await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    change(remote)
    await backend.syncRegistry(registry.id)

    expect(results).toEqual([
      expect.objectContaining({
        updated: [
          { folderName: 'alpha', name: 'alpha', targets: ['~/.claude/skills', undetected] },
        ],
        failed: [],
      }),
    ])
    expect((await state(backend, registry.id, 'alpha', undetected)).state).toBe('installed')
    expect(readFileSync(join(undetected, 'alpha', 'SKILL.md'), 'utf8')).toContain(
      'description: changed'
    )
  })

  it('Update all brings an out-of-date install in an undetected target current', async () => {
    const { backend, registry, remote, home, userData } = await setup()
    await install(backend, registry)
    const undetected = copyIntoUndetectedTarget(home, userData)
    change(remote)
    await backend.syncRegistry(registry.id)
    const behind = (await backend.getCatalogue()).skills[0].perTarget
      .filter((target) => target.state === 'update-available')
      .map((target) => target.target)
    expect(behind).toEqual(['~/.claude/skills', undetected])
    const synced = (await backend.listRegistries()).find((entry) => entry.id === registry.id)!

    await backend.repair({
      registryId: registry.id,
      folderName: 'alpha',
      targets: behind,
      mirrorRevision: synced.syncStatus.revision!,
    })

    expect((await state(backend, registry.id, 'alpha', undetected)).state).toBe('installed')
    expect(readFileSync(join(undetected, 'alpha', 'SKILL.md'), 'utf8')).toContain(
      'description: changed'
    )
  })

  it('updates only a behind target and leaves current, uninstalled, broken, removed and occupied skills alone', async () => {
    const { backend, registry, remote, home, results } = await setup([
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
    ])
    await install(backend, registry, 'alpha', ['~/.claude/skills', '~/.agents/skills'])
    await install(backend, registry, 'beta')
    await install(backend, registry, 'epsilon')
    rmSync(join(home, '.claude', 'skills', 'beta'), { recursive: true, force: true })
    const external = join(home, '.claude', 'skills', 'delta')
    mkdirSync(external, { recursive: true })
    writeFileSync(join(external, 'SKILL.md'), 'outside this app')
    const otherRemote = temp('igs-au-other-')
    git(otherRemote, 'clone', remote, '.')
    const other = await backend.addRegistry({ url: otherRemote, branch: 'main' })
    await install(backend, other, 'gamma')
    change(remote, ['alpha', 'beta', 'gamma', 'delta', 'zeta'])
    rmSync(join(remote, 'skills', 'epsilon'), { recursive: true })
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'remove epsilon')
    await backend.syncRegistry(registry.id)
    const synced = (await backend.listRegistries()).find((entry) => entry.id === registry.id)!
    await install(backend, synced, 'alpha', ['~/.agents/skills'])
    await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    expect(results).toEqual([
      expect.objectContaining({
        updated: [{ folderName: 'alpha', name: 'alpha', targets: ['~/.claude/skills'] }],
        failed: [],
      }),
    ])
    expect((await state(backend, registry.id, 'alpha')).state).toBe('installed')
    expect((await state(backend, registry.id, 'alpha', '~/.agents/skills')).state).toBe('installed')
    expect((await state(backend, registry.id, 'beta')).state).toBe('needs-repair')
    expect((await state(backend, registry.id, 'gamma')).state).toBe('other-registry')
    expect((await state(backend, other.id, 'gamma')).state).toBe('installed')
    expect((await state(backend, registry.id, 'delta')).state).toBe('external')
    expect(readFileSync(join(external, 'SKILL.md'), 'utf8')).toBe('outside this app')
    expect((await state(backend, registry.id, 'epsilon')).state).toBe('removed-from-registry')
    expect((await state(backend, registry.id, 'zeta')).state).toBe('not-installed')
  })

  it('reports busy while an installation runs without putting it in the sync status', async () => {
    const pause = pausePoint()
    const runner = createSkillsCliRunner()
    const { backend, registry } = await setup(['alpha'], {
      runSkillsCli: async (args, options) => {
        await pause.wait()
        return runner(args, options)
      },
    })
    expect(backend.isBusy()).toBe(false)
    const installation = install(backend, registry)
    await pause.started
    expect(backend.isBusy()).toBe(true)
    expect(await backend.getSyncStatus()).not.toHaveProperty('busy')
    pause.resume()
    await installation
    expect(backend.isBusy()).toBe(false)
    expect(await backend.getSyncStatus()).not.toHaveProperty('busy')
  })

  it('publishes no sync status when an installation or uninstallation starts or finishes', async () => {
    let syncStatusUpdates = 0
    const { backend, registry } = await setup(['alpha'], {
      onSyncStatus: () => syncStatusUpdates++,
    })
    syncStatusUpdates = 0
    await install(backend, registry)
    await backend.uninstall({
      registryId: registry.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
    })
    expect(syncStatusUpdates).toBe(0)
  })

  it('signals busy when an installation starts and idle when it finishes', async () => {
    const pause = pausePoint()
    const runner = createSkillsCliRunner()
    const busyChanges: boolean[] = []
    const { backend, registry } = await setup(['alpha'], {
      onBusyChange: (busy) => busyChanges.push(busy),
      runSkillsCli: async (args, options) => {
        await pause.wait()
        return runner(args, options)
      },
    })
    busyChanges.length = 0
    const installation = install(backend, registry)
    await pause.started
    expect(busyChanges).toEqual([true])
    pause.resume()
    await installation
    expect(busyChanges).toEqual([true, false])
  })

  it('signals busy when a sync starts and idle only after its auto update finishes', async () => {
    let pauseUpdates = false
    const pause = pausePoint()
    const realRunner = createSkillsCliRunner()
    const busyChanges: boolean[] = []
    const { backend, registry, remote } = await setup(['alpha'], {
      onBusyChange: (busy) => busyChanges.push(busy),
      runSkillsCli: async (args, options) => {
        if (pauseUpdates) {
          await pause.wait()
        }
        return realRunner(args, options)
      },
    })
    await install(backend, registry)
    await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    change(remote, ['alpha'])
    pauseUpdates = true
    busyChanges.length = 0
    const sync = backend.syncRegistry(registry.id)
    await pause.started
    expect(busyChanges).toEqual([true])
    pause.resume()
    await sync
    expect(busyChanges).toEqual([true, false])
  })

  it('serializes removal with an active auto update and never reinstalls a pending skill', async () => {
    let pauseUpdates = false
    const pause = pausePoint()
    const realRunner = createSkillsCliRunner()
    const { backend, registry, remote, results } = await setup(['alpha', 'beta'], {
      runSkillsCli: async (args, options) => {
        if (pauseUpdates && args[args.indexOf('--skill') + 1] === 'alpha') {
          await pause.wait()
        }
        return realRunner(args, options)
      },
    })
    await install(backend, registry, 'alpha')
    await install(backend, registry, 'beta')
    await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    change(remote, ['alpha', 'beta'])
    pauseUpdates = true
    const sync = backend.syncRegistry(registry.id)
    await pause.started
    expect(backend.isBusy()).toBe(true)
    expect(await backend.getSyncStatus()).not.toHaveProperty('busy')
    const activeRemoval = backend.uninstall({
      registryId: registry.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
    })
    const removal = backend.uninstall({
      registryId: registry.id,
      folderName: 'beta',
      targets: ['~/.claude/skills'],
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    pause.resume()
    await Promise.all([sync, activeRemoval, removal])
    expect(backend.isBusy()).toBe(false)
    expect(await backend.getSyncStatus()).not.toHaveProperty('busy')
    expect((await state(backend, registry.id, 'alpha')).state).toBe('not-installed')
    expect((await state(backend, registry.id, 'beta')).state).toBe('not-installed')
    expect(results).toEqual([
      expect.objectContaining({
        updated: [{ folderName: 'alpha', name: 'alpha', targets: ['~/.claude/skills'] }],
        failed: [],
      }),
    ])
  })

  it('skips pending targets that become broken or are updated manually during another auto update', async () => {
    let pauseUpdates = false
    const pause = pausePoint()
    const realRunner = createSkillsCliRunner()
    const { backend, registry, remote, home, results } = await setup(['alpha', 'beta', 'gamma'], {
      runSkillsCli: async (args, options) => {
        if (pauseUpdates && args[args.indexOf('--skill') + 1] === 'alpha') {
          await pause.wait()
        }
        return realRunner(args, options)
      },
    })
    await install(backend, registry, 'alpha')
    await install(backend, registry, 'beta')
    await install(backend, registry, 'gamma')
    await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    change(remote, ['alpha', 'beta', 'gamma'])
    pauseUpdates = true
    const sync = backend.syncRegistry(registry.id)
    await pause.started
    rmSync(join(home, '.claude', 'skills', 'gamma'), { recursive: true, force: true })
    const synced = (await backend.listRegistries()).find((entry) => entry.id === registry.id)!
    const manualUpdate = backend.repair({
      registryId: registry.id,
      folderName: 'beta',
      targets: ['~/.claude/skills'],
      mirrorRevision: synced.syncStatus.revision!,
    })
    pause.resume()
    await Promise.all([sync, manualUpdate])
    expect((await state(backend, registry.id, 'beta')).state).toBe('installed')
    expect((await state(backend, registry.id, 'gamma')).state).toBe('needs-repair')
    expect(results).toEqual([
      expect.objectContaining({
        updated: [{ folderName: 'alpha', name: 'alpha', targets: ['~/.claude/skills'] }],
        failed: [],
      }),
    ])
    const updates = backend.telemetry
      .exportJsonl()
      .split('\n')
      .filter(
        (line) =>
          line.includes('"event_type":"install_requested"') && line.includes('"action":"update"')
      )
    expect(updates).toHaveLength(2)
  })

  it('leaves a behind install untouched and emits no result after a failed sync', async () => {
    let fail = false
    const { backend, registry, remote, home, results } = await setup(['alpha'], {
      syncRegistryImpl: (db, config) => {
        if (fail) throw new Error('network unavailable')
        return syncRegistry(db, config)
      },
    })
    const original = await install(backend, registry)
    change(remote)
    await backend.syncRegistry(registry.id)
    expect((await state(backend, registry.id)).state).toBe('update-available')
    fail = true
    const enabled = await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    expect(enabled.syncStatus.phase).toBe('failed')
    expect((await state(backend, registry.id)).installedHash).toBe(original.contentHash)
    expect(readFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain(
      'description: original'
    )
    expect(results).toEqual([])
  })

  it('continues after a failed skill, reports redacted failures, and retries on the next successful sync', async () => {
    let fail = false
    const realRunner = createSkillsCliRunner()
    const { backend, registry, remote, results } = await setup(['beta', 'alpha'], {
      runSkillsCli: (args, options) => {
        if (fail && args[args.indexOf('--skill') + 1] === 'alpha') {
          return Promise.resolve({ code: 1, stdout: '', stderr: 'denied at /Users/private/secret' })
        }
        return realRunner(args, options)
      },
    })
    await install(backend, registry, 'beta')
    await install(backend, registry, 'alpha')
    await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    change(remote, ['beta', 'alpha'])
    fail = true
    await backend.refresh()
    expect(
      (await backend.getCatalogue()).skills.find((skill) => skill.folderName === 'beta')?.perTarget
    ).toContainEqual(expect.objectContaining({ target: '~/.claude/skills', state: 'installed' }))
    expect((await state(backend, registry.id, 'beta')).state).toBe('installed')
    expect((await state(backend, registry.id, 'alpha')).state).toBe('update-available')
    expect(results).toEqual([
      expect.objectContaining({
        updated: [{ folderName: 'beta', name: 'beta', targets: ['~/.claude/skills'] }],
        failed: [{ folderName: 'alpha', name: 'alpha', reason: 'denied at ~' }],
      }),
    ])
    await backend.syncRegistry(registry.id)
    expect(results[1]).toMatchObject({
      updated: [],
      failed: [{ folderName: 'alpha', name: 'alpha', reason: 'denied at ~' }],
    })
    fail = false
    await backend.syncRegistry(registry.id)
    expect((await state(backend, registry.id, 'alpha')).state).toBe('installed')
    expect(results[2]).toMatchObject({
      updated: [{ folderName: 'alpha', name: 'alpha', targets: ['~/.claude/skills'] }],
      failed: [],
    })
  })

  it('leaves updates pending while off and turning it off saves the setting without syncing or changing installs', async () => {
    const { backend, registry, remote, home, results } = await setup()
    const original = await install(backend, registry)
    change(remote)
    await backend.syncRegistry(registry.id)
    expect((await state(backend, registry.id)).state).toBe('update-available')
    expect((await state(backend, registry.id)).installedHash).toBe(original.contentHash)
    expect(results).toEqual([])
    await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    expect((await state(backend, registry.id)).state).toBe('installed')
    const before = readFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')
    writeSkill(remote, 'alpha', 'another change')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'another change')
    const syncs = backend.telemetry
      .exportJsonl()
      .split('\n')
      .filter((line) => line.includes('"event_type":"sync_completed"')).length
    await backend.updateRegistry({ id: registry.id, autoUpdate: false })
    expect(
      backend.telemetry
        .exportJsonl()
        .split('\n')
        .filter((line) => line.includes('"event_type":"sync_completed"'))
    ).toHaveLength(syncs)
    expect(readFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe(before)
    await backend.refresh()
    expect((await state(backend, registry.id)).state).toBe('update-available')
    expect(results).toHaveLength(1)
  })

  it('keeps disabled and orphaned installs unchanged, applying pending updates only when re-enabled', async () => {
    const { backend, registry, remote, home, results } = await setup()
    const original = await install(backend, registry)
    await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    await backend.updateRegistry({ id: registry.id, enabled: false })
    change(remote)
    await backend.syncRegistry(registry.id)
    await backend.refresh()
    expect((await state(backend, registry.id)).installedHash).toBe(original.contentHash)
    expect(results).toEqual([])
    await backend.updateRegistry({ id: registry.id, enabled: true })
    expect((await state(backend, registry.id)).installedHash).not.toBe(original.contentHash)
    expect(results).toHaveLength(1)
    const before = readFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')
    await backend.removeRegistry(registry.id)
    writeSkill(remote, 'alpha', 'orphaned change')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'change after removal')
    await backend.syncRegistry(registry.id)
    await backend.refresh()
    expect(readFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe(before)
    expect(results).toHaveLength(1)
    expect((await backend.getCatalogue()).skills[0]).toMatchObject({ orphaned: true })
  })

  it('awaits coalesced sync updates, records the new hash and update telemetry, and reports nothing on a no-op', async () => {
    const { backend, registry, remote, home, results } = await setup()
    const original = await install(backend, registry)
    await backend.updateRegistry({ id: registry.id, autoUpdate: true })
    expect(results).toEqual([])
    change(remote)
    await Promise.all([backend.syncRegistry(registry.id), backend.syncRegistry(registry.id)])
    expect((await backend.getCatalogue()).skills[0].perTarget).toContainEqual(
      expect.objectContaining({ target: '~/.claude/skills', state: 'installed' })
    )
    const entry = await state(backend, registry.id)
    expect(entry.state).toBe('installed')
    expect(entry.installedHash).not.toBe(original.contentHash)
    expect(entry.installedHash).toBe(entry.mirrorHash)
    expect(readFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain(
      'description: changed'
    )
    expect(results).toEqual([
      {
        registryId: registry.id,
        registryLabel: remote,
        updated: [{ folderName: 'alpha', name: 'alpha', targets: ['~/.claude/skills'] }],
        failed: [],
      },
    ])
    const telemetry = backend.telemetry
      .exportJsonl()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(
      telemetry.filter(
        (event) => event.event_type === 'install_requested' && event.action === 'update'
      )
    ).toHaveLength(1)
    expect(
      telemetry.filter(
        (event) => event.event_type === 'install_target_completed' && event.action === 'update'
      )
    ).toHaveLength(1)
    await backend.refresh()
    expect(results).toHaveLength(1)
  })
})
