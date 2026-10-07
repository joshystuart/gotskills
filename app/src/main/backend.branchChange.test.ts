import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type Backend } from './backend'
import { createSkillsCliRunner } from './installer/cli'
import { fakeHomeDetection } from './fakeHome'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function writeSkill(root: string, id: string): void {
  const dir = join(root, 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id} description\n---\n\n# ${id}\n`,
    'utf8'
  )
}

/**
 * Issue #8: a Registry's branch can be changed without redefining identity.
 * A successful new-branch sync atomically replaces the Catalogue contribution;
 * a failed new-branch sync retains the previous snapshot; and the same GitHub
 * repository cannot be added twice merely to select a second branch.
 */
describe('changing a Registry branch (issue #8)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A remote whose `main` supplies `alpha` and `feature` supplies `beta`. */
  function makeTwoBranchRemote(): string {
    const remote = mkdtempSync(join(tmpdir(), 'igs-branch-remote-'))
    dirs.push(remote)
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    writeSkill(remote, 'alpha')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'main: alpha')

    git(remote, 'checkout', '-b', 'feature')
    rmSync(join(remote, 'skills', 'alpha'), { recursive: true, force: true })
    writeSkill(remote, 'beta')
    git(remote, 'add', '-A')
    git(remote, 'commit', '-m', 'feature: beta')

    git(remote, 'checkout', 'main')
    return remote
  }

  function newBackend(home: string): { backend: Backend; userData: string } {
    const userData = mkdtempSync(join(tmpdir(), 'igs-branch-ud-'))
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

  async function withoutDefault(backend: Backend): Promise<void> {
    for (const r of await backend.listRegistries()) await backend.removeRegistry(r.id)
  }

  it('atomically replaces the catalogue contribution on a successful branch change', async () => {
    const remote = makeTwoBranchRemote()
    const home = mkdtempSync(join(tmpdir(), 'igs-branch-home-'))
    dirs.push(home)
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const reg = await backend.addRegistry({ url: remote, branch: 'main' })
    expect((await backend.getCatalogue()).skills.map((s) => s.folderName)).toEqual(['alpha'])

    const updated = await backend.updateRegistry({ id: reg.id, branch: 'feature' })
    expect(updated.branch).toBe('feature')
    expect(updated.id).toBe(reg.id)
    expect(updated.syncStatus.phase).toBe('synced')

    const skills = (await backend.getCatalogue()).skills
    expect(skills.map((s) => s.folderName)).toEqual(['beta'])

    backend.close()
  })

  it('retains the previous snapshot (stale) when the new-branch sync fails', async () => {
    const remote = makeTwoBranchRemote()
    const home = mkdtempSync(join(tmpdir(), 'igs-branch-home-'))
    dirs.push(home)
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const reg = await backend.addRegistry({ url: remote, branch: 'feature' })
    expect((await backend.getCatalogue()).skills.map((s) => s.folderName)).toEqual(['beta'])

    const updated = await backend.updateRegistry({ id: reg.id, branch: 'no-such-branch' })
    expect(updated.branch).toBe('no-such-branch')
    expect(updated.syncStatus.phase).toBe('failed')
    expect(updated.syncStatus.stale).toBe(true)

    const catalogue = await backend.getCatalogue()
    expect(catalogue.skills.map((s) => s.folderName)).toEqual(['beta'])
    expect(catalogue.skills.every((s) => s.stale)).toBe(true)

    backend.close()
  })

  it('keeps installations across a branch change and updates the update source', async () => {
    const remote = makeTwoBranchRemote()
    const home = mkdtempSync(join(tmpdir(), 'igs-branch-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const { backend } = newBackend(home)
    await withoutDefault(backend)

    const reg = await backend.addRegistry({ url: remote, branch: 'main' })
    await backend.install({
      registryId: reg.id,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: reg.syncStatus.revision!,
    })
    expect(existsSync(join(home, '.claude', 'skills', 'alpha'))).toBe(true)

    await backend.updateRegistry({ id: reg.id, branch: 'feature' })

    expect(existsSync(join(home, '.claude', 'skills', 'alpha'))).toBe(true)
    const catalogue = await backend.getCatalogue()
    const alpha = catalogue.skills.find((s) => s.folderName === 'alpha')
    expect(alpha?.softDeleted).toBe(true)
    expect(alpha?.perTarget.find((p) => p.target === '~/.claude/skills')?.state).toBe(
      'removed-from-registry'
    )
    expect(catalogue.skills.some((s) => s.folderName === 'beta' && !s.softDeleted)).toBe(true)

    backend.close()
  })

  it('rejects adding the same GitHub owner/repo again just to select a second branch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-branch-home-'))
    dirs.push(home)
    const { backend } = newBackend(home)
    await expect(
      backend.addRegistry({ url: 'https://github.com/anthropics/skills', branch: 'dev' })
    ).rejects.toThrow(/already configured/i)
    backend.close()
  })
})
