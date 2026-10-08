import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type Backend } from '../backend'
import { openDatabase } from '../db/open'
import { createSkillsCliRunner } from './cli'
import { readInstallRecords } from './records'
import { fakeHomeDetection } from '../fakeHome'

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

async function withoutDefault(backend: Backend): Promise<void> {
  for (const r of await backend.listRegistries()) await backend.removeRegistry(r.id)
}

/**
 * Ticket 5 seam tests: reconcile / repair / uninstall through AppApi against
 * temp target dirs (six states, read-only reconcile, soft-delete treatment).
 */
describe('reconciliation & lifecycle (AppApi seam)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeRemote(
    skills: Array<{ id: string; name: string; description: string }> = [
      { id: 'alpha', name: 'alpha', description: 'First skill' },
    ]
  ): { url: string; remote: string; revision: string } {
    const remote = mkdtempSync(join(tmpdir(), 'igs-recon-remote-'))
    dirs.push(remote)
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    for (const s of skills) writeSkill(remote, s.id, s.name, s.description)
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'seed')
    const revision = git(remote, 'rev-parse', 'HEAD')
    return { url: remote, remote, revision }
  }

  async function syncedBackend(
    home: string,
    remoteUrl?: string
  ): Promise<{
    backend: Backend
    registryId: string
    revision: string
    userData: string
    url: string
  }> {
    const { url } = remoteUrl ? { url: remoteUrl } : makeRemote()
    const userData = mkdtempSync(join(tmpdir(), 'igs-recon-ud-'))
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
    return {
      backend,
      registryId: registry.id,
      revision: registry.syncStatus.revision!,
      userData,
      url,
    }
  }

  it('corrupt on-disk install → needs-repair + Repair; reconcile mutates nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-recon-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })

    const { backend, registryId, revision } = await syncedBackend(home)

    await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revision,
    })

    const installedPath = join(home, '.claude', 'skills', 'alpha')
    expect(existsSync(installedPath)).toBe(true)

    rmSync(installedPath, { recursive: true, force: true })

    const report = await backend.reconcile({ registryId, folderName: 'alpha' })
    const entry = report.entries.find(
      (e) => e.folderName === 'alpha' && e.target === '~/.claude/skills'
    )
    expect(entry?.state).toBe('needs-repair')

    expect(existsSync(installedPath)).toBe(false)

    const catalogue = await backend.getCatalogue()
    const skill = catalogue.skills.find((s) => s.folderName === 'alpha')
    expect(skill?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe(
      'needs-repair'
    )

    const repaired = await backend.repair({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: (await backend.getSyncStatus()).registries[0].revision!,
    })
    expect(repaired.perTarget[0]?.outcome).toBe('installed')
    expect(existsSync(installedPath)).toBe(true)

    const after = await backend.getCatalogue()
    expect(
      after.skills
        .find((s) => s.folderName === 'alpha')
        ?.perTarget.find((p) => p.target === '~/.claude/skills')?.state
    ).toBe('installed')

    backend.close()
  })

  it('update-available via content-hash compare; update is deterministic re-add', async () => {
    const { url, remote } = makeRemote()
    const home = mkdtempSync(join(tmpdir(), 'igs-recon-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })

    const { backend, registryId, revision } = await syncedBackend(home, url)

    await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revision,
    })

    writeFileSync(
      join(remote, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: First skill\n---\n\n# alpha v2\n',
      'utf8'
    )
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'bump alpha')
    await backend.refresh()
    const newRevision = (await backend.getSyncStatus()).registries[0].revision!

    const catalogue = await backend.getCatalogue()
    expect(
      catalogue.skills
        .find((s) => s.folderName === 'alpha')
        ?.perTarget.find((p) => p.target === '~/.claude/skills')?.state
    ).toBe('update-available')

    const updated = await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: newRevision,
    })
    expect(updated.perTarget[0]?.outcome).toBe('installed')

    const after = await backend.getCatalogue()
    expect(
      after.skills
        .find((s) => s.folderName === 'alpha')
        ?.perTarget.find((p) => p.target === '~/.claude/skills')?.state
    ).toBe('installed')

    backend.close()
  })

  it('uninstall removes local copy and clears install_record', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-recon-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })

    const { backend, registryId, revision, userData } = await syncedBackend(home)

    await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revision,
    })

    const result = await backend.uninstall({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
    })
    expect(result.perTarget[0]?.outcome).toBe('installed')
    expect(existsSync(join(home, '.claude', 'skills', 'alpha'))).toBe(false)

    const db = openDatabase(join(userData, 'cache.sqlite'))
    expect(readInstallRecords(db, { folderName: 'alpha' })).toHaveLength(0)
    db.close()

    const catalogue = await backend.getCatalogue()
    expect(
      catalogue.skills
        .find((s) => s.folderName === 'alpha')
        ?.perTarget.find((p) => p.target === '~/.claude/skills')?.state
    ).toBe('not-installed')

    backend.close()
  })

  it.each([
    ['~/.claude/skills', ['.claude', 'skills'], '~/.agents/skills', ['.agents', 'skills']],
    ['~/.agents/skills', ['.agents', 'skills'], '~/.claude/skills', ['.claude', 'skills']],
  ] as const)(
    'uninstalling from %s leaves the other target untouched',
    async (removed, removedFolder, kept, keptFolder) => {
      const home = mkdtempSync(join(tmpdir(), 'igs-recon-home-'))
      dirs.push(home)
      mkdirSync(join(home, '.claude'), { recursive: true })
      mkdirSync(join(home, '.cursor'), { recursive: true })

      const { backend, registryId, revision, userData } = await syncedBackend(home)
      await backend.install({
        registryId,
        folderName: 'alpha',
        targets: ['~/.claude/skills', '~/.agents/skills'],
        mirrorRevision: revision,
      })

      const result = await backend.uninstall({
        registryId,
        folderName: 'alpha',
        targets: [removed],
      })
      expect(result.perTarget[0]?.outcome).toBe('installed')
      expect(existsSync(join(home, ...removedFolder, 'alpha'))).toBe(false)
      expect(existsSync(join(home, ...keptFolder, 'alpha', 'SKILL.md'))).toBe(true)

      const db = openDatabase(join(userData, 'cache.sqlite'))
      expect(readInstallRecords(db, { folderName: 'alpha' }).map((r) => r.target)).toEqual([kept])
      db.close()

      const report = await backend.reconcile({ registryId, folderName: 'alpha' })
      expect(report.entries.find((e) => e.target === kept)?.state).toBe('installed')
      expect(report.entries.find((e) => e.target === removed)?.state).toBe('not-installed')

      backend.close()
    }
  )

  it('soft-deleted skill: hidden if never installed; dimmed removed row if installed', async () => {
    const { url, remote } = makeRemote([
      { id: 'alpha', name: 'alpha', description: 'First' },
      { id: 'beta', name: 'Beta', description: 'Second' },
    ])
    const home = mkdtempSync(join(tmpdir(), 'igs-recon-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })

    const { backend, registryId, revision } = await syncedBackend(home, url)

    await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revision,
    })

    rmSync(join(remote, 'skills', 'alpha'), { recursive: true, force: true })
    rmSync(join(remote, 'skills', 'beta'), { recursive: true, force: true })
    mkdirSync(join(remote, 'skills'), { recursive: true })
    writeFileSync(join(remote, 'README.md'), 'empty\n', 'utf8')
    git(remote, 'add', '-A')
    git(remote, 'commit', '-m', 'remove skills')
    await backend.refresh()

    const catalogue = await backend.getCatalogue()
    const folders = catalogue.skills.map((s) => s.folderName)
    expect(folders).not.toContain('beta')
    const alpha = catalogue.skills.find((s) => s.folderName === 'alpha')
    expect(alpha?.softDeleted).toBe(true)
    expect(alpha?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe(
      'removed-from-registry'
    )

    backend.close()
  })

  it('external: on-disk skill with no install_record', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-recon-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: x\n---\n',
      'utf8'
    )

    const { backend, registryId } = await syncedBackend(home)
    const report = await backend.reconcile({ registryId, folderName: 'alpha' })
    const entry = report.entries.find(
      (e) => e.folderName === 'alpha' && e.target === '~/.claude/skills'
    )
    expect(entry?.state).toBe('external')

    const catalogue = await backend.getCatalogue()
    expect(
      catalogue.skills
        .find((s) => s.folderName === 'alpha')
        ?.perTarget.find((p) => p.target === '~/.claude/skills')?.state
    ).toBe('external')

    backend.close()
  })

  it('reports each target from its own folder only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-recon-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const shared = join(home, '.agents', 'skills', 'alpha')
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'SKILL.md'), '---\nname: alpha\ndescription: x\n---\n', 'utf8')

    const { backend, registryId } = await syncedBackend(home)
    const report = await backend.reconcile({ registryId, folderName: 'alpha' })
    expect(report.entries.find((e) => e.target === '~/.claude/skills')?.state).toBe('not-installed')
    expect(report.entries.find((e) => e.target === '~/.agents/skills')?.state).toBe('external')

    backend.close()
  })

  it('broken symlink vs recorded install → needs-repair without mutating disk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-recon-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })

    const { backend, registryId, revision } = await syncedBackend(home)
    await backend.install({
      registryId,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: revision,
    })

    const agentPath = join(home, '.claude', 'skills', 'alpha')
    rmSync(agentPath, { recursive: true, force: true })
    symlinkSync(join(home, '.agents', 'skills', 'alpha-missing'), agentPath)

    const beforeMtime = lstatSync(agentPath).mtimeMs
    const report = await backend.reconcile({ registryId, folderName: 'alpha' })
    expect(
      report.entries.find((e) => e.folderName === 'alpha' && e.target === '~/.claude/skills')?.state
    ).toBe('needs-repair')
    expect(lstatSync(agentPath).mtimeMs).toBe(beforeMtime)

    backend.close()
  })
})
