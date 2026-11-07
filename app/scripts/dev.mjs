import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

/** The Vite port of the primary checkout; worktree instances never use it. */
export const PRIMARY_PORT = 1420

const WORKTREE_PORT_BASE = 1421
const WORKTREE_PORT_SPAN = 500

/** The per-worktree state directory, relative to the worktree root. */
export const STATE_DIR_NAME = '.gotskills-dev'

/** Agent folders seeded into a new fake home so installs have targets. */
export const SEEDED_AGENT_DIRS = ['.claude', '.codex']

/**
 * Environment variables that move an agent's folder outside the home, so an
 * isolated instance would otherwise install into the real agent folders.
 */
export const AGENT_HOME_VARS = [
  'XDG_CONFIG_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'VIBE_HOME',
  'HERMES_HOME',
  'AUTOHAND_HOME',
  'GROK_HOME',
  'SARVAM_HOME',
  'APPDATA',
  'FLATPAK_XDG_CONFIG_HOME',
]

/**
 * The first port a worktree instance tries, stable for a given worktree root.
 * @param {string} worktreeRoot
 */
export function preferredPort(worktreeRoot) {
  const digest = createHash('sha256').update(worktreeRoot).digest()
  return WORKTREE_PORT_BASE + (digest.readUInt32BE(0) % WORKTREE_PORT_SPAN)
}

/**
 * Where a worktree instance keeps its data directory and fake home.
 * @param {string} worktreeRoot
 */
export function instancePaths(worktreeRoot) {
  const root = path.join(worktreeRoot, STATE_DIR_NAME)
  return { root, data: path.join(root, 'data'), home: path.join(root, 'home') }
}

/**
 * The environment for an isolated instance. Explicit `GOTSKILLS_DATA_DIR` and
 * `GOTSKILLS_HOME` values win over the per-worktree defaults.
 * @param {Record<string, string | undefined>} env
 * @param {{ data: string, home: string, port: number }} instance
 */
export function isolatedEnvironment(env, { data, home, port }) {
  const isolated = { ...env }
  for (const name of AGENT_HOME_VARS) delete isolated[name]
  isolated.GOTSKILLS_DATA_DIR = env.GOTSKILLS_DATA_DIR ?? data
  isolated.GOTSKILLS_HOME = env.GOTSKILLS_HOME ?? home
  isolated.GOTSKILLS_DEV_PORT = String(port)
  return isolated
}

/**
 * Arguments for `tauri dev` that point the webview at the instance's port.
 * @param {number} port
 * @param {string[]} extra
 */
export function tauriDevArgs(port, extra = []) {
  const config = { build: { devUrl: `http://localhost:${port}` } }
  return ['dev', '--config', JSON.stringify(config), ...extra]
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function isLinkedWorktree() {
  const gitDir = realpathSync(git('rev-parse', '--absolute-git-dir'))
  const commonDir = realpathSync(git('rev-parse', '--git-common-dir'))
  return gitDir !== commonDir
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: 'localhost' }, () => server.close(() => resolve(true)))
  })
}

async function firstFreePort(start) {
  for (let offset = 0; offset < WORKTREE_PORT_SPAN; offset++) {
    const port = WORKTREE_PORT_BASE + ((start - WORKTREE_PORT_BASE + offset) % WORKTREE_PORT_SPAN)
    if (await isPortFree(port)) return port
  }
  throw new Error('No free dev server port between 1421 and 1920')
}

function seedHome(home) {
  if (existsSync(home)) return
  for (const dir of SEEDED_AGENT_DIRS) mkdirSync(path.join(home, dir), { recursive: true })
}

function run(args, env) {
  const child = spawn('tauri', args, { stdio: 'inherit', env })
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
}

async function main() {
  const extra = process.argv.slice(2)
  if (!isLinkedWorktree()) {
    run(['dev', ...extra], process.env)
    return
  }
  const worktreeRoot = git('rev-parse', '--show-toplevel')
  const paths = instancePaths(worktreeRoot)
  const port = await firstFreePort(preferredPort(worktreeRoot))
  const env = isolatedEnvironment(process.env, { ...paths, port })
  mkdirSync(env.GOTSKILLS_DATA_DIR, { recursive: true })
  seedHome(env.GOTSKILLS_HOME)
  console.log(
    [
      'Isolated worktree instance',
      `  dev server  http://localhost:${port}`,
      `  data        ${env.GOTSKILLS_DATA_DIR}`,
      `  home        ${env.GOTSKILLS_HOME}`,
    ].join('\n')
  )
  run(tauriDevArgs(port, extra), env)
}

if (import.meta.main) await main()
