import { transaction } from './db/transaction'
import type { DatabaseSync } from 'node:sqlite'
import type { ScannedSkill } from './mirror/scan'
import { scanSkills } from './mirror/scan'
import { ensureMirror } from './mirror/git'
import { git } from './mirror/git-exec'
import { upsertMarkerSuccess } from './registries'
import type { SyncMarkerStatus } from './db/syncMarkerStatus'

export type { SyncMarkerStatus } from './db/syncMarkerStatus'

export interface SyncRegistryConfig {
  registryId: string
  url: string
  branch: string
  /** Independent mirror path (mirrors/<registryId>) — never shared. */
  mirrorPath: string
}

export interface SyncWriteResult {
  revision: string
  visibleSkillCount: number
  status: Extract<SyncMarkerStatus, 'ok' | 'empty'>
}

/**
 * All commits that touched skillPath, oldest→newest, with tree hash at each.
 * Rename and move commits appear in the path history without the path existing
 * at that revision, so they are skipped.
 */
async function skillHistory(
  mirrorPath: string,
  skillPath: string
): Promise<{ commitSha: string; contentHash: string; committedAt: string }[]> {
  const log = await git(mirrorPath, 'log', '--reverse', '--format=%H%x09%cI', '--', skillPath)
  if (!log) return []
  const entries: { commitSha: string; contentHash: string; committedAt: string }[] = []
  for (const line of log.split('\n')) {
    if (!line.trim()) continue
    const [commitSha, committedAt] = line.split('\t')
    let contentHash: string
    try {
      contentHash = await git(mirrorPath, 'rev-parse', `${commitSha}:${skillPath}`)
    } catch {
      continue
    }
    entries.push({ commitSha, contentHash, committedAt })
  }
  return entries
}

/**
 * Persist a successful scan into SQLite for one Registry: upsert skills + head_*,
 * soft-delete absences within this Registry only, append version history, and
 * update this Registry's success marker. Other Registries are untouched.
 */
export async function writeScanToDb(
  db: DatabaseSync,
  opts: {
    registryId: string
    revision: string
    skills: ScannedSkill[]
    mirrorPath: string
  }
): Promise<SyncWriteResult> {
  const { registryId, revision, skills, mirrorPath } = opts
  const now = new Date().toISOString()
  const presentFolders = new Set(skills.map((s) => s.id))
  const status: Extract<SyncMarkerStatus, 'ok' | 'empty'> = skills.length === 0 ? 'empty' : 'ok'

  const histories = new Map<string, Awaited<ReturnType<typeof skillHistory>>>()
  for (const skill of skills) {
    histories.set(skill.id, await skillHistory(mirrorPath, skill.skillPath))
  }

  const upsertSkill = db.prepare(`
    INSERT INTO skill (
      registry_id, folder_name, name, description, skill_path,
      head_content_hash, head_provenance_sha, head_updated_at,
      soft_deleted, last_seen_revision, last_seen_at
    ) VALUES (
      @registry_id, @folder_name, @name, @description, @skill_path,
      @head_content_hash, @head_provenance_sha, @head_updated_at,
      0, @last_seen_revision, @last_seen_at
    )
    ON CONFLICT(registry_id, folder_name) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      skill_path = excluded.skill_path,
      head_content_hash = excluded.head_content_hash,
      head_provenance_sha = excluded.head_provenance_sha,
      head_updated_at = excluded.head_updated_at,
      soft_deleted = 0,
      last_seen_revision = excluded.last_seen_revision,
      last_seen_at = excluded.last_seen_at
  `)

  const upsertVersion = db.prepare(`
    INSERT INTO version (registry_id, folder_name, commit_sha, content_hash, committed_at)
    VALUES (@registry_id, @folder_name, @commit_sha, @content_hash, @committed_at)
    ON CONFLICT(registry_id, folder_name, commit_sha) DO UPDATE SET
      content_hash = excluded.content_hash,
      committed_at = excluded.committed_at
  `)

  const softDeleteMissing = db.prepare(`
    UPDATE skill SET soft_deleted = 1
    WHERE registry_id = @registry_id
      AND soft_deleted = 0
      AND folder_name NOT IN (SELECT value FROM json_each(@folders))
  `)

  const softDeleteAll = db.prepare(`
    UPDATE skill SET soft_deleted = 1 WHERE registry_id = @registry_id AND soft_deleted = 0
  `)

  transaction(db, () => {
    for (const skill of skills) {
      upsertSkill.run({
        registry_id: registryId,
        folder_name: skill.id,
        name: skill.name,
        description: skill.description,
        skill_path: skill.skillPath,
        head_content_hash: skill.contentHash,
        head_provenance_sha: skill.provenanceSha,
        head_updated_at: skill.updatedAt,
        last_seen_revision: revision,
        last_seen_at: now,
      })
      for (const entry of histories.get(skill.id) ?? []) {
        upsertVersion.run({
          registry_id: registryId,
          folder_name: skill.id,
          commit_sha: entry.commitSha,
          content_hash: entry.contentHash,
          committed_at: entry.committedAt,
        })
      }
    }

    if (presentFolders.size === 0) {
      softDeleteAll.run({ registry_id: registryId })
    } else {
      softDeleteMissing.run({
        registry_id: registryId,
        folders: JSON.stringify([...presentFolders]),
      })
    }
  })

  upsertMarkerSuccess(db, registryId, { revision, at: now, status })

  return {
    revision,
    visibleSkillCount: skills.length,
    status,
  }
}

/** Signature of {@link syncRegistry}; used for injectable test seams. */
export type SyncRegistryFn = (
  db: DatabaseSync,
  config: SyncRegistryConfig
) => Promise<SyncWriteResult>

/** Clone/fetch+hard-reset one Registry's mirror, scan, and write SQLite. */
export async function syncRegistry(
  db: DatabaseSync,
  config: SyncRegistryConfig
): Promise<SyncWriteResult> {
  const { revision } = await ensureMirror({
    url: config.url,
    branch: config.branch,
    mirrorPath: config.mirrorPath,
  })
  const skills = await scanSkills(config.mirrorPath)
  return writeScanToDb(db, {
    registryId: config.registryId,
    revision,
    skills,
    mirrorPath: config.mirrorPath,
  })
}
