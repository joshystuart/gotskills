import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './db/open'
import { insertRegistry } from './registries'
import { syncRegistry } from './sync'
import { readCatalogue } from './catalogue'
import { fakeHomeEnvironment } from './fakeHome'

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

function writeNestedSkill(root: string, category: string, name: string, description: string): void {
  const dir = join(root, 'skills', category, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8'
  )
}

/**
 * Seam: registry-scoped sync path against a real temp Git remote
 * (clone → hard-reset → scan → SQLite → combined catalogue read).
 */
describe('syncRegistry → readCatalogue', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeRemote(): { url: string; remote: string } {
    const remote = mkdtempSync(join(tmpdir(), 'igs-remote-'))
    dirs.push(remote)
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    writeSkill(remote, 'alpha', 'alpha', 'First skill')
    writeSkill(remote, 'beta', 'beta', 'Second skill')
    mkdirSync(join(remote, 'skills', 'broken'), { recursive: true })
    writeFileSync(join(remote, 'skills', 'broken', 'SKILL.md'), 'no frontmatter\n', 'utf8')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'seed')
    return { url: remote, remote }
  }

  function seedRegistry(db: ReturnType<typeof openDatabase>, url: string): string {
    return insertRegistry(db, {
      url,
      branch: 'main',
      enabled: true,
      autoUpdate: false,
      githubOwner: null,
      githubRepo: null,
      canonicalKey: `git:${url}`,
    }).id
  }

  it('clones, scans, writes SQLite, and returns catalogue rows (skipping malformed)', async () => {
    const { url } = makeRemote()
    const work = mkdtempSync(join(tmpdir(), 'igs-work-'))
    dirs.push(work)
    const mirrorPath = join(work, 'mirror')
    const db = openDatabase(join(work, 'cache.sqlite'))
    const registryId = seedRegistry(db, url)

    const result = await syncRegistry(db, { registryId, url, branch: 'main', mirrorPath })
    expect(result.status).toBe('ok')
    expect(result.visibleSkillCount).toBe(2)

    const snapshot = readCatalogue(db, fakeHomeEnvironment(work))
    expect(snapshot.skills.map((s) => s.folderName).sort()).toEqual(['alpha', 'beta'])
    expect(snapshot.skills.find((s) => s.folderName === 'alpha')).toMatchObject({
      name: 'alpha',
      description: 'First skill',
      registryId,
    })
    expect(snapshot.syncStatus.phase).toBe('synced')
    expect(snapshot.syncStatus.visibleSkillCount).toBe(2)

    const versions = db
      .prepare(`SELECT folder_name, commit_sha FROM version ORDER BY folder_name`)
      .all() as { folder_name: string; commit_sha: string }[]
    expect(versions.map((v) => v.folder_name).sort()).toEqual(['alpha', 'beta'])

    db.close()
  })

  it('hard-resets on re-sync (never merges) and soft-deletes removed skills', async () => {
    const { url, remote } = makeRemote()
    const work = mkdtempSync(join(tmpdir(), 'igs-work-'))
    dirs.push(work)
    const mirrorPath = join(work, 'mirror')
    const db = openDatabase(join(work, 'cache.sqlite'))
    const registryId = seedRegistry(db, url)

    await syncRegistry(db, { registryId, url, branch: 'main', mirrorPath })

    rmSync(join(remote, 'skills', 'beta'), { recursive: true, force: true })
    git(remote, 'add', '-A')
    git(remote, 'commit', '-m', 'remove beta')

    await syncRegistry(db, { registryId, url, branch: 'main', mirrorPath })

    const snapshot = readCatalogue(db, fakeHomeEnvironment(work))
    expect(snapshot.skills.map((s) => s.folderName)).toEqual(['alpha'])

    const beta = db
      .prepare(`SELECT soft_deleted FROM skill WHERE registry_id = ? AND folder_name = 'beta'`)
      .get(registryId) as { soft_deleted: number } | undefined
    expect(beta?.soft_deleted).toBe(1)

    db.close()
  })

  it('preserves the last-good catalogue when a subsequent sync fails', async () => {
    const { url } = makeRemote()
    const work = mkdtempSync(join(tmpdir(), 'igs-work-'))
    dirs.push(work)
    const mirrorPath = join(work, 'mirror')
    const db = openDatabase(join(work, 'cache.sqlite'))
    const registryId = seedRegistry(db, url)

    await syncRegistry(db, { registryId, url, branch: 'main', mirrorPath })
    expect(readCatalogue(db, fakeHomeEnvironment(work)).skills).toHaveLength(2)

    await expect(
      syncRegistry(db, {
        registryId,
        url: join(work, 'does-not-exist'),
        branch: 'main',
        mirrorPath,
      })
    ).rejects.toThrow()

    const snapshot = readCatalogue(db, fakeHomeEnvironment(work))
    expect(snapshot.skills.map((s) => s.folderName).sort()).toEqual(['alpha', 'beta'])
    db.close()
  })

  it('syncs nested-layout remotes and persists skill_path for catalogue install keys', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'igs-nested-remote-'))
    dirs.push(remote)
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    writeNestedSkill(remote, 'engineering', 'code-review', 'Review code')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'nested seed')
    const url = remote

    const work = mkdtempSync(join(tmpdir(), 'igs-nested-work-'))
    dirs.push(work)
    const mirrorPath = join(work, 'mirror')
    const db = openDatabase(join(work, 'cache.sqlite'))
    const registryId = seedRegistry(db, url)

    await syncRegistry(db, { registryId, url, branch: 'main', mirrorPath })

    const snapshot = readCatalogue(db, fakeHomeEnvironment(work))
    expect(snapshot.skills.map((s) => s.folderName)).toEqual(['code-review'])
    expect(snapshot.skills[0]).toMatchObject({
      name: 'code-review',
      description: 'Review code',
      registryId,
    })

    const row = db
      .prepare(`SELECT skill_path FROM skill WHERE registry_id = ? AND folder_name = 'code-review'`)
      .get(registryId) as { skill_path: string }
    expect(row.skill_path).toBe('skills/engineering/code-review')

    db.close()
  })

  it('syncs nested skills after a category-folder move (rename history gap)', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'igs-move-remote-'))
    dirs.push(remote)
    git(remote, 'init', '-b', 'main')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    writeNestedSkill(remote, 'productivity', 'teach', 'Teach things')
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'add teach')
    mkdirSync(join(remote, 'skills', 'in-progress'), { recursive: true })
    git(remote, 'mv', 'skills/productivity/teach', 'skills/in-progress/teach')
    git(remote, 'commit', '-m', 'move teach')
    git(remote, 'mv', 'skills/in-progress/teach', 'skills/productivity/teach')
    git(remote, 'commit', '-m', 'move teach back')
    const url = remote

    const work = mkdtempSync(join(tmpdir(), 'igs-move-work-'))
    dirs.push(work)
    const mirrorPath = join(work, 'mirror')
    const db = openDatabase(join(work, 'cache.sqlite'))
    const registryId = seedRegistry(db, url)

    const result = await syncRegistry(db, { registryId, url, branch: 'main', mirrorPath })
    expect(result.status).toBe('ok')
    expect(result.visibleSkillCount).toBe(1)

    const snapshot = readCatalogue(db, fakeHomeEnvironment(work))
    expect(snapshot.skills.map((s) => s.folderName)).toEqual(['teach'])

    db.close()
  })
})
