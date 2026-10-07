import { relative } from 'node:path'
import { discoverSkills } from './discovery/skills.ts'
import { git } from './git-exec'

export interface ScannedSkill {
  /** Install key — frontmatter `name`, matching CLI `--skill` resolution. */
  id: string
  /** POSIX-relative path from mirror root to the skill directory (git provenance). */
  skillPath: string
  name: string
  description: string
  /** Last-touching commit SHA for skillPath (provenance). */
  provenanceSha: string
  /** Git tree OID of skillPath at HEAD (content-hash for update detection). */
  contentHash: string
  /** ISO-8601 commit date of the provenance SHA. */
  updatedAt: string
  /** Optional grouping metadata from a plugin manifest. */
  pluginName?: string
}

function toPosixSkillPath(mirrorPath: string, skillDir: string): string {
  return relative(mirrorPath, skillDir).split('\\').join('/')
}

/**
 * Discover skills via the ported vercel-labs/skills rules, then attach git
 * provenance per discovered path. Malformed or internal skills are skipped.
 */
export async function scanSkills(mirrorPath: string): Promise<ScannedSkill[]> {
  const discovered = await discoverSkills(mirrorPath)
  const results: ScannedSkill[] = []

  for (const skill of discovered) {
    const skillPath = toPosixSkillPath(mirrorPath, skill.path)

    let provenanceSha: string
    let contentHash: string
    let updatedAt: string
    try {
      provenanceSha = await git(mirrorPath, 'log', '-1', '--format=%H', '--', skillPath)
      contentHash = await git(mirrorPath, 'rev-parse', `HEAD:${skillPath}`)
      updatedAt = await git(mirrorPath, 'log', '-1', '--format=%cI', '--', skillPath)
    } catch (err) {
      console.warn(`[scan] skip ${skill.name} (${skillPath}): git metadata failed`, err)
      continue
    }

    results.push({
      id: skill.name,
      skillPath,
      name: skill.name,
      description: skill.description,
      provenanceSha,
      contentHash,
      updatedAt,
      ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
    })
  }

  return results.sort((a, b) => a.id.localeCompare(b.id))
}
