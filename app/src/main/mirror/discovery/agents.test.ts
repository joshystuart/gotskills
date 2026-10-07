import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentTable } from './agents'

const home = '/home/tester'

function table(env: Record<string, string> = {}, existing: string[] = []) {
  const present = new Set(existing)
  return agentTable({ home, env, exists: (path) => present.has(path) })
}

function agent(id: string, env: Record<string, string> = {}, existing: string[] = []) {
  const found = table(env, existing).find((a) => a.id === id)
  if (!found) throw new Error(`missing agent ${id}`)
  return found
}

describe('vendored agent table', () => {
  it('leaves out universal, Eve and PromptScript', () => {
    const ids = table().map((a) => a.id)
    expect(ids).not.toContain('universal')
    expect(ids).not.toContain('eve')
    expect(ids).not.toContain('promptscript')
  })

  it('includes every other upstream agent with its folders and detection result', () => {
    const ids = table().map((a) => a.id)
    expect([...ids].sort()).toEqual([
      'adal',
      'aider-desk',
      'amp',
      'antigravity',
      'antigravity-cli',
      'astrbot',
      'augment',
      'autohand-code',
      'bob',
      'claude-code',
      'cline',
      'codearts-agent',
      'codebuddy',
      'codemaker',
      'codestudio',
      'codex',
      'command-code',
      'continue',
      'cortex',
      'crush',
      'cursor',
      'deepagents',
      'devin',
      'dexto',
      'droid',
      'firebender',
      'forgecode',
      'fx',
      'gemini-cli',
      'github-copilot',
      'goose',
      'grok',
      'hermes-agent',
      'iflow-cli',
      'inference-sh',
      'jazz',
      'junie',
      'kilo',
      'kimchi',
      'kimi-code-cli',
      'kiro-cli',
      'kode',
      'lingma',
      'loaf',
      'mcpjam',
      'minimax-code',
      'mistral-vibe',
      'moxby',
      'mux',
      'neovate',
      'ona',
      'openclaw',
      'opencode',
      'openhands',
      'pi',
      'pochi',
      'posit-assistant',
      'qoder',
      'qoder-cn',
      'qwen-code',
      'reasonix',
      'replit',
      'roo',
      'rovodev',
      'sarvam-code',
      'tabnine-cli',
      'terramind',
      'tinycloud',
      'trae',
      'trae-cn',
      'warp',
      'windsurf',
      'zcode',
      'zed',
      'zencoder',
      'zenflow',
    ])
  })

  it('reads nothing but the injected home, env and exists', () => {
    const checked: string[] = []
    const agents = agentTable({
      home,
      env: {},
      exists: (path) => {
        checked.push(path)
        return false
      },
    })
    for (const a of agents) {
      expect(a.displayName).not.toBe('')
      expect(a.nativeFolder.startsWith(`${home}/`)).toBe(true)
      expect(a.installFolder.startsWith(`${home}/`)).toBe(true)
      expect(a.detected).toBe(false)
    }
    expect(checked.filter((path) => !path.startsWith(`${home}/`)).sort()).toEqual([
      '/Applications/MiniMax Code.app',
      '/Applications/ZCode.app',
      '/etc/codex',
    ])
  })

  it('gives own-folder agents their native folder as install folder', () => {
    expect(agent('windsurf', {}, ['/home/tester/.codeium/windsurf'])).toEqual({
      id: 'windsurf',
      displayName: 'Windsurf',
      nativeFolder: '/home/tester/.codeium/windsurf/skills',
      installFolder: '/home/tester/.codeium/windsurf/skills',
      detected: true,
    })
  })

  it('gives universal agents the Shared Target as install folder', () => {
    expect(agent('cursor')).toEqual({
      id: 'cursor',
      displayName: 'Cursor',
      nativeFolder: '/home/tester/.cursor/skills',
      installFolder: '/home/tester/.agents/skills',
      detected: false,
    })
    expect(agent('opencode').installFolder).toBe('/home/tester/.agents/skills')
  })

  it('routes absolute detection checks through the injected exists', () => {
    expect(agent('zcode').detected).toBe(false)
    expect(agent('zcode', {}, ['/Applications/ZCode.app']).detected).toBe(true)
    expect(agent('codex', {}, ['/etc/codex']).detected).toBe(true)
  })

  it('never detects from the working directory', () => {
    const cwd = process.cwd()
    const existing = [join(cwd, 'data/skills'), join(cwd, '.codebuddy')]
    expect(agent('astrbot', {}, existing).detected).toBe(false)
    expect(agent('codebuddy', {}, existing).detected).toBe(false)
  })

  it('moves the Codex folder with CODEX_HOME', () => {
    const codex = agent('codex', { CODEX_HOME: '/opt/codex' }, ['/opt/codex'])
    expect(codex.nativeFolder).toBe('/opt/codex/skills')
    expect(codex.detected).toBe(true)
  })

  it('moves the Claude Code folder with CLAUDE_CONFIG_DIR', () => {
    const claude = agent('claude-code', { CLAUDE_CONFIG_DIR: '/opt/claude' }, ['/opt/claude'])
    expect(claude.nativeFolder).toBe('/opt/claude/skills')
    expect(claude.installFolder).toBe('/opt/claude/skills')
    expect(claude.detected).toBe(true)
  })

  it('moves the Goose folder with XDG_CONFIG_HOME', () => {
    const goose = agent('goose', { XDG_CONFIG_HOME: '/opt/xdg' }, ['/opt/xdg/goose'])
    expect(goose.installFolder).toBe('/opt/xdg/goose/skills')
    expect(goose.detected).toBe(true)
    expect(agent('goose').installFolder).toBe('/home/tester/.config/goose/skills')
  })
})
