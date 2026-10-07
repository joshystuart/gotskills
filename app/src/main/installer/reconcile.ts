import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  DiskProbe,
  InstallRecord,
  InstallTargetId,
  PerTargetState,
  ReconcileEntry,
  ReconcileReport,
  ReconcileState,
} from '../../shared/ipc'
import { skillId as makeSkillId } from '../../shared/ipc'
import type { AgentEnvironment } from '../mirror/discovery/agents'
import { shortSha } from '../../shared/shortSha'
import { detectInstallTargets, targetInstallPath } from './targets'
import { readInstallRecords } from './records'

interface SkillMeta {
  registry_id: string
  folder_name: string
  head_content_hash: string | null
  head_provenance_sha: string | null
  soft_deleted: number
  registry_enabled: number
  registry_removed: number
}

function probePath(path: string): DiskProbe {
  const exists = existsSync(path)
  if (!exists) {
    return { path, exists: false, isSymlink: false, resolves: false }
  }
  let isSymlink = false
  let resolves = true
  try {
    isSymlink = lstatSync(path).isSymbolicLink()
    if (isSymlink) {
      try {
        realpathSync(path)
        resolves = true
      } catch {
        resolves = false
      }
    }
  } catch {
    resolves = false
  }
  return { path, exists: true, isSymlink, resolves }
}

function probeDisk(home: string, target: InstallTargetId, folderName: string): DiskProbe[] {
  return [probePath(targetInstallPath(home, target, folderName))]
}

function diskPresent(probes: DiskProbe[]): boolean {
  return probes.some((p) => p.exists && p.resolves)
}

function diskBroken(probes: DiskProbe[]): boolean {
  return probes.some((p) => p.exists && !p.resolves)
}

/** Advisory CLI lock corroboration (never product truth). */
export function lockAgrees(
  home: string,
  folderName: string,
  _target: InstallTargetId,
  hasRecord: boolean
): boolean {
  if (!hasRecord) return true
  const lockPath = join(home, '.agents', '.skill-lock.json')
  if (!existsSync(lockPath)) return true
  try {
    const raw = readFileSync(lockPath, 'utf8')
    const text = JSON.stringify(JSON.parse(raw) as unknown)
    return text.includes(`"${folderName}"`) || text.includes(`/${folderName}`)
  } catch {
    return true
  }
}

function deriveState(opts: {
  softDeleted: boolean
  /** Disabled or removed Registry: keep installs manageable, never offer updates. */
  updatesUnavailable: boolean
  record: InstallRecord | undefined
  occupiedByOther: boolean
  mirrorHash: string | null
  probes: DiskProbe[]
}): ReconcileState {
  const { softDeleted, updatesUnavailable, record, occupiedByOther, mirrorHash, probes } = opts
  const present = diskPresent(probes)
  const broken = diskBroken(probes)

  if (record) {
    if (updatesUnavailable) {
      if (!present || broken) return 'needs-repair'
      return 'installed'
    }
    if (softDeleted) return 'removed-from-registry'
    if (!present || broken) return 'needs-repair'
    if (mirrorHash && record.contentHash !== mirrorHash) return 'update-available'
    return 'installed'
  }

  if (occupiedByOther) return 'other-registry'

  if (present) return 'external'
  return 'not-installed'
}

export interface ReconcileDeps {
  db: DatabaseSync
  environment: AgentEnvironment
  registryId?: string
  folderName?: string
}

/**
 * Read-only reconciliation scoped to a Registry (and optionally one folder).
 * SQLite = truth, disk probed, CLI lock advisory. Never writes.
 */
export function reconcile(deps: ReconcileDeps): ReconcileReport {
  const clauses: string[] = []
  const params: Record<string, string> = {}
  if (deps.registryId !== undefined) {
    clauses.push('s.registry_id = @registry_id')
    params.registry_id = deps.registryId
  }
  if (deps.folderName !== undefined) {
    clauses.push('s.folder_name = @folder_name')
    params.folder_name = deps.folderName
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const skillRows = deps.db
    .prepare(
      `SELECT s.registry_id, s.folder_name, s.head_content_hash, s.head_provenance_sha,
              s.soft_deleted, r.enabled AS registry_enabled,
              CASE WHEN r.removed_at IS NULL THEN 0 ELSE 1 END AS registry_removed
       FROM skill s
       JOIN registry r ON r.id = s.registry_id
       ${where}`
    )
    .all(params) as unknown as SkillMeta[]

  const records = readInstallRecords(deps.db)
  const occupancy = new Map<string, InstallRecord>()
  for (const rec of records) {
    occupancy.set(`${rec.target}::${rec.folderName}`, rec)
  }
  const { home } = deps.environment
  const targets = detectInstallTargets(
    deps.environment,
    records.map((rec) => rec.target)
  )
    .filter((target) => target.visible)
    .map((target) => target.id)

  const entries: ReconcileEntry[] = []
  for (const meta of skillRows) {
    const softDeleted = meta.soft_deleted === 1
    const updatesUnavailable = meta.registry_enabled === 0 || meta.registry_removed === 1
    const mirrorHash = meta.head_content_hash
    for (const target of targets) {
      const occupant = occupancy.get(`${target}::${meta.folder_name}`)
      const ours = occupant && occupant.registryId === meta.registry_id ? occupant : undefined
      const occupiedByOther = !!occupant && occupant.registryId !== meta.registry_id
      const probes = probeDisk(home, target, meta.folder_name)
      const state = deriveState({
        softDeleted,
        updatesUnavailable,
        record: ours,
        occupiedByOther,
        mirrorHash,
        probes,
      })
      const agrees = lockAgrees(home, meta.folder_name, target, !!ours)
      if (!agrees) {
        console.warn(
          `[reconcile] CLI lock disagrees for ${meta.folder_name}@${target} (advisory only)`
        )
      }
      entries.push({
        registryId: meta.registry_id,
        folderName: meta.folder_name,
        skillId: makeSkillId(meta.registry_id, meta.folder_name),
        target,
        state,
        installedHash: ours?.contentHash,
        mirrorHash: mirrorHash ?? undefined,
        disk: probes,
        lockAgrees: agrees,
      })
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    entries,
  }
}

/** Map reconcile entries → PerTargetState[] for one Skill (catalogue merge). */
export function perTargetFromReconcile(
  registryId: string,
  folderName: string,
  entries: ReconcileEntry[],
  records: Map<InstallTargetId, InstallRecord>
): PerTargetState[] {
  return entries
    .filter((e) => e.registryId === registryId && e.folderName === folderName)
    .map((entry) => ({
      target: entry.target,
      state: entry.state,
      installedVersion: shortSha(records.get(entry.target)?.provenanceSha),
    }))
}
