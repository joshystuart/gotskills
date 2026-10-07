import {
  mkdtempSync,
  mkdirSync,
  promises as fsPromises,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from './db/open'
import { insertRegistry } from './registries'
import {
  listSkillFiles,
  readSkillFile,
  SKILL_FILE_READ_CAP_BYTES,
  type SkillFilesDeps,
} from './skillFiles'

describe('skillFiles (temp mirror)', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeDeps(): { deps: SkillFilesDeps; registryId: string; mirrorRoot: string } {
    const userData = mkdtempSync(join(tmpdir(), 'igs-skillfiles-'))
    dirs.push(userData)
    const db = openDatabase(join(userData, 'cache.sqlite'))
    const registry = insertRegistry(db, {
      url: 'https://github.com/example/skills',
      branch: 'main',
      enabled: true,
      autoUpdate: false,
      githubOwner: 'example',
      githubRepo: 'skills',
      canonicalKey: 'github.com/example/skills',
    })
    const mirrorRoot = join(userData, 'mirrors', registry.id)
    mkdirSync(mirrorRoot, { recursive: true })
    return {
      deps: { db, mirrorPathFor: () => mirrorRoot },
      registryId: registry.id,
      mirrorRoot,
    }
  }

  function addSkill(
    deps: SkillFilesDeps,
    registryId: string,
    folderName: string,
    skillPath: string
  ): void {
    deps.db
      .prepare(
        `INSERT INTO skill (registry_id, folder_name, name, description, skill_path)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(registryId, folderName, folderName, `${folderName} description`, skillPath)
  }

  function writeSkillFiles(mirrorRoot: string, skillPath: string): void {
    const dir = join(mirrorRoot, ...skillPath.split('/'))
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'references', 'deep'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\n', 'utf8')
    writeFileSync(join(dir, 'scripts', 'run.sh'), 'echo hi\n', 'utf8')
    writeFileSync(join(dir, 'references', 'deep', 'notes.txt'), 'notes\n', 'utf8')
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  }

  it('lists nested files as relative POSIX paths with sizes and viewable flags', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    writeSkillFiles(mirrorRoot, 'skills/alpha')

    const list = await listSkillFiles(deps, { registryId, folderName: 'alpha' })
    expect(list.unavailable).toBeUndefined()
    const byPath = new Map(list.files.map((f) => [f.path, f]))
    expect([...byPath.keys()].sort()).toEqual([
      'SKILL.md',
      'logo.png',
      'references/deep/notes.txt',
      'scripts/run.sh',
    ])
    expect(byPath.get('SKILL.md')).toMatchObject({ viewable: true, sizeBytes: 8 })
    expect(byPath.get('scripts/run.sh')).toMatchObject({ viewable: true })
    expect(byPath.get('logo.png')).toMatchObject({ viewable: false, sizeBytes: 4 })
  })

  it('resolves nested skill paths from the persisted Skill Path', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'code-review', 'skills/engineering/code-review')
    writeSkillFiles(mirrorRoot, 'skills/engineering/code-review')

    const list = await listSkillFiles(deps, { registryId, folderName: 'code-review' })
    expect(list.files.map((f) => f.path)).toContain('SKILL.md')
  })

  it('returns UTF-8 content with kind text for text files', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    writeSkillFiles(mirrorRoot, 'skills/alpha')

    const content = await readSkillFile(deps, {
      registryId,
      folderName: 'alpha',
      path: 'scripts/run.sh',
    })
    expect(content).toMatchObject({ kind: 'text', content: 'echo hi\n', sizeBytes: 8 })
    expect(content.truncated).toBeUndefined()
  })

  it('returns kind binary for a non-allowlisted extension', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    writeSkillFiles(mirrorRoot, 'skills/alpha')

    const content = await readSkillFile(deps, {
      registryId,
      folderName: 'alpha',
      path: 'logo.png',
    })
    expect(content).toMatchObject({ kind: 'binary', sizeBytes: 4 })
    expect(content.content).toBeUndefined()
  })

  it('returns kind binary for an allowlisted file containing a null byte', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    const dir = join(mirrorRoot, 'skills', 'alpha')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'data.txt'), Buffer.from([0x61, 0x00, 0x62]))

    const content = await readSkillFile(deps, {
      registryId,
      folderName: 'alpha',
      path: 'data.txt',
    })
    expect(content.kind).toBe('binary')
  })

  it('truncates content beyond the read cap with truncated: true', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    const dir = join(mirrorRoot, 'skills', 'alpha')
    mkdirSync(dir, { recursive: true })
    const big = 'x'.repeat(SKILL_FILE_READ_CAP_BYTES + 100)
    writeFileSync(join(dir, 'big.md'), big, 'utf8')

    const content = await readSkillFile(deps, {
      registryId,
      folderName: 'alpha',
      path: 'big.md',
    })
    expect(content.kind).toBe('text')
    expect(content.truncated).toBe(true)
    expect(content.sizeBytes).toBe(SKILL_FILE_READ_CAP_BYTES + 100)
    expect(content.content).toHaveLength(SKILL_FILE_READ_CAP_BYTES)
  })

  it('rejects a request path resolving outside the skill directory', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    writeSkillFiles(mirrorRoot, 'skills/alpha')

    await expect(
      readSkillFile(deps, { registryId, folderName: 'alpha', path: '../../secret.txt' })
    ).rejects.toThrow(/outside/)
    await expect(
      readSkillFile(deps, { registryId, folderName: 'alpha', path: '/etc/passwd' })
    ).rejects.toThrow(/outside/)
  })

  it('rejects a symlink escape outside the skill directory', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    const dir = join(mirrorRoot, 'skills', 'alpha')
    mkdirSync(dir, { recursive: true })
    const outside = join(mirrorRoot, 'outside.txt')
    writeFileSync(outside, 'secret\n', 'utf8')
    symlinkSync(outside, join(dir, 'leak.txt'))

    await expect(
      readSkillFile(deps, { registryId, folderName: 'alpha', path: 'leak.txt' })
    ).rejects.toThrow(/outside/)
  })

  it('lists a symlinked file whose target resolves inside the skill directory', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    writeSkillFiles(mirrorRoot, 'skills/alpha')
    const dir = join(mirrorRoot, 'skills', 'alpha')
    symlinkSync(join(dir, 'SKILL.md'), join(dir, 'alias.md'))

    const list = await listSkillFiles(deps, { registryId, folderName: 'alpha' })
    const byPath = new Map(list.files.map((f) => [f.path, f]))
    expect(byPath.get('alias.md')).toMatchObject({ viewable: true, sizeBytes: 8 })
  })

  it('omits a symlink whose target escapes the skill directory', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    writeSkillFiles(mirrorRoot, 'skills/alpha')
    const outside = join(mirrorRoot, 'outside.txt')
    writeFileSync(outside, 'secret\n', 'utf8')
    symlinkSync(outside, join(mirrorRoot, 'skills', 'alpha', 'leak.txt'))

    const list = await listSkillFiles(deps, { registryId, folderName: 'alpha' })
    expect(list.files.map((f) => f.path)).not.toContain('leak.txt')
  })

  it('resolves a file vanishing between stat and open to kind missing', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    writeSkillFiles(mirrorRoot, 'skills/alpha')
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    })
    vi.spyOn(fsPromises, 'open').mockRejectedValueOnce(enoent)

    const content = await readSkillFile(deps, {
      registryId,
      folderName: 'alpha',
      path: 'SKILL.md',
    })
    expect(content).toEqual({ path: 'SKILL.md', sizeBytes: 0, kind: 'missing' })
  })

  it('resolves a missing skill path to the unavailable outcome for listing', async () => {
    const { deps, registryId } = makeDeps()
    addSkill(deps, registryId, 'ghost', 'skills/ghost')

    const list = await listSkillFiles(deps, { registryId, folderName: 'ghost' })
    expect(list).toEqual({ files: [], unavailable: 'missing' })
  })

  it('resolves a vanished file to kind missing rather than throwing', async () => {
    const { deps, registryId, mirrorRoot } = makeDeps()
    addSkill(deps, registryId, 'alpha', 'skills/alpha')
    writeSkillFiles(mirrorRoot, 'skills/alpha')

    const content = await readSkillFile(deps, {
      registryId,
      folderName: 'alpha',
      path: 'gone.md',
    })
    expect(content).toEqual({ path: 'gone.md', sizeBytes: 0, kind: 'missing' })
  })

  it('resolves a missing skill path to kind missing for reads', async () => {
    const { deps, registryId } = makeDeps()
    addSkill(deps, registryId, 'ghost', 'skills/ghost')

    const content = await readSkillFile(deps, {
      registryId,
      folderName: 'ghost',
      path: 'SKILL.md',
    })
    expect(content.kind).toBe('missing')
  })

  it('throws a typed error for an unknown Registry', async () => {
    const { deps } = makeDeps()

    await expect(listSkillFiles(deps, { registryId: 'nope', folderName: 'alpha' })).rejects.toThrow(
      'Registry "nope" is not configured'
    )
    await expect(
      readSkillFile(deps, { registryId: 'nope', folderName: 'alpha', path: 'SKILL.md' })
    ).rejects.toThrow('Registry "nope" is not configured')
  })

  it('throws a typed error for an unknown Skill', async () => {
    const { deps, registryId } = makeDeps()

    await expect(listSkillFiles(deps, { registryId, folderName: 'nope' })).rejects.toThrow(
      'Skill "nope" is not in the catalogue'
    )
  })
})
