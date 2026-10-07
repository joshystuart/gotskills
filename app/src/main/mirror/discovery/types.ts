/**
 * Ported from vercel-labs/skills@1.7.0 (MIT License).
 * See mirror/discovery/UPSTREAM.md for maintenance notes.
 */

export interface Skill {
  name: string
  description: string
  path: string
  /** Raw SKILL.md content for hashing */
  rawContent?: string
  /** Name of the plugin this skill belongs to (if any) */
  pluginName?: string
  metadata?: Record<string, unknown>
}
