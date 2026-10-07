import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSkillsCliRunner } from '../../installer/cli'
import { agentTable } from './agents'

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort()
}

describe('vendored agent table contract with the real skills CLI', () => {
  const dirs: string[] = []
  let source: string

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  beforeEach(() => {
    vi.stubEnv('XDG_CONFIG_HOME', '')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    source = tempDir('igs-agents-source-')
    mkdirSync(join(source, 'skills', 'alpha'), { recursive: true })
    writeFileSync(
      join(source, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: Contract fixture\n---\n\n# alpha\n',
      'utf8'
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function installInto(agentId: string): Promise<string> {
    const home = tempDir('igs-agents-home-')
    const result = await createSkillsCliRunner()(
      ['add', source, '--skill', 'alpha', '-g', '-a', agentId, '-y', '--copy'],
      { home }
    )
    expect(result.code, result.stderr).toBe(0)
    return home
  }

  function installFolderOf(agentId: string, home: string): string {
    const agent = agentTable({ home, env: process.env, exists: existsSync }).find(
      (a) => a.id === agentId
    )
    if (!agent) throw new Error(`agent table has no ${agentId}`)
    return agent.installFolder
  }

  it.each([
    ['claude-code', '.claude/skills'],
    ['goose', '.config/goose/skills'],
    ['cursor', '.agents/skills'],
  ])('installs %s only into the install folder the table gives', async (agentId, folder) => {
    const home = await installInto(agentId)
    expect(installFolderOf(agentId, home)).toBe(join(home, folder))
    expect(filesUnder(home)).toEqual([join(folder, 'alpha', 'SKILL.md')])
  })

  it('installs universal only into the Shared Target', async () => {
    const home = await installInto('universal')
    expect(installFolderOf('cursor', home)).toBe(join(home, '.agents/skills'))
    expect(filesUnder(home)).toEqual([join('.agents/skills', 'alpha', 'SKILL.md')])
  })
})
