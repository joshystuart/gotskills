/**
 * Ported from vercel-labs/skills@1.7.0 (MIT License).
 * See mirror/discovery/UPSTREAM.md for maintenance notes.
 */

import { join } from 'node:path'

export interface AgentEnvironment {
  home: string
  env: Readonly<Record<string, string | undefined>>
  exists: (path: string) => boolean
}

export interface Agent {
  id: string
  displayName: string
  nativeFolder: string
  installFolder: string
  detected: boolean
}

interface AgentConfig {
  displayName: string
  skillsDir: string
  globalSkillsDir: string
  detectInstalled: () => boolean
}

const UNIVERSAL_SKILLS_DIR = '.agents/skills'

function createAgents({ home, env, exists }: AgentEnvironment): Record<string, AgentConfig> {
  const envHome = (name: string, fallback: string) => env[name]?.trim() || fallback
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  const codexHome = envHome('CODEX_HOME', join(home, '.codex'))
  const claudeHome = envHome('CLAUDE_CONFIG_DIR', join(home, '.claude'))
  const vibeHome = envHome('VIBE_HOME', join(home, '.vibe'))
  const hermesHome = envHome('HERMES_HOME', join(home, '.hermes'))
  const autohandHome = envHome('AUTOHAND_HOME', join(home, '.autohand'))
  const grokHome = envHome('GROK_HOME', join(home, '.grok'))
  const sarvamHome = envHome('SARVAM_HOME', join(home, '.sarvam'))
  const zedAppDataHome = env.APPDATA?.trim()
  const zedFlatpakConfigHome = env.FLATPAK_XDG_CONFIG_HOME?.trim()

  const inHome = (path: string) => exists(join(home, path))

  const openClawGlobalSkillsDir = () => {
    if (inHome('.openclaw')) return join(home, '.openclaw/skills')
    if (inHome('.clawdbot')) return join(home, '.clawdbot/skills')
    if (inHome('.moltbot')) return join(home, '.moltbot/skills')
    return join(home, '.openclaw/skills')
  }

  return {
    'aider-desk': {
      displayName: 'AiderDesk',
      skillsDir: '.aider-desk/skills',
      globalSkillsDir: join(home, '.aider-desk/skills'),
      detectInstalled: () => inHome('.aider-desk'),
    },
    amp: {
      displayName: 'Amp',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(configHome, 'agents/skills'),
      detectInstalled: () => exists(join(configHome, 'amp')),
    },
    antigravity: {
      displayName: 'Antigravity',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.gemini/antigravity/skills'),
      detectInstalled: () => inHome('.gemini/antigravity'),
    },
    'antigravity-cli': {
      displayName: 'Antigravity CLI',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.gemini/antigravity-cli/skills'),
      detectInstalled: () => inHome('.gemini/antigravity-cli'),
    },
    astrbot: {
      displayName: 'AstrBot',
      skillsDir: 'data/skills',
      globalSkillsDir: join(home, '.astrbot/data/skills'),
      detectInstalled: () => inHome('.astrbot'),
    },
    'autohand-code': {
      displayName: 'Autohand Code CLI',
      skillsDir: '.autohand/skills',
      globalSkillsDir: join(autohandHome, 'skills'),
      detectInstalled: () => exists(autohandHome),
    },
    augment: {
      displayName: 'Augment',
      skillsDir: '.augment/skills',
      globalSkillsDir: join(home, '.augment/skills'),
      detectInstalled: () => inHome('.augment'),
    },
    bob: {
      displayName: 'IBM Bob',
      skillsDir: '.bob/skills',
      globalSkillsDir: join(home, '.bob/skills'),
      detectInstalled: () => inHome('.bob'),
    },
    'claude-code': {
      displayName: 'Claude Code',
      skillsDir: '.claude/skills',
      globalSkillsDir: join(claudeHome, 'skills'),
      detectInstalled: () => exists(claudeHome),
    },
    openclaw: {
      displayName: 'OpenClaw',
      skillsDir: 'skills',
      globalSkillsDir: openClawGlobalSkillsDir(),
      detectInstalled: () => inHome('.openclaw') || inHome('.clawdbot') || inHome('.moltbot'),
    },
    cline: {
      displayName: 'Cline',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.agents', 'skills'),
      detectInstalled: () => inHome('.cline'),
    },
    'codearts-agent': {
      displayName: 'CodeArts Agent',
      skillsDir: '.codeartsdoer/skills',
      globalSkillsDir: join(home, '.codeartsdoer/skills'),
      detectInstalled: () => inHome('.codeartsdoer'),
    },
    codebuddy: {
      displayName: 'CodeBuddy',
      skillsDir: '.codebuddy/skills',
      globalSkillsDir: join(home, '.codebuddy/skills'),
      detectInstalled: () => inHome('.codebuddy'),
    },
    codemaker: {
      displayName: 'Codemaker',
      skillsDir: '.codemaker/skills',
      globalSkillsDir: join(home, '.codemaker/skills'),
      detectInstalled: () => inHome('.codemaker'),
    },
    codestudio: {
      displayName: 'Code Studio',
      skillsDir: '.codestudio/skills',
      globalSkillsDir: join(home, '.codestudio/skills'),
      detectInstalled: () => inHome('.codestudio'),
    },
    codex: {
      displayName: 'Codex',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(codexHome, 'skills'),
      detectInstalled: () => exists(codexHome) || exists('/etc/codex'),
    },
    'command-code': {
      displayName: 'Command Code',
      skillsDir: '.commandcode/skills',
      globalSkillsDir: join(home, '.commandcode/skills'),
      detectInstalled: () => inHome('.commandcode'),
    },
    continue: {
      displayName: 'Continue',
      skillsDir: '.continue/skills',
      globalSkillsDir: join(home, '.continue/skills'),
      detectInstalled: () => inHome('.continue'),
    },
    cortex: {
      displayName: 'Cortex Code',
      skillsDir: '.cortex/skills',
      globalSkillsDir: join(home, '.snowflake/cortex/skills'),
      detectInstalled: () => inHome('.snowflake/cortex'),
    },
    crush: {
      displayName: 'Crush',
      skillsDir: '.crush/skills',
      globalSkillsDir: join(home, '.config/crush/skills'),
      detectInstalled: () => inHome('.config/crush'),
    },
    cursor: {
      displayName: 'Cursor',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.cursor/skills'),
      detectInstalled: () => inHome('.cursor'),
    },
    deepagents: {
      displayName: 'Deep Agents',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.deepagents/agent/skills'),
      detectInstalled: () => inHome('.deepagents'),
    },
    devin: {
      displayName: 'Devin for Terminal',
      skillsDir: '.devin/skills',
      globalSkillsDir: join(configHome, 'devin/skills'),
      detectInstalled: () => exists(join(configHome, 'devin')),
    },
    dexto: {
      displayName: 'Dexto',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.agents/skills'),
      detectInstalled: () => inHome('.dexto'),
    },
    droid: {
      displayName: 'Droid',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.factory/skills'),
      detectInstalled: () => inHome('.factory'),
    },
    firebender: {
      displayName: 'Firebender',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.firebender/skills'),
      detectInstalled: () => inHome('.firebender'),
    },
    forgecode: {
      displayName: 'ForgeCode',
      skillsDir: '.forge/skills',
      globalSkillsDir: join(home, '.forge/skills'),
      detectInstalled: () => inHome('.forge'),
    },
    fx: {
      displayName: 'fx',
      skillsDir: '.fx/skills',
      globalSkillsDir: join(home, '.fx/skills'),
      detectInstalled: () => inHome('.fx'),
    },
    'gemini-cli': {
      displayName: 'Gemini CLI',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.gemini/skills'),
      detectInstalled: () => inHome('.gemini'),
    },
    'github-copilot': {
      displayName: 'GitHub Copilot',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.copilot/skills'),
      detectInstalled: () => inHome('.copilot'),
    },
    goose: {
      displayName: 'Goose',
      skillsDir: '.goose/skills',
      globalSkillsDir: join(configHome, 'goose/skills'),
      detectInstalled: () => exists(join(configHome, 'goose')),
    },
    grok: {
      displayName: 'Grok Build',
      skillsDir: '.grok/skills',
      globalSkillsDir: join(grokHome, 'skills'),
      detectInstalled: () => exists(grokHome),
    },
    'hermes-agent': {
      displayName: 'Hermes Agent',
      skillsDir: '.hermes/skills',
      globalSkillsDir: join(hermesHome, 'skills'),
      detectInstalled: () => exists(hermesHome),
    },
    'inference-sh': {
      displayName: 'inference.sh',
      skillsDir: '.inferencesh/skills',
      globalSkillsDir: join(home, '.inferencesh/skills'),
      detectInstalled: () => inHome('.inferencesh'),
    },
    jazz: {
      displayName: 'Jazz',
      skillsDir: '.jazz/skills',
      globalSkillsDir: join(home, '.jazz/skills'),
      detectInstalled: () => inHome('.jazz'),
    },
    junie: {
      displayName: 'Junie',
      skillsDir: '.junie/skills',
      globalSkillsDir: join(home, '.junie/skills'),
      detectInstalled: () => inHome('.junie'),
    },
    'iflow-cli': {
      displayName: 'iFlow CLI',
      skillsDir: '.iflow/skills',
      globalSkillsDir: join(home, '.iflow/skills'),
      detectInstalled: () => inHome('.iflow'),
    },
    kilo: {
      displayName: 'Kilo Code',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.kilo/skills'),
      detectInstalled: () => inHome('.kilo') || inHome('.kilocode'),
    },
    kimchi: {
      displayName: 'Kimchi',
      skillsDir: '.kimchi/skills',
      globalSkillsDir: join(home, '.config', 'kimchi', 'harness', 'skills'),
      detectInstalled: () => exists(join(home, '.config', 'kimchi')),
    },
    'kimi-code-cli': {
      displayName: 'Kimi Code CLI',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.agents/skills'),
      detectInstalled: () => inHome('.kimi-code') || inHome('.kimi'),
    },
    'kiro-cli': {
      displayName: 'Kiro CLI',
      skillsDir: '.kiro/skills',
      globalSkillsDir: join(home, '.kiro/skills'),
      detectInstalled: () => inHome('.kiro'),
    },
    kode: {
      displayName: 'Kode',
      skillsDir: '.kode/skills',
      globalSkillsDir: join(home, '.kode/skills'),
      detectInstalled: () => inHome('.kode'),
    },
    lingma: {
      displayName: 'Lingma',
      skillsDir: '.lingma/skills',
      globalSkillsDir: join(home, '.lingma/skills'),
      detectInstalled: () => inHome('.lingma'),
    },
    loaf: {
      displayName: 'Loaf',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.agents/skills'),
      detectInstalled: () => inHome('.loaf'),
    },
    mcpjam: {
      displayName: 'MCPJam',
      skillsDir: '.mcpjam/skills',
      globalSkillsDir: join(home, '.mcpjam/skills'),
      detectInstalled: () => inHome('.mcpjam'),
    },
    'minimax-code': {
      displayName: 'MiniMax Code',
      skillsDir: '.minimax/skills',
      globalSkillsDir: join(home, '.minimax/skills'),
      detectInstalled: () => inHome('.minimax') || exists('/Applications/MiniMax Code.app'),
    },
    'mistral-vibe': {
      displayName: 'Mistral Vibe',
      skillsDir: '.vibe/skills',
      globalSkillsDir: join(vibeHome, 'skills'),
      detectInstalled: () => exists(vibeHome),
    },
    moxby: {
      displayName: 'Moxby',
      skillsDir: '.moxby/skills',
      globalSkillsDir: join(home, '.moxby/skills'),
      detectInstalled: () => inHome('.moxby'),
    },
    mux: {
      displayName: 'Mux',
      skillsDir: '.mux/skills',
      globalSkillsDir: join(home, '.mux/skills'),
      detectInstalled: () => inHome('.mux'),
    },
    opencode: {
      displayName: 'OpenCode',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(configHome, 'opencode/skills'),
      detectInstalled: () => exists(join(configHome, 'opencode')),
    },
    openhands: {
      displayName: 'OpenHands',
      skillsDir: '.openhands/skills',
      globalSkillsDir: join(home, '.openhands/skills'),
      detectInstalled: () => inHome('.openhands'),
    },
    ona: {
      displayName: 'Ona',
      skillsDir: '.ona/skills',
      globalSkillsDir: join(home, '.ona/skills'),
      detectInstalled: () => inHome('.ona'),
    },
    pi: {
      displayName: 'Pi',
      skillsDir: '.pi/skills',
      globalSkillsDir: join(home, '.pi/agent/skills'),
      detectInstalled: () => inHome('.pi/agent'),
    },
    'posit-assistant': {
      displayName: 'Posit Assistant',
      skillsDir: '.posit/assistant/skills',
      globalSkillsDir: join(home, '.posit/assistant/skills'),
      detectInstalled: () => inHome('.posit/assistant') || inHome('.positai'),
    },
    qoder: {
      displayName: 'Qoder',
      skillsDir: '.qoder/skills',
      globalSkillsDir: join(home, '.qoder/skills'),
      detectInstalled: () => inHome('.qoder'),
    },
    'qoder-cn': {
      displayName: 'Qoder CN',
      skillsDir: '.qoder/skills',
      globalSkillsDir: join(home, '.qoder-cn/skills'),
      detectInstalled: () => inHome('.qoder-cn'),
    },
    'qwen-code': {
      displayName: 'Qwen Code',
      skillsDir: '.qwen/skills',
      globalSkillsDir: join(home, '.qwen/skills'),
      detectInstalled: () => inHome('.qwen'),
    },
    replit: {
      displayName: 'Replit',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(configHome, 'agents/skills'),
      detectInstalled: () => false,
    },
    reasonix: {
      displayName: 'Reasonix',
      skillsDir: '.reasonix/skills',
      globalSkillsDir: join(home, '.reasonix/skills'),
      detectInstalled: () => inHome('.reasonix'),
    },
    rovodev: {
      displayName: 'Rovo Dev',
      skillsDir: '.rovodev/skills',
      globalSkillsDir: join(home, '.rovodev/skills'),
      detectInstalled: () => inHome('.rovodev'),
    },
    roo: {
      displayName: 'Roo Code',
      skillsDir: '.roo/skills',
      globalSkillsDir: join(home, '.roo/skills'),
      detectInstalled: () => inHome('.roo'),
    },
    'sarvam-code': {
      displayName: 'Sarvam Code',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.agents/skills'),
      detectInstalled: () => exists(sarvamHome),
    },
    'tabnine-cli': {
      displayName: 'Tabnine CLI',
      skillsDir: '.tabnine/agent/skills',
      globalSkillsDir: join(home, '.tabnine/agent/skills'),
      detectInstalled: () => inHome('.tabnine'),
    },
    terramind: {
      displayName: 'Terramind',
      skillsDir: '.terramind/skills',
      globalSkillsDir: join(home, '.terramind/skills'),
      detectInstalled: () => inHome('.terramind'),
    },
    tinycloud: {
      displayName: 'Tinycloud',
      skillsDir: '.tinycloud/skills',
      globalSkillsDir: join(home, '.tinycloud/skills'),
      detectInstalled: () => inHome('.tinycloud'),
    },
    trae: {
      displayName: 'Trae',
      skillsDir: '.trae/skills',
      globalSkillsDir: join(home, '.trae/skills'),
      detectInstalled: () => inHome('.trae'),
    },
    'trae-cn': {
      displayName: 'Trae CN',
      skillsDir: '.trae/skills',
      globalSkillsDir: join(home, '.trae-cn/skills'),
      detectInstalled: () => inHome('.trae-cn'),
    },
    warp: {
      displayName: 'Warp',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.agents/skills'),
      detectInstalled: () => inHome('.warp'),
    },
    windsurf: {
      displayName: 'Windsurf',
      skillsDir: '.windsurf/skills',
      globalSkillsDir: join(home, '.codeium/windsurf/skills'),
      detectInstalled: () => inHome('.codeium/windsurf'),
    },
    zed: {
      displayName: 'Zed',
      skillsDir: '.agents/skills',
      globalSkillsDir: join(home, '.agents/skills'),
      detectInstalled: () =>
        exists(join(configHome, 'zed')) ||
        (!!zedAppDataHome && exists(join(zedAppDataHome, 'Zed'))) ||
        (!!zedFlatpakConfigHome && exists(join(zedFlatpakConfigHome, 'zed'))),
    },
    zcode: {
      displayName: 'ZCode',
      skillsDir: '.zcode/skills',
      globalSkillsDir: join(home, '.zcode/skills'),
      detectInstalled: () => inHome('.zcode') || exists('/Applications/ZCode.app'),
    },
    zencoder: {
      displayName: 'Zencoder',
      skillsDir: '.zencoder/skills',
      globalSkillsDir: join(home, '.zencoder/skills'),
      detectInstalled: () => inHome('.zencoder'),
    },
    zenflow: {
      displayName: 'Zenflow',
      skillsDir: '.zencoder/skills',
      globalSkillsDir: join(home, '.zencoder/skills'),
      detectInstalled: () => inHome('.zencoder'),
    },
    neovate: {
      displayName: 'Neovate',
      skillsDir: '.neovate/skills',
      globalSkillsDir: join(home, '.neovate/skills'),
      detectInstalled: () => inHome('.neovate'),
    },
    pochi: {
      displayName: 'Pochi',
      skillsDir: '.pochi/skills',
      globalSkillsDir: join(home, '.pochi/skills'),
      detectInstalled: () => inHome('.pochi'),
    },
    adal: {
      displayName: 'AdaL',
      skillsDir: '.adal/skills',
      globalSkillsDir: join(home, '.adal/skills'),
      detectInstalled: () => inHome('.adal'),
    },
  }
}

export function agentTable(environment: AgentEnvironment): Agent[] {
  const sharedTarget = join(environment.home, UNIVERSAL_SKILLS_DIR)
  return Object.entries(createAgents(environment)).map(([id, config]) => ({
    id,
    displayName: config.displayName,
    nativeFolder: config.globalSkillsDir,
    installFolder:
      config.skillsDir === UNIVERSAL_SKILLS_DIR ? sharedTarget : config.globalSkillsDir,
    detected: config.detectInstalled(),
  }))
}
