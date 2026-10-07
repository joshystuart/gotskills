import type { DatabaseSync } from 'node:sqlite'
import type {
  CatalogueSnapshot,
  InstallRecord,
  InstallTargetId,
  RegistrySyncStatus,
  SkillSummary,
  SyncStatus,
} from '../shared/ipc'
import { skillId as makeSkillId } from '../shared/ipc'
import { shortSha } from '../shared/shortSha'
import type { SyncMarkerStatus } from './db/syncMarkerStatus'
import type { AgentEnvironment } from './mirror/discovery/agents'
import {
  getMarker,
  listRegistries,
  recordMarkerFailure,
  registryLabel,
  type StoredRegistry,
} from './registries'
import { reconcile, perTargetFromReconcile } from './installer/reconcile'
import { readInstallRecords } from './installer/records'

/**
 * Compatibility shim retained for the sync-marker boundary test: record a
 * failed sync for one Registry without clearing its last-good snapshot.
 */
export function recordSyncFailure(
  db: DatabaseSync,
  registryId: string,
  status: Extract<SyncMarkerStatus, 'offline' | 'access-required' | 'empty'>
): void {
  recordMarkerFailure(db, registryId, status)
}

/** Count of visible (available) skills for one Registry snapshot. */
function visibleSkillCount(db: DatabaseSync, registryId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM skill WHERE registry_id = ? AND soft_deleted = 0`)
    .get(registryId) as { n: number }
  return row.n
}

/** Build a per-Registry sync status from its persisted marker. */
export function registrySyncStatusFromMarker(
  db: DatabaseSync,
  registryId: string
): RegistrySyncStatus {
  const marker = getMarker(db, registryId)
  const count = visibleSkillCount(db, registryId)
  if (!marker || marker.status === 'never') {
    return { registryId, phase: 'synced', lastSyncedAt: null, visibleSkillCount: 0 }
  }
  if (marker.status === 'ok') {
    return {
      registryId,
      phase: 'synced',
      lastSyncedAt: marker.lastSyncAt,
      revision: marker.lastSyncRevision ?? undefined,
      visibleSkillCount: count,
      stale: marker.stale,
    }
  }
  const reason =
    marker.status === 'offline'
      ? 'offline'
      : marker.status === 'empty'
        ? 'empty'
        : 'access-required'
  return {
    registryId,
    phase: 'failed',
    lastSyncedAt: marker.lastSyncAt,
    reason,
    revision: marker.lastSyncRevision ?? undefined,
    visibleSkillCount: count,
    stale: marker.stale,
  }
}

/**
 * Aggregate per-Registry outcomes into a combined catalogue SyncStatus.
 * One Registry failing never fails the whole catalogue: mixed results become
 * `partial`, and a shared reason is only surfaced when every Registry failed
 * the same way.
 */
export function aggregateSyncStatus(registries: RegistrySyncStatus[]): SyncStatus {
  if (registries.length === 0) {
    return { phase: 'synced', lastSyncedAt: null, registries: [] }
  }

  const lastSyncedAt =
    registries
      .map((r) => r.lastSyncedAt)
      .filter((v): v is string => !!v)
      .sort()
      .at(-1) ?? null

  const totalVisible = registries.reduce((sum, r) => sum + (r.visibleSkillCount ?? 0), 0)

  if (registries.some((r) => r.phase === 'syncing')) {
    return { phase: 'syncing', lastSyncedAt, registries, visibleSkillCount: totalVisible }
  }

  const failed = registries.filter((r) => r.phase === 'failed')
  if (failed.length === 0) {
    return { phase: 'synced', lastSyncedAt, registries, visibleSkillCount: totalVisible }
  }
  if (failed.length === registries.length) {
    const reasons = new Set(failed.map((r) => r.reason))
    const reason = reasons.size === 1 ? failed[0].reason : undefined
    return { phase: 'failed', lastSyncedAt, reason, registries, visibleSkillCount: totalVisible }
  }
  return { phase: 'partial', lastSyncedAt, registries, visibleSkillCount: totalVisible }
}

interface SkillJoinRow {
  registry_id: string
  folder_name: string
  name: string
  description: string
  head_provenance_sha: string | null
  head_updated_at: string | null
  soft_deleted: number
  enabled: number
  removed_at: string | null
}

/**
 * Combined Catalogue: union of every enabled Registry's available skills, plus
 * installed-only entries from disabled Registries and Orphaned Installations
 * from removed Registries. Same-folder skills from multiple enabled Registries
 * are all kept visible and flagged as a Skill Conflict.
 */
export function readCatalogue(db: DatabaseSync, environment: AgentEnvironment): CatalogueSnapshot {
  const registries = listRegistries(db, { includeRemoved: true })
  const byId = new Map<string, StoredRegistry>(registries.map((r) => [r.id, r]))
  const markerStale = new Map<string, boolean>(
    registries.map((r) => [r.id, getMarker(db, r.id)?.stale ?? false])
  )

  const report = reconcile({ db, environment })
  const occupancy = readInstallRecords(db)
  /** (registryId, folderName) → target → record (only provenance-owned installs). */
  const ownedInstalls = new Map<string, Map<InstallTargetId, InstallRecord>>()
  const installedKeys = new Set<string>()
  for (const rec of occupancy) {
    const key = `${rec.registryId}\u0000${rec.folderName}`
    let map = ownedInstalls.get(key)
    if (!map) {
      map = new Map()
      ownedInstalls.set(key, map)
    }
    map.set(rec.target, rec)
    installedKeys.add(key)
  }

  const rows = db
    .prepare(
      `SELECT s.registry_id, s.folder_name, s.name, s.description,
              s.head_provenance_sha, s.head_updated_at, s.soft_deleted,
              r.enabled, r.removed_at
       FROM skill s
       JOIN registry r ON r.id = s.registry_id
       ORDER BY s.name COLLATE NOCASE, s.registry_id`
    )
    .all() as unknown as SkillJoinRow[]

  const availableFolderCounts = new Map<string, number>()
  const included: { row: SkillJoinRow; available: boolean; orphaned: boolean }[] = []

  for (const row of rows) {
    const key = `${row.registry_id}\u0000${row.folder_name}`
    const installed = installedKeys.has(key)
    const removed = row.removed_at !== null
    const enabled = row.enabled === 1
    const softDeleted = row.soft_deleted === 1

    if (removed) {
      if (installed) included.push({ row, available: false, orphaned: true })
      continue
    }
    if (!enabled) {
      if (installed) included.push({ row, available: false, orphaned: false })
      continue
    }
    if (!softDeleted) {
      included.push({ row, available: true, orphaned: false })
      availableFolderCounts.set(
        row.folder_name,
        (availableFolderCounts.get(row.folder_name) ?? 0) + 1
      )
    } else if (installed) {
      included.push({ row, available: false, orphaned: false })
    }
  }

  const skills: SkillSummary[] = included.map(({ row, available, orphaned }) => {
    const registry = byId.get(row.registry_id)
    const key = `${row.registry_id}\u0000${row.folder_name}`
    const records = ownedInstalls.get(key) ?? new Map<InstallTargetId, InstallRecord>()
    const conflict = available && (availableFolderCounts.get(row.folder_name) ?? 0) > 1
    return {
      registryId: row.registry_id,
      folderName: row.folder_name,
      id: makeSkillId(row.registry_id, row.folder_name),
      name: row.name,
      description: row.description,
      registryLabel: registry ? registryLabel(registry) : row.registry_id,
      conflict,
      stale: markerStale.get(row.registry_id) ?? false,
      orphaned,
      latestVersion: shortSha(row.head_provenance_sha),
      updatedAt: row.head_updated_at ?? undefined,
      softDeleted: row.soft_deleted === 1,
      perTarget: perTargetFromReconcile(row.registry_id, row.folder_name, report.entries, records),
    }
  })

  const enabledStatuses = registries
    .filter((r) => r.enabled && r.removedAt === null)
    .map((r) => registrySyncStatusFromMarker(db, r.id))

  return {
    skills,
    syncStatus: aggregateSyncStatus(enabledStatuses),
  }
}
