import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanSkills } from './scan'

/**
 * Seam: registry read behaviour against a real temporary Git repo
 * (spec Testing Decisions + ticket 2 acceptance).
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function writeSkill(
  root: string,
  relativeDir: string,
  frontmatter: string | null,
  body = '# Skill\n'
): void {
  const dir = join(root, relativeDir)
  mkdirSync(dir, { recursive: true })
  const content = frontmatter === null ? body : `---\n${frontmatter}\n---\n\n${body}`
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
}

describe('scanSkills (temp git repo)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'igs-scan-'))
    dirs.push(root)
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Test')
    return root
  }

  function commitAll(root: string, message: string): void {
    git(root, 'add', '.')
    git(root, 'commit', '-m', message)
  }

  it('discovers flat skills/<name>/SKILL.md with id = frontmatter name', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/alpha', 'name: alpha\ndescription: First skill')
    writeSkill(root, 'skills/beta', 'name: beta\ndescription: Second skill')
    commitAll(root, 'add skills')

    const found = await scanSkills(root)
    expect(found.map((s) => s.id).sort()).toEqual(['alpha', 'beta'])
    expect(found.find((s) => s.id === 'alpha')).toMatchObject({
      name: 'alpha',
      description: 'First skill',
      skillPath: 'skills/alpha',
    })
  })

  it('discovers nested skills/<category>/<name>/ with install key and skillPath', async () => {
    const root = makeRepo()
    writeSkill(
      root,
      'skills/engineering/code-review',
      'name: code-review\ndescription: Review code'
    )
    commitAll(root, 'nested skill')

    const found = await scanSkills(root)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      id: 'code-review',
      skillPath: 'skills/engineering/code-review',
      name: 'code-review',
      description: 'Review code',
    })
  })

  it('discovers skills nested three levels inside a skills container', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/top', 'name: top\ndescription: Flat skill')
    writeSkill(root, 'skills/eng/backend/api', 'name: api\ndescription: Deep skill')
    commitAll(root, 'deep nesting')

    const found = await scanSkills(root)
    expect(found.map((s) => s.skillPath)).toEqual(['skills/eng/backend/api', 'skills/top'])
  })

  it('discovers skills in agent project dirs added in skills 1.7', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/top', 'name: top\ndescription: Flat skill')
    writeSkill(root, '.factory/skills/droid', 'name: droid\ndescription: Factory skill')
    writeSkill(root, '.posit/assistant/skills/helper', 'name: helper\ndescription: Posit skill')
    commitAll(root, 'agent dirs')

    const found = await scanSkills(root)
    expect(found.map((s) => s.skillPath)).toEqual([
      '.factory/skills/droid',
      '.posit/assistant/skills/helper',
      'skills/top',
    ])
  })

  it('skips malformed folders (missing name or description) without throwing', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/good', 'name: good\ndescription: Valid')
    writeSkill(root, 'skills/no-desc', 'name: broken')
    writeSkill(root, 'skills/no-frontmatter', null)
    mkdirSync(join(root, 'skills', 'empty'), { recursive: true })
    commitAll(root, 'mixed')

    const found = await scanSkills(root)
    expect(found.map((s) => s.id)).toEqual(['good'])
  })

  it('warns about a skipped SKILL.md naming the missing frontmatter field', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/good', 'name: good\ndescription: Valid')
    writeSkill(root, 'skills/no-desc', 'name: broken')
    commitAll(root, 'missing description')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await scanSkills(root)
      expect(warn).toHaveBeenCalledWith(
        `⚠ Skipped ${join(root, 'skills', 'no-desc', 'SKILL.md')} — missing required frontmatter field(s): description`
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('hides metadata.internal skills by default', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/public', 'name: public\ndescription: Visible')
    writeSkill(
      root,
      'skills/internal',
      'name: internal\ndescription: Hidden\nmetadata:\n  internal: true'
    )
    commitAll(root, 'internal mix')

    const found = await scanSkills(root)
    expect(found.map((s) => s.id)).toEqual(['public'])
  })

  it('dedupes duplicate frontmatter names (first discovered wins)', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/first', 'name: dup\ndescription: First path')
    writeSkill(root, 'skills/second', 'name: dup\ndescription: Second path')
    commitAll(root, 'dupes')

    const found = await scanSkills(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.description).toBe('First path')
  })

  it('discovers skills declared in .claude-plugin/plugin.json', async () => {
    const root = makeRepo()
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'solo-plugin',
        skills: ['./skills/review'],
      }),
      'utf8'
    )
    writeSkill(root, 'skills/review', 'name: solo-review\ndescription: From plugin.json')
    commitAll(root, 'plugin json')

    const found = await scanSkills(root)
    expect(found.map((s) => s.id)).toEqual(['solo-review'])
    expect(found[0]?.pluginName).toBe('solo-plugin')
  })

  it('uses frontmatter name as install key when it differs from directory name', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/my-folder', 'name: install-key\ndescription: Mismatch')
    commitAll(root, 'mismatch')

    const found = await scanSkills(root)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      id: 'install-key',
      skillPath: 'skills/my-folder',
    })
  })

  it('discovers skills declared in .claude-plugin/marketplace.json', async () => {
    const root = makeRepo()
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        plugins: [
          {
            source: './plugins/demo',
            name: 'demo-plugin',
            skills: ['./skills/review'],
          },
        ],
      }),
      'utf8'
    )
    writeSkill(
      root,
      'plugins/demo/skills/review',
      'name: plugin-review\ndescription: From manifest'
    )
    commitAll(root, 'plugin manifest')

    const found = await scanSkills(root)
    expect(found.map((s) => s.id)).toEqual(['plugin-review'])
    expect(found[0]?.pluginName).toBe('demo-plugin')
  })

  it('records per-skill git provenance at skillPath', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/alpha', 'name: alpha\ndescription: First')
    writeSkill(root, 'skills/beta', 'name: beta\ndescription: Second')
    commitAll(root, 'both')
    const first = git(root, 'rev-parse', 'HEAD')
    writeSkill(root, 'skills/alpha', 'name: alpha\ndescription: First updated')
    commitAll(root, 'update alpha')
    const second = git(root, 'rev-parse', 'HEAD')

    const found = await scanSkills(root)
    const alpha = found.find((s) => s.id === 'alpha')!
    const beta = found.find((s) => s.id === 'beta')!

    expect(alpha.provenanceSha).toBe(second)
    expect(beta.provenanceSha).toBe(first)
    expect(alpha.contentHash).toMatch(/^[0-9a-f]{40}$/)
    expect(beta.contentHash).toMatch(/^[0-9a-f]{40}$/)
    expect(alpha.contentHash).not.toBe(beta.contentHash)
    expect(alpha.contentHash).toBe(git(root, 'rev-parse', 'HEAD:skills/alpha'))
    expect(beta.contentHash).toBe(git(root, 'rev-parse', 'HEAD:skills/beta'))
  })

  it('records nested skill git provenance at the nested skillPath', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/engineering/code-review', 'name: code-review\ndescription: Review')
    commitAll(root, 'nested')
    const sha = git(root, 'rev-parse', 'HEAD')

    const found = await scanSkills(root)
    expect(found[0]).toMatchObject({
      provenanceSha: sha,
      contentHash: git(root, 'rev-parse', 'HEAD:skills/engineering/code-review'),
    })
  })

  it('ignores SKILL.md outside skill container paths (e.g. examples/foo/)', async () => {
    const root = makeRepo()
    writeSkill(root, 'skills/kept', 'name: kept\ndescription: In skills')
    mkdirSync(join(root, 'examples', 'foo'), { recursive: true })
    writeFileSync(
      join(root, 'examples', 'foo', 'SKILL.md'),
      '---\nname: example\ndescription: Outside\n---\n',
      'utf8'
    )
    commitAll(root, 'with example')

    expect((await scanSkills(root)).map((s) => s.id)).toEqual(['kept'])
  })
})
