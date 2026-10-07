import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { git, gitGlobal } from './git-exec'

/** True when a usable `git` binary is on PATH (Xcode CLT / Homebrew). */
export function isGitAvailable(): boolean {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' })
  return result.status === 0
}

/**
 * Ask the remote for its default branch without cloning. Throws when the remote
 * is inaccessible (offline / access-required) so the caller can require an
 * explicit branch instead. Runs non-interactively via gitGlobal.
 */
export async function detectDefaultBranch(url: string): Promise<string> {
  const out = await gitGlobal('ls-remote', '--symref', url, 'HEAD')
  const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(out)
  if (!match) {
    throw new Error('Unable to determine the default branch for this registry')
  }
  return match[1]
}

export interface MirrorConfig {
  /** Remote URL (https://… or file://…). */
  url: string
  branch: string
  /** Local working-tree clone path. */
  mirrorPath: string
}

/**
 * Ensure a local working-tree mirror of {url, branch}.
 * Clones on first use; thereafter fetch + hard-reset to origin/<branch>
 * (never merge — 004). Git runs as child processes (non-blocking).
 * An existing mirror fetches the branch with an explicit refspec, because a
 * --single-branch clone of a different branch has no origin/<branch> ref.
 */
export async function ensureMirror(config: MirrorConfig): Promise<{ revision: string }> {
  const { url, branch, mirrorPath } = config
  mkdirSync(dirname(mirrorPath), { recursive: true })

  if (!existsSync(mirrorPath)) {
    mkdirSync(mirrorPath, { recursive: true })
    await gitGlobal('clone', '--branch', branch, '--single-branch', url, mirrorPath)
    await git(mirrorPath, 'fetch', 'origin', branch)
    await git(mirrorPath, 'reset', '--hard', `origin/${branch}`)
  } else {
    await git(mirrorPath, 'remote', 'set-url', 'origin', url)
    await git(mirrorPath, 'fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`)
    await git(mirrorPath, 'checkout', '-B', branch, `origin/${branch}`)
    await git(mirrorPath, 'reset', '--hard', `origin/${branch}`)
  }

  const revision = await git(mirrorPath, 'rev-parse', 'HEAD')
  return { revision }
}
