/**
 * Ported from vercel-labs/skills@1.7.0 (MIT License).
 * See mirror/discovery/UPSTREAM.md for maintenance notes.
 */

import { readFile } from 'node:fs/promises'
import { join, dirname, resolve, normalize, sep } from 'node:path'

/**
 * Check if a path is contained within a base directory.
 * Prevents path traversal attacks via `..` segments or absolute paths.
 */
function isContainedIn(targetPath: string, basePath: string): boolean {
  const normalizedBase = normalize(resolve(basePath))
  const normalizedTarget = normalize(resolve(targetPath))
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase
}

/**
 * Validate that a relative path follows Claude Code conventions.
 * Paths must start with './' per the plugin manifest spec.
 */
function isValidRelativePath(path: string): boolean {
  return path.startsWith('./')
}

/**
 * Plugin manifest types
 */
interface PluginManifestEntry {
  source?: string | { source: string; repo?: string }
  skills?: string[]
  /** Optional name for grouping skills (e.g., "document-skills") */
  name?: string
}

interface MarketplaceManifest {
  metadata?: { pluginRoot?: string }
  plugins?: PluginManifestEntry[]
}

interface PluginManifest {
  skills?: string[]
  name?: string
}

/**
 * Extract skill search directories from plugin manifests.
 * Handles both marketplace.json (multi-plugin) and plugin.json (single plugin).
 * Only resolves local paths - remote sources are skipped.
 *
 * Returns directories that CONTAIN skills (to be searched for child SKILL.md files).
 * For explicit skill paths in manifests, adds the parent directory so the
 * existing discovery loop finds them.
 */
export async function getPluginSkillPaths(basePath: string): Promise<string[]> {
  const searchDirs: string[] = []

  /**
   * Helper: add skill paths for a plugin at a given base path
   * Only adds paths that are contained within basePath (security: prevents traversal)
   */
  const addPluginSkillPaths = (pluginBase: string, skills?: string[]) => {
    if (!isContainedIn(pluginBase, basePath)) return

    if (skills && skills.length > 0) {
      for (const skillPath of skills) {
        if (!isValidRelativePath(skillPath)) continue

        const skillDir = dirname(join(pluginBase, skillPath))
        if (isContainedIn(skillDir, basePath)) {
          searchDirs.push(skillDir)
        }
      }
    }
    searchDirs.push(join(pluginBase, 'skills'))
  }

  try {
    const content = await readFile(join(basePath, '.claude-plugin/marketplace.json'), 'utf-8')
    const manifest: MarketplaceManifest = JSON.parse(content)
    const pluginRoot = manifest.metadata?.pluginRoot

    const validPluginRoot = pluginRoot === undefined || isValidRelativePath(pluginRoot)

    if (validPluginRoot) {
      for (const plugin of manifest.plugins ?? []) {
        if (typeof plugin.source !== 'string' && plugin.source !== undefined) continue

        if (plugin.source !== undefined && !isValidRelativePath(plugin.source)) continue

        const pluginBase = join(basePath, pluginRoot ?? '', plugin.source ?? '')
        addPluginSkillPaths(pluginBase, plugin.skills)
      }
    }
  } catch {}

  try {
    const content = await readFile(join(basePath, '.claude-plugin/plugin.json'), 'utf-8')
    const manifest: PluginManifest = JSON.parse(content)
    addPluginSkillPaths(basePath, manifest.skills)
  } catch {}

  return searchDirs
}

/**
 * Get a map of skill directory paths to plugin names from plugin manifests.
 * This allows grouping skills by their parent plugin.
 *
 * Returns Map<AbsolutePath, PluginName>
 */
export async function getPluginGroupings(basePath: string): Promise<Map<string, string>> {
  const groupings = new Map<string, string>()

  try {
    const content = await readFile(join(basePath, '.claude-plugin/marketplace.json'), 'utf-8')
    const manifest: MarketplaceManifest = JSON.parse(content)
    const pluginRoot = manifest.metadata?.pluginRoot

    const validPluginRoot = pluginRoot === undefined || isValidRelativePath(pluginRoot)

    if (validPluginRoot) {
      for (const plugin of manifest.plugins ?? []) {
        if (!plugin.name) continue

        if (typeof plugin.source !== 'string' && plugin.source !== undefined) continue

        if (plugin.source !== undefined && !isValidRelativePath(plugin.source)) continue

        const pluginBase = join(basePath, pluginRoot ?? '', plugin.source ?? '')

        if (!isContainedIn(pluginBase, basePath)) continue

        if (plugin.skills && plugin.skills.length > 0) {
          for (const skillPath of plugin.skills) {
            if (!isValidRelativePath(skillPath)) continue

            const skillDir = join(pluginBase, skillPath)
            if (isContainedIn(skillDir, basePath)) {
              groupings.set(resolve(skillDir), plugin.name)
            }
          }
        }
      }
    }
  } catch {}

  try {
    const content = await readFile(join(basePath, '.claude-plugin/plugin.json'), 'utf-8')
    const manifest: PluginManifest = JSON.parse(content)
    if (manifest.name && manifest.skills && manifest.skills.length > 0) {
      for (const skillPath of manifest.skills) {
        if (!isValidRelativePath(skillPath)) continue
        const skillDir = join(basePath, skillPath)
        if (isContainedIn(skillDir, basePath)) {
          groupings.set(resolve(skillDir), manifest.name)
        }
      }
    }
  } catch {}

  return groupings
}
