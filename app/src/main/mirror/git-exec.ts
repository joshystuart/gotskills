import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Force non-interactive git: never prompt on a terminal, never invoke a
 * credential helper or askpass GUI. Private HTTPS access relies solely on
 * credentials system git already has cached; anything else fails fast rather
 * than hanging the app on a hidden prompt.
 */
const NON_INTERACTIVE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
}

/** Config flags that neutralise any interactive credential helper/askpass. */
const NON_INTERACTIVE_ARGS = ['-c', 'credential.helper=', '-c', 'core.askPass=']

/** Run a git subcommand in `cwd`; throws on non-zero exit. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...NON_INTERACTIVE_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
    env: NON_INTERACTIVE_ENV,
  })
  return stdout.trim()
}

/** Run git without a working tree (e.g. clone into a new path). */
export async function gitGlobal(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...NON_INTERACTIVE_ARGS, ...args], {
    encoding: 'utf8',
    env: NON_INTERACTIVE_ENV,
  })
  return stdout.trim()
}
