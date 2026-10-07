import type { DatabaseSync } from 'node:sqlite'
import { promises as fs } from 'node:fs'
import { realpathSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import type {
  SkillFileContent,
  SkillFileEntry,
  SkillFileList,
  SkillFileReadRequest,
  SkillFileRequest,
} from '../shared/ipc'

export const SKILL_FILE_READ_CAP_BYTES = 512 * 1024

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  '.tsv',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.py',
  '.rb',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.css',
  '.scss',
  '.html',
  '.htm',
  '.sql',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.editorconfig',
  '.lock',
])

const TEXT_FILENAMES = new Set(['Dockerfile', 'Makefile', 'LICENSE', 'NOTICE', 'CHANGELOG'])

export interface SkillFilesDeps {
  db: DatabaseSync
  mirrorPathFor: (registryId: string) => string
}

function isTextFilename(name: string): boolean {
  if (TEXT_FILENAMES.has(name)) return true
  const ext = extname(name).toLowerCase()
  return ext !== '' && TEXT_EXTENSIONS.has(ext)
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function basenameOf(posixPath: string): string {
  const index = posixPath.lastIndexOf('/')
  return index === -1 ? posixPath : posixPath.slice(index + 1)
}

/**
 * Resolve a skill-relative POSIX path to an absolute path confined to the
 * skill directory (which itself lives under the mirror root). Returns null
 * when the path escapes (`..`, absolute, or symlink escape).
 */
function resolveConfined(skillDir: string, relativePosix: string): string | null {
  if (
    relativePosix === '' ||
    relativePosix.startsWith('/') ||
    relativePosix.split('/').includes('..')
  ) {
    return null
  }
  const root = realpathSync(skillDir)
  const absolute = join(root, ...relativePosix.split('/'))
  try {
    const real = realpathSync(absolute)
    return real !== root && !real.startsWith(root + sep) ? null : real
  } catch {
    return absolute
  }
}

async function walk(
  dir: string,
  prefix: string,
  root: string,
  out: SkillFileEntry[]
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(absolute, relative, root, out)
    } else if (entry.isFile()) {
      const stat = await fs.stat(absolute)
      out.push({ path: relative, sizeBytes: stat.size, viewable: isTextFilename(entry.name) })
    } else if (entry.isSymbolicLink()) {
      let real: string
      try {
        real = realpathSync(absolute)
      } catch {
        continue
      }
      if (real !== root && !real.startsWith(root + sep)) continue
      const stat = await fs.stat(absolute)
      if (stat.isFile()) {
        out.push({ path: relative, sizeBytes: stat.size, viewable: isTextFilename(entry.name) })
      }
    }
  }
}

function skillDirFor(deps: SkillFilesDeps, req: SkillFileRequest): string {
  const registry = deps.db.prepare(`SELECT id FROM registry WHERE id = ?`).get(req.registryId) as
    { id: string } | undefined
  if (!registry) {
    throw new Error(`Registry "${req.registryId}" is not configured`)
  }
  const skill = deps.db
    .prepare(
      `SELECT skill_path FROM skill WHERE registry_id = ? AND folder_name = ? AND soft_deleted = 0`
    )
    .get(req.registryId, req.folderName) as { skill_path: string | null } | undefined
  if (!skill) {
    throw new Error(`Skill "${req.folderName}" is not in the catalogue`)
  }
  const mirrorRoot = deps.mirrorPathFor(req.registryId)
  return skill.skill_path
    ? join(mirrorRoot, ...skill.skill_path.split('/'))
    : join(mirrorRoot, 'skills', req.folderName)
}

export async function listSkillFiles(
  deps: SkillFilesDeps,
  req: SkillFileRequest
): Promise<SkillFileList> {
  const skillDir = skillDirFor(deps, req)
  const files: SkillFileEntry[] = []
  try {
    const stat = await fs.stat(skillDir)
    if (!stat.isDirectory()) return { files, unavailable: 'missing' }
    await walk(skillDir, '', realpathSync(skillDir), files)
  } catch (err) {
    if (isNotFound(err)) return { files, unavailable: 'missing' }
    throw err
  }
  return { files }
}

export async function readSkillFile(
  deps: SkillFilesDeps,
  req: SkillFileReadRequest
): Promise<SkillFileContent> {
  const skillDir = skillDirFor(deps, req)
  let stat
  try {
    stat = await fs.stat(skillDir)
  } catch (err) {
    if (isNotFound(err)) return { path: req.path, sizeBytes: 0, kind: 'missing' }
    throw err
  }
  if (!stat.isDirectory()) return { path: req.path, sizeBytes: 0, kind: 'missing' }

  const absolute = resolveConfined(skillDir, req.path)
  if (absolute === null) {
    throw new Error(`Path "${req.path}" resolves outside the skill directory`)
  }

  let fileStat
  try {
    fileStat = await fs.stat(absolute)
  } catch (err) {
    if (isNotFound(err)) return { path: req.path, sizeBytes: 0, kind: 'missing' }
    throw err
  }
  if (!fileStat.isFile()) return { path: req.path, sizeBytes: 0, kind: 'missing' }

  const truncated = fileStat.size > SKILL_FILE_READ_CAP_BYTES
  const length = truncated ? SKILL_FILE_READ_CAP_BYTES : fileStat.size
  let buffer = Buffer.alloc(length)
  let handle: FileHandle | undefined
  try {
    handle = await fs.open(absolute, 'r')
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    buffer = buffer.subarray(0, bytesRead)
  } catch (err) {
    if (isNotFound(err)) return { path: req.path, sizeBytes: 0, kind: 'missing' }
    throw err
  } finally {
    await handle?.close()
  }

  if (!isTextFilename(basenameOf(req.path)) || buffer.includes(0)) {
    return { path: req.path, sizeBytes: fileStat.size, kind: 'binary' }
  }
  return {
    path: req.path,
    sizeBytes: fileStat.size,
    kind: 'text',
    content: buffer.toString('utf8'),
    ...(truncated ? { truncated: true } : {}),
  }
}
