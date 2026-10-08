import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type Backend } from '../backend'
import { createSkillsCliRunner, type RunSkillsCli } from './cli'
import { REVISION_REFUSED_MESSAGE } from './install'
import { readInstallRecords, upsertInstallRecord } from './records'
import { openDatabase } from '../db/open'
import { fakeHomeDetection } from '../fakeHome'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function writeNestedSkill(root: string, category: string, name: string, description: string): void {
  const dir = join(root, 'skills', category, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8'
  )
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

async function withoutDefault(backend: Backend): Promise<void> {
  for (const r of await backend.listRegistries()) await backend.removeRegistry(r.id)
}

/**
 * Ticket 4 seam tests: detectTargets + install through AppApi against temp
 * target dirs (per-target results, copy fallback, revision-refusal).
 */
describe('install core loop (AppApi seam)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeRemote(): { url: string; remote: string; revision: string } {
    const remote = mkdtempSync(join(tmpdir(), 'igs-install-remote-'))
    dirs.push(remote)
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    writeSkill(remote, 'alpha', 'alpha', 'First skill')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'seed')
    const revision = git(remote, 'rev-parse', 'HEAD')
    return { url: remote, remote, revision }
  }

  async function syncedBackend(
    home: string,
    runSkillsCli: RunSkillsCli = createSkillsCliRunner()
  ): Promise<{ backend: Backend; registryId: string; revision: string; userData: string }> {
    const { url, revision } = makeRemote()
    const userData = mkdtempSync(join(tmpdir(), 'igs-install-ud-'))
    dirs.push(userData)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli,
    })
    await withoutDefault(backend)
    const registry = await backend.addRegistry({ url, branch: 'main' })
    expect(registry.syncStatus.phase).toBe('synced')
    expect(registry.syncStatus.revision).toBe(revision)
    return { backend, registryId: registry.id, revision, userData }
  }

  async function targetsHolding(backend: Backend, home: string, name: string): Promise<string[]> {
    return (await backend.detectTargets()).targets
      .map((target) => target.id)
      .filter((id) => existsSync(join(home, id.slice(2), name)))
  }

  function bareBackend(home: string): { backend: Backend; userData: string } {
    const userData = mkdtempSync(join(tmpdir(), 'igs-ud-'))
    dirs.push(userData)
    return {
      backend: createBackend({
        paths: { userData },
        syncIntervalMs: 0,
        homeDir: home,
        ...fakeHomeDetection(home),
      }),
      userData,
    }
  }

  it('detectTargets shows every detected agent and every folder holding installs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    for (const folder of ['.claude', '.cursor', '.codex', '.config/goose']) {
      mkdirSync(join(home, folder), { recursive: true })
    }
    const unclaimed = mkdtempSync(join(tmpdir(), 'igs-unclaimed-'))
    dirs.push(unclaimed)
    const { backend, userData } = bareBackend(home)
    const db = openDatabase(join(userData, 'cache.sqlite'))
    for (const target of ['~/.codeium/windsurf/skills', '~/.cursor/skills', unclaimed]) {
      upsertInstallRecord(db, {
        target,
        folderName: 'alpha',
        registryId: 'reg-a',
        contentHash: 'hash',
        provenanceSha: 'sha',
        method: 'copy',
        paths: [],
        cliVersion: '1.7.0',
        installedAt: '2026-01-01T00:00:00.000Z',
      })
    }
    db.close()

    const visible = (await backend.detectTargets()).targets
      .filter((target) => target.visible)
      .map(({ id, label, shared }) => ({ id, label, shared }))

    expect(visible).toEqual([
      { id: '~/.claude/skills', label: 'Claude Code', shared: false },
      { id: '~/.config/goose/skills', label: 'Goose', shared: false },
      { id: '~/.codeium/windsurf/skills', label: 'Windsurf', shared: false },
      { id: '~/.agents/skills', label: 'Codex, Cursor', shared: true },
      { id: '~/.cursor/skills', label: 'Cursor', shared: false },
      { id: unclaimed, label: unclaimed, shared: false },
    ])
    backend.close()
  })

  it('detectTargets reads agent folders from the environment and filesystem it is given', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    const userData = mkdtempSync(join(tmpdir(), 'igs-ud-'))
    dirs.push(userData)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      env: { CLAUDE_CONFIG_DIR: join(home, 'claude-alt') },
      exists: (path) => path === join(home, 'claude-alt'),
    })

    const visible = (await backend.detectTargets()).targets
      .filter((target) => target.visible)
      .map((target) => target.id)

    expect(visible).toEqual(['~/claude-alt/skills'])
    backend.close()
  })

  it('detectTargets shows the Shared Target as "Shared folder" only while it holds installs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend, userData } = bareBackend(home)

    const before = (await backend.detectTargets()).targets.find((target) => target.shared)
    expect([before?.label, before?.visible]).toEqual(['Shared folder', false])

    const db = openDatabase(join(userData, 'cache.sqlite'))
    upsertInstallRecord(db, {
      target: '~/.agents/skills',
      folderName: 'alpha',
      registryId: 'reg-a',
      contentHash: 'hash',
      provenanceSha: 'sha',
      method: 'copy',
      paths: [],
      cliVersion: '1.7.0',
      installedAt: '2026-01-01T00:00:00.000Z',
    })
    db.close()

    const after = (await backend.detectTargets()).targets.find((target) => target.shared)
    expect([after?.label, after?.visible]).toEqual(['Shared folder', true])
    backend.close()
  })

  it('detectTargets labels a target by every agent it serves', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    for (const folder of ['.cline', '.codex', '.cursor', '.deepagents', '.zencoder']) {
      mkdirSync(join(home, folder), { recursive: true })
    }
    const { backend } = bareBackend(home)

    const labels = (await backend.detectTargets()).targets
      .filter((target) => target.visible)
      .map((target) => target.label)

    expect(labels).toEqual(
      expect.arrayContaining(['Cline, Codex, Cursor, Deep Agents', 'Zencoder, Zenflow'])
    )
    backend.close()
  })

  it('detectTargets serves agents that share a folder from one target', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.zencoder'), { recursive: true })
    const { backend } = bareBackend(home)

    const zencoder = (await backend.detectTargets()).targets.filter(
      (target) => target.id === '~/.zencoder/skills'
    )

    expect(zencoder).toEqual([
      {
        id: '~/.zencoder/skills',
        label: 'Zencoder, Zenflow',
        shared: false,
        visible: true,
        agents: [
          { id: 'zencoder', displayName: 'Zencoder', detected: true },
          { id: 'zenflow', displayName: 'Zenflow', detected: true },
        ],
      },
    ])
    backend.close()
  })

  it('detectTargets lists every supported agent with its target and detection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    for (const folder of ['.claude', '.config/goose']) {
      mkdirSync(join(home, folder), { recursive: true })
    }
    const { backend } = bareBackend(home)

    const { agents } = await backend.detectTargets()

    expect(agents).toEqual(
      expect.arrayContaining([
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          target: '~/.claude/skills',
          detected: true,
        },
        { id: 'goose', displayName: 'Goose', target: '~/.config/goose/skills', detected: true },
        { id: 'cursor', displayName: 'Cursor', target: '~/.agents/skills', detected: false },
      ])
    )
    const ids = agents.map((agent) => agent.id)
    for (const excluded of ['universal', 'eve', 'promptscript']) {
      expect(ids).not.toContain(excluded)
    }
    backend.close()
  })

  it('keeps install records for a folder no detected agent uses', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    const elsewhere = mkdtempSync(join(tmpdir(), 'igs-elsewhere-'))
    dirs.push(elsewhere)
    const { backend, userData } = bareBackend(home)
    const record = {
      target: elsewhere,
      folderName: 'alpha',
      registryId: 'reg-a',
      contentHash: 'hash',
      provenanceSha: 'sha',
      method: 'copy' as const,
      paths: [join(elsewhere, 'alpha')],
      cliVersion: '1.7.0',
      installedAt: '2026-01-01T00:00:00.000Z',
    }

    const db = openDatabase(join(userData, 'cache.sqlite'))
    upsertInstallRecord(db, record)
    expect(readInstallRecords(db)).toEqual([record])
    db.close()

    expect((await backend.detectTargets()).targets.find((t) => t.id === elsewhere)).toEqual({
      id: elsewhere,
      label: elsewhere,
      shared: false,
      visible: true,
      agents: [],
    })
    backend.close()
  })

  it('installs to Claude Code as a real copy in its own folder only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.agents'), { recursive: true })

    const { backend, registryId, revision, userData } = await syncedBackend(home)

    const result = await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revision,
    })

    const installed = join(home, '.claude', 'skills', 'alpha')
    expect(result.perTarget).toEqual([
      { target: '~/.claude/skills', outcome: 'installed', method: 'copy', paths: [installed] },
    ])
    expect(lstatSync(installed).isDirectory()).toBe(true)
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.agents', 'skills', 'alpha'))).toBe(false)

    const db = openDatabase(join(userData, 'cache.sqlite'))
    const records = readInstallRecords(db, { folderName: 'alpha' })
    expect(records.map((r) => [r.target, r.method, r.paths])).toEqual([
      ['~/.claude/skills', 'copy', [installed]],
    ])
    db.close()
    backend.close()
  })

  it('installs to Cursor as a copy in the Shared Target only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })

    const { backend, registryId, revision, userData } = await syncedBackend(home)

    const result = await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.agents/skills'],
      mirrorRevision: revision,
    })

    const installed = join(home, '.agents', 'skills', 'alpha')
    expect(result.perTarget).toEqual([
      { target: '~/.agents/skills', outcome: 'installed', method: 'copy', paths: [installed] },
    ])
    expect(lstatSync(installed).isDirectory()).toBe(true)
    expect(existsSync(join(home, '.cursor', 'skills', 'alpha'))).toBe(false)
    expect(await targetsHolding(backend, home, 'alpha')).toEqual(['~/.agents/skills'])

    const db = openDatabase(join(userData, 'cache.sqlite'))
    const records = readInstallRecords(db, { folderName: 'alpha' })
    expect(records.map((r) => [r.target, r.method, r.paths])).toEqual([
      ['~/.agents/skills', 'copy', [installed]],
    ])
    db.close()
    backend.close()
  })

  it('installs to Goose as a real copy in its own folder and nowhere else', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    for (const folder of ['.claude', '.cursor', '.config/goose']) {
      mkdirSync(join(home, folder), { recursive: true })
    }

    const { backend, registryId, revision } = await syncedBackend(home)

    const result = await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.config/goose/skills'],
      mirrorRevision: revision,
    })

    const installed = join(home, '.config', 'goose', 'skills', 'alpha')
    expect(result.perTarget).toEqual([
      {
        target: '~/.config/goose/skills',
        outcome: 'installed',
        method: 'copy',
        paths: [installed],
      },
    ])
    expect(lstatSync(installed).isDirectory()).toBe(true)
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true)
    expect(await targetsHolding(backend, home, 'alpha')).toEqual(['~/.config/goose/skills'])
    backend.close()
  })

  it.each([
    [['.claude', 'skills'], '~/.claude/skills', '~/.agents/skills', ['.agents', 'skills']],
    [['.agents', 'skills'], '~/.agents/skills', '~/.claude/skills', ['.claude', 'skills']],
  ] as const)(
    'an outside skill in ~/%s blocks %s but not %s',
    async (outsideFolder, blocked, allowed, allowedFolder) => {
      const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
      dirs.push(home)
      mkdirSync(join(home, '.claude'), { recursive: true })
      const outside = join(home, ...outsideFolder, 'alpha')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'SKILL.md'), 'outside this app', 'utf8')

      const { backend, registryId, revision } = await syncedBackend(home)

      await expect(
        backend.install({
          registryId,
          folderName: 'alpha',
          targets: [blocked],
          mirrorRevision: revision,
        })
      ).rejects.toThrow(/outside this app/)

      const result = await backend.install({
        registryId,
        folderName: 'alpha',
        targets: [allowed],
        mirrorRevision: revision,
      })
      expect(result.perTarget[0]?.outcome).toBe('installed')
      expect(existsSync(join(home, ...allowedFolder, 'alpha', 'SKILL.md'))).toBe(true)
      expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('outside this app')

      backend.close()
    }
  )

  it('installs per-target from the local mirror and persists install_record', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })

    const { backend, registryId, revision, userData } = await syncedBackend(home)

    const result = await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills', '~/.agents/skills'],
      mirrorRevision: revision,
    })

    expect(result.registryId).toBe(registryId)
    expect(result.folderName).toBe('alpha')
    expect(result.skillId).toBe(`${registryId}/alpha`)
    expect(result.mirrorRevision).toBe(revision)
    expect(result.cliVersion).toBe('1.7.0')
    expect(result.contentHash).toBeTruthy()
    expect(result.provenanceSha).toBeTruthy()
    expect(result.perTarget).toHaveLength(2)

    expect(result.perTarget).toEqual([
      {
        target: '~/.claude/skills',
        outcome: 'installed',
        method: 'copy',
        paths: [join(home, '.claude', 'skills', 'alpha')],
      },
      {
        target: '~/.agents/skills',
        outcome: 'installed',
        method: 'copy',
        paths: [join(home, '.agents', 'skills', 'alpha')],
      },
    ])
    expect(lstatSync(join(home, '.claude', 'skills', 'alpha')).isDirectory()).toBe(true)
    expect(lstatSync(join(home, '.agents', 'skills', 'alpha')).isDirectory()).toBe(true)
    expect(existsSync(join(home, '.cursor', 'skills', 'alpha'))).toBe(false)

    const db = openDatabase(join(userData, 'cache.sqlite'))
    const records = readInstallRecords(db, { folderName: 'alpha' })
    expect(records).toHaveLength(2)
    expect(records.every((r) => r.cliVersion === '1.7.0')).toBe(true)
    expect(records.every((r) => r.registryId === registryId)).toBe(true)
    expect(records.every((r) => r.contentHash === result.contentHash)).toBe(true)
    db.close()

    const catalogue = await backend.getCatalogue()
    const skill = catalogue.skills.find((s) => s.folderName === 'alpha')
    expect(skill?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe('installed')
    expect(skill?.perTarget.find((p) => p.target === '~/.agents/skills')?.state).toBe('installed')

    backend.close()
  })

  it('refuses install when mirrorRevision no longer matches HEAD', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })

    const { backend, registryId, revision } = await syncedBackend(home)

    await expect(
      backend.install({
        registryId,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: revision.replace(/.$/, revision.endsWith('a') ? 'b' : 'a'),
      })
    ).rejects.toThrow(REVISION_REFUSED_MESSAGE)

    backend.close()
  })

  it('partial install: one target can succeed while another fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })

    const { backend, registryId, revision } = await syncedBackend(home, async (args, opts) => {
      const targetIdx = args.indexOf('-a')
      const target = args[targetIdx + 1]
      if (target === 'universal') {
        return { code: 1, stdout: '', stderr: 'cursor install boom' }
      }
      const skillId = args[args.indexOf('--skill') + 1]!
      const dest = join(opts.home, '.claude', 'skills', skillId)
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), '---\nname: Alpha\ndescription: x\n---\n', 'utf8')
      return { code: 0, stdout: 'ok', stderr: '' }
    })

    const result = await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills', '~/.agents/skills'],
      mirrorRevision: revision,
    })

    const claude = result.perTarget.find((t) => t.target === '~/.claude/skills')
    const cursor = result.perTarget.find((t) => t.target === '~/.agents/skills')
    expect(claude?.outcome).toBe('installed')
    expect(claude?.method).toBe('copy')
    expect(cursor?.outcome).toBe('failed')
    expect(cursor?.error).toMatch(/cursor install boom/)

    backend.close()
  })

  it('refuses install from a stale snapshot unless acknowledgeStale is set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })

    const { url, remote, revision } = makeRemote()
    const userData = mkdtempSync(join(tmpdir(), 'igs-install-ud-'))
    dirs.push(userData)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: createSkillsCliRunner(),
    })
    await withoutDefault(backend)
    const registry = await backend.addRegistry({ url, branch: 'main' })
    expect(registry.syncStatus.phase).toBe('synced')

    rmSync(remote, { recursive: true, force: true })
    dirs.splice(dirs.indexOf(remote), 1)
    const status = await backend.syncRegistry(registry.id)
    expect(status.stale).toBe(true)

    await expect(
      backend.install({
        registryId: registry.id,
        folderName: 'alpha',
        targets: ['~/.claude/skills'],
        mirrorRevision: revision,
      })
    ).rejects.toThrow(/stale/i)

    const installed = await backend.install({
      registryId: registry.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revision,
      acknowledgeStale: true,
    })
    expect(installed.perTarget[0]?.outcome).toBe('installed')
    expect(installed.mirrorRevision).toBe(revision)

    backend.close()
  })

  it('installs a nested-layout skill when folderName matches the frontmatter install key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })

    const remote = mkdtempSync(join(tmpdir(), 'igs-nested-install-remote-'))
    dirs.push(remote)
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    writeNestedSkill(remote, 'engineering', 'code-review', 'Review code')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'nested')
    const revision = git(remote, 'rev-parse', 'HEAD')
    const url = remote

    const userData = mkdtempSync(join(tmpdir(), 'igs-install-ud-'))
    dirs.push(userData)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: createSkillsCliRunner(),
    })
    await withoutDefault(backend)
    const registry = await backend.addRegistry({ url, branch: 'main' })
    expect(registry.syncStatus.phase).toBe('synced')

    const result = await backend.install({
      registryId: registry.id,
      folderName: 'code-review',
      targets: ['~/.claude/skills'],
      mirrorRevision: revision,
    })

    expect(result.folderName).toBe('code-review')
    expect(result.perTarget[0]?.outcome).toBe('installed')
    expect(existsSync(join(home, '.claude', 'skills', 'code-review', 'SKILL.md'))).toBe(true)

    backend.close()
  })
})
