import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type Backend } from './backend'
import { createSkillsCliRunner } from './installer/cli'
import { syncRegistry, type SyncRegistryFn } from './sync'
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
 * Issue #7: Private Registries sync through system Git. These tests drive the
 * sync failure path with a simulated auth-ambiguous git error via the
 * `syncRegistryImpl` test seam — the backend still redacts and classifies the
 * thrown message, so `access-required` is recorded end-to-end without ever
 * contacting live GitHub.
 */
describe('private registry access-required handling (issue #7)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function makeRemote(ids: string[]): string {
    const remote = mkdtempSync(join(tmpdir(), 'igs-priv-remote-'))
    dirs.push(remote)
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    for (const id of ids) writeSkill(remote, id)
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'seed')
    return remote
  }

  /** The private (inaccessible) Registry URL fails; everything else is real. */
  const PRIVATE_URL = 'https://github.com/example-org/private-skills'

  function failPrivate(): SyncRegistryFn {
    return async (db, config) => {
      if (config.url === PRIVATE_URL) {
        throw new Error(
          "fatal: Authentication failed for 'https://x-access-token:ghp_secretTOKEN@github.com/example-org/private-skills.git/'"
        )
      }
      return syncRegistry(db, config)
    }
  }

  function newBackend(home: string, syncRegistryImpl?: SyncRegistryFn): Backend {
    const userData = mkdtempSync(join(tmpdir(), 'igs-priv-ud-'))
    dirs.push(userData)
    return createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
      runSkillsCli: createSkillsCliRunner(),
      syncRegistryImpl,
    })
  }

  async function withoutDefault(backend: Backend): Promise<void> {
    for (const r of await backend.listRegistries()) await backend.removeRegistry(r.id)
  }

  it('records access-required end-to-end for an ambiguous git auth failure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-priv-home-'))
    dirs.push(home)
    const backend = newBackend(home, failPrivate())
    await withoutDefault(backend)

    const priv = await backend.addRegistry({ url: PRIVATE_URL, branch: 'main' })

    expect(priv.syncStatus.phase).toBe('failed')
    expect(priv.syncStatus.reason).toBe('access-required')
    expect(priv.syncStatus.stale).toBe(true)

    backend.close()
  })

  it('keeps an inaccessible private Registry from blocking other Registries', async () => {
    const publicRemote = makeRemote(['alpha'])
    const home = mkdtempSync(join(tmpdir(), 'igs-priv-home-'))
    dirs.push(home)
    const backend = newBackend(home, failPrivate())
    await withoutDefault(backend)

    const priv = await backend.addRegistry({ url: PRIVATE_URL, branch: 'main' })
    const pub = await backend.addRegistry({ url: publicRemote, branch: 'main' })

    expect(priv.syncStatus.reason).toBe('access-required')
    expect(pub.syncStatus.phase).toBe('synced')

    const status = await backend.getSyncStatus()
    expect(status.phase).toBe('partial')

    const skills = (await backend.getCatalogue()).skills
    expect(skills.map((s) => s.folderName)).toContain('alpha')

    backend.close()
  })

  it('recovers on a later successful sync once access is available', async () => {
    const home = mkdtempSync(join(tmpdir(), 'igs-priv-home-'))
    dirs.push(home)

    const remote = makeRemote(['alpha'])
    let accessible = false
    const gated: SyncRegistryFn = async (db, config) => {
      if (!accessible) {
        throw new Error('remote: Repository not found.\nfatal: repository not found')
      }
      return syncRegistry(db, config)
    }
    const backend = newBackend(home, gated)
    await withoutDefault(backend)

    const added = await backend.addRegistry({ url: remote, branch: 'main' })
    expect(added.syncStatus.reason).toBe('access-required')

    accessible = true
    const recovered = await backend.syncRegistry(added.id)
    expect(recovered.phase).toBe('synced')
    expect(recovered.stale).toBe(false)
    expect((await backend.getCatalogue()).skills.map((s) => s.folderName)).toEqual(['alpha'])

    backend.close()
  })
})
