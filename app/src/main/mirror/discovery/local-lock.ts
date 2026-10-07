/**
 * Ported from vercel-labs/skills@1.7.0 (MIT License).
 * See mirror/discovery/UPSTREAM.md for maintenance notes.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const LOCAL_LOCK_FILE = 'skills-lock.json'
const CURRENT_VERSION = 1

/**
 * Represents a single skill entry in the local (project) lock file.
 *
 * Intentionally minimal and timestamp-free to minimize merge conflicts.
 * Two branches adding different skills produce non-overlapping JSON keys
 * that git can auto-merge cleanly.
 */
export interface LocalSkillLockEntry {
  /** Where the skill came from: npm package name, owner/repo, local path, etc. */
  source: string
  sourceUrl?: string
  /** Branch or tag ref used for installation */
  ref?: string
  /** The provider/source type (e.g., "github", "node_modules", "local") */
  sourceType: string
  /**
   * Path to the skill's SKILL.md within the source repo (e.g., "skills/pdf/SKILL.md").
   * Required to re-install only this skill on update — without it, an update would
   * refetch every skill in the source repo. Optional for backward compatibility with
   * lock files written before this field existed, and omitted for non-repo sources
   * (node_modules, local paths) where there is no subfolder to target.
   */
  skillPath?: string
  /**
   * SHA-256 hash computed from all files in the skill folder.
   * Unlike the global lock which uses GitHub tree SHA, the local lock
   * computes the hash from actual file contents on disk.
   */
  computedHash: string
  /**
   * Eve subagent targets this skill was installed into, so `update` can
   * restore the same placement. Each entry is an Eve subagent directory name;
   * the empty string `''` denotes the root agent (`agent/skills`). Omitted for
   * non-Eve installs and for plain Eve root installs (treated as `['']`).
   */
  subagents?: string[]
  wellKnownDigest?: string
}

/**
 * The structure of the local (project-scoped) skill lock file.
 * This file is meant to be checked into version control.
 *
 * Skills are sorted alphabetically by name when written to produce
 * deterministic output and minimize merge conflicts.
 */
export interface LocalSkillLockFile {
  /** Schema version for future migrations */
  version: number
  /** Map of skill name to its lock entry (sorted alphabetically) */
  skills: Record<string, LocalSkillLockEntry>
}

/**
 * Get the path to the local skill lock file for a project.
 */
export function getLocalLockPath(cwd?: string): string {
  return join(cwd || process.cwd(), LOCAL_LOCK_FILE)
}

/**
 * Read the local skill lock file.
 * Returns an empty lock file structure if the file doesn't exist
 * or is corrupted (e.g., merge conflict markers).
 */
export async function readLocalLock(cwd?: string): Promise<LocalSkillLockFile> {
  const lockDir = cwd || process.cwd()
  const lockPath = getLocalLockPath(lockDir)

  try {
    const content = await readFile(lockPath, 'utf-8')
    const parsed = JSON.parse(content) as LocalSkillLockFile

    if (typeof parsed.version !== 'number' || !parsed.skills) {
      return createEmptyLocalLock()
    }

    if (parsed.version < CURRENT_VERSION) {
      return createEmptyLocalLock()
    }

    for (const entry of Object.values(parsed.skills)) {
      if (entry.sourceType === 'local' && !isAbsolute(entry.source)) {
        entry.source = resolve(lockDir, entry.source)
      }
    }

    return parsed
  } catch {
    return createEmptyLocalLock()
  }
}

export function createEmptyLocalLock(): LocalSkillLockFile {
  return {
    version: CURRENT_VERSION,
    skills: {},
  }
}
