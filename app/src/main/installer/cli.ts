import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export const SKILLS_CLI_VERSION = '1.7.0'

export interface SkillsCliResult {
  code: number
  stdout: string
  stderr: string
}

export type RunSkillsCli = (args: string[], opts: { home: string }) => Promise<SkillsCliResult>

/**
 * Resolve the vendored skills CLI entry for both electron-vite dev and a
 * packaged app (asar.unpacked). Never relies on host Node/npx.
 */
export function resolveSkillsCliEntry(): string {
  const require = createRequire(import.meta.url)
  const pkgJson = require.resolve('skills/package.json')
  let entry = join(dirname(pkgJson), 'bin', 'cli.mjs')
  if (entry.includes('app.asar')) {
    entry = entry.replace('app.asar', 'app.asar.unpacked')
  }
  return entry
}

function sanitizedEnv(home: string): NodeJS.ProcessEnv {
  const pathParts = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']
  if (process.env.PATH) pathParts.push(process.env.PATH)
  return {
    ...process.env,
    HOME: home,
    ELECTRON_RUN_AS_NODE: '1',
    PATH: pathParts.join(':'),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    CI: '1',
  }
}

/** Default runner: fork the vendored CLI under Electron-as-Node (or plain Node in tests). */
export function createSkillsCliRunner(cliEntry = resolveSkillsCliEntry()): RunSkillsCli {
  return (args, opts) =>
    new Promise((resolve, reject) => {
      const child = fork(cliEntry, args, {
        env: sanitizedEnv(opts.home),
        silent: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString()
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        resolve({ code: code ?? 1, stdout, stderr })
      })
    })
}
