import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type Backend } from './backend'
import { DEFAULT_REGISTRY } from './config'
import { fakeHomeDetection } from './fakeHome'

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
  const remote = mkdtempSync(join(tmpdir(), 'igs-remote-'))
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

function openBackend(userData: string, home: string): Backend {
  return createBackend({
    paths: { userData },
    syncIntervalMs: 0,
    homeDir: home,
    ...fakeHomeDetection(home),
  })
}

function freshBackend(dirs: string[]): { backend: Backend; userData: string; home: string } {
  const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
  const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
  dirs.push(userData, home)
  return { backend: openBackend(userData, home), userData, home }
}

describe('backend (AppApi seam)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /** Remove the seeded default so a test controls its own Registries. */
  async function withoutDefault(backend: Backend): Promise<void> {
    for (const r of await backend.listRegistries()) {
      await backend.removeRegistry(r.id)
    }
  }

  it('starts with an empty catalogue before the first sync', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(userData, home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    const snapshot = await backend.getCatalogue()
    expect(snapshot.skills).toEqual([])
    backend.close()
  })

  it('detects Claude Code, the Shared Target and every other own-folder target', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(userData, home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    const { targets } = await backend.detectTargets()
    expect(targets.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        '~/.claude/skills',
        '~/.agents/skills',
        '~/.config/goose/skills',
        '~/.zencoder/skills',
      ])
    )
    backend.close()
  })

  it('seeds the shipped default Registry on first start', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(userData, home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    const registries = await backend.listRegistries()
    expect(registries).toHaveLength(1)
    expect(registries[0]).toMatchObject({
      url: DEFAULT_REGISTRY.url,
      branch: DEFAULT_REGISTRY.branch,
      enabled: true,
      githubOwner: 'anthropics',
      githubRepo: 'skills',
    })
    backend.close()
  })

  it('adds two Registries and unions their catalogues with per-skill provenance', async () => {
    const remoteA = makeRemote(['alpha', 'beta'])
    const remoteB = makeRemote(['grill-with-docs', 'to-spec', 'wayfinder'])
    dirs.push(remoteA, remoteB)

    const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(userData, home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    const b = await backend.addRegistry({ url: remoteB, branch: 'main' })

    const snapshot = await backend.getCatalogue()
    expect(snapshot.skills.map((s) => s.folderName).sort()).toEqual([
      'alpha',
      'beta',
      'grill-with-docs',
      'to-spec',
      'wayfinder',
    ])
    const alpha = snapshot.skills.find((s) => s.folderName === 'alpha')
    expect(alpha?.registryId).toBe(a.id)
    expect(snapshot.skills.find((s) => s.folderName === 'to-spec')?.registryId).toBe(b.id)
    expect(snapshot.skills.every((s) => !s.conflict)).toBe(true)
    expect(snapshot.syncStatus.phase).toBe('synced')
    expect(snapshot.syncStatus.registries).toHaveLength(2)

    backend.close()
  }, 20_000)

  it('flags a Skill Conflict when two enabled Registries supply the same folder name', async () => {
    const remoteA = makeRemote(['grilling'])
    const remoteB = makeRemote(['grilling'])
    dirs.push(remoteA, remoteB)

    const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(userData, home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    await withoutDefault(backend)

    await backend.addRegistry({ url: remoteA, branch: 'main' })
    await backend.addRegistry({ url: remoteB, branch: 'main' })

    const snapshot = await backend.getCatalogue()
    const grilling = snapshot.skills.filter((s) => s.folderName === 'grilling')
    expect(grilling).toHaveLength(2)
    expect(grilling.every((s) => s.conflict)).toBe(true)

    backend.close()
  })

  it('enforces one Registry per GitHub owner/repo', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(userData, home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    await expect(
      backend.addRegistry({ url: 'git@github.com:Anthropics/Skills.git', branch: 'main' })
    ).rejects.toThrow(/already configured/i)
    backend.close()
  })

  it('disabling a Registry hides its available skills without deleting them', async () => {
    const remoteA = makeRemote(['alpha'])
    dirs.push(remoteA)
    const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(userData, home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    expect((await backend.getCatalogue()).skills).toHaveLength(1)

    await backend.updateRegistry({ id: a.id, enabled: false })
    expect((await backend.getCatalogue()).skills).toHaveLength(0)

    await backend.updateRegistry({ id: a.id, enabled: true })
    expect((await backend.getCatalogue()).skills).toHaveLength(1)

    backend.close()
  })

  it('removing a Registry with no installs drops it from the catalogue and list', async () => {
    const remoteA = makeRemote(['alpha'])
    dirs.push(remoteA)
    const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(userData, home)
    const backend = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    await withoutDefault(backend)

    const a = await backend.addRegistry({ url: remoteA, branch: 'main' })
    await backend.removeRegistry(a.id)

    expect(await backend.listRegistries()).toHaveLength(0)
    expect((await backend.getCatalogue()).skills).toHaveLength(0)

    backend.close()
  })

  it('persists Registries and their snapshots across relaunch', async () => {
    const remote = makeRemote(['one'])
    dirs.push(remote)
    const userData = mkdtempSync(join(tmpdir(), 'igs-backend-'))
    const home = mkdtempSync(join(tmpdir(), 'igs-home-'))
    dirs.push(userData, home)

    const first = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    await withoutDefault(first)
    const added = await first.addRegistry({ url: remote, branch: 'main' })
    first.close()

    const second = createBackend({
      paths: { userData },
      syncIntervalMs: 0,
      homeDir: home,
      ...fakeHomeDetection(home),
    })
    const registries = await second.listRegistries()
    expect(registries.map((r) => r.id)).toEqual([added.id])
    const snapshot = await second.getCatalogue()
    expect(snapshot.skills.map((s) => s.folderName)).toEqual(['one'])
    second.close()
  })

  describe('Registry Colour', () => {
    it('comes back as null for a Registry nobody has coloured', async () => {
      const { backend } = await freshBackend(dirs)
      const [seeded] = await backend.listRegistries()
      expect(seeded.colour).toBeNull()
      backend.close()
    })

    it('stores a chosen colour as lowercase hex and keeps it across relaunch', async () => {
      const { backend, userData, home } = await freshBackend(dirs)
      const [seeded] = await backend.listRegistries()

      const updated = await backend.updateRegistry({ id: seeded.id, colour: '#AABBCC' })
      expect(updated.colour).toBe('#aabbcc')
      backend.close()

      const relaunched = openBackend(userData, home)
      const [reloaded] = await relaunched.listRegistries()
      expect(reloaded.colour).toBe('#aabbcc')
      relaunched.close()
    })

    it.each(['red', '#fff', 'url(x)'])(
      'rejects %s and leaves the stored colour unchanged',
      async (colour) => {
        const { backend } = await freshBackend(dirs)
        const [seeded] = await backend.listRegistries()
        await backend.updateRegistry({ id: seeded.id, colour: '#123456' })

        await expect(backend.updateRegistry({ id: seeded.id, colour })).rejects.toThrow()

        const [after] = await backend.listRegistries()
        expect(after.colour).toBe('#123456')
        backend.close()
      }
    )

    it('keeps the colour when other fields change', async () => {
      const { backend } = await freshBackend(dirs)
      const [seeded] = await backend.listRegistries()
      await backend.updateRegistry({ id: seeded.id, colour: '#123456' })

      const updated = await backend.updateRegistry({ id: seeded.id, enabled: false })

      expect(updated.colour).toBe('#123456')
      backend.close()
    })
  })
  describe('Registry Name', () => {
    it('comes back as null for a Registry nobody has named', async () => {
      const { backend } = await freshBackend(dirs)
      const [seeded] = await backend.listRegistries()
      expect(seeded.name).toBeNull()
      backend.close()
    })

    it('stores a trimmed name and keeps it across relaunch', async () => {
      const { backend, userData, home } = await freshBackend(dirs)
      const [seeded] = await backend.listRegistries()

      const updated = await backend.updateRegistry({ id: seeded.id, name: '  Team skills  ' })
      expect(updated.name).toBe('Team skills')
      backend.close()

      const relaunched = openBackend(userData, home)
      const [reloaded] = await relaunched.listRegistries()
      expect(reloaded.name).toBe('Team skills')
      relaunched.close()
    })

    it.each(['', '   '])('clears the name when given %j', async (name) => {
      const { backend } = await freshBackend(dirs)
      const [seeded] = await backend.listRegistries()
      await backend.updateRegistry({ id: seeded.id, name: 'Team skills' })

      const updated = await backend.updateRegistry({ id: seeded.id, name })

      expect(updated.name).toBeNull()
      backend.close()
    })

    it('rejects a 41-character name and leaves the stored name unchanged', async () => {
      const { backend } = await freshBackend(dirs)
      const [seeded] = await backend.listRegistries()
      await backend.updateRegistry({ id: seeded.id, name: 'Team skills' })

      await expect(
        backend.updateRegistry({ id: seeded.id, name: 'x'.repeat(41) })
      ).rejects.toThrow()

      const [after] = await backend.listRegistries()
      expect(after.name).toBe('Team skills')
      backend.close()
    })

    it('accepts a 40-character name', async () => {
      const { backend } = await freshBackend(dirs)
      const [seeded] = await backend.listRegistries()
      const updated = await backend.updateRegistry({ id: seeded.id, name: 'x'.repeat(40) })
      expect(updated.name).toBe('x'.repeat(40))
      backend.close()
    })

    it('keeps the name when other fields change', async () => {
      const { backend } = await freshBackend(dirs)
      const [seeded] = await backend.listRegistries()
      await backend.updateRegistry({ id: seeded.id, name: 'Team skills' })

      const updated = await backend.updateRegistry({ id: seeded.id, enabled: false })

      expect(updated.name).toBe('Team skills')
      backend.close()
    })
  })
})
