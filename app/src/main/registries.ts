import { transaction } from './db/transaction'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  decodeSyncMarkerStatus,
  encodeSyncMarkerStatus,
  type SyncMarkerStatus,
} from './db/syncMarkerStatus'

/** In-memory shape of a Registry row. */
export interface StoredRegistry {
  id: string
  url: string
  branch: string
  enabled: boolean
  autoUpdate: boolean
  githubOwner: string | null
  githubRepo: string | null
  canonicalKey: string
  /** ISO-8601 when soft-removed; null while active. */
  removedAt: string | null
  createdAt: string
  updatedAt: string
}

/** In-memory shape of a per-Registry sync marker row. */
export interface StoredMarker {
  registryId: string
  lastSyncRevision: string | null
  lastSyncAt: string | null
  status: SyncMarkerStatus
  stale: boolean
}

interface RegistryRow {
  id: string
  url: string
  branch: string
  enabled: number
  auto_update: number
  github_owner: string | null
  github_repo: string | null
  canonical_key: string
  removed_at: string | null
  created_at: string
  updated_at: string
}

interface MarkerRow {
  registry_id: string
  last_sync_revision: string | null
  last_sync_at: string | null
  last_sync_status: string
  stale: number
}

function toStored(row: RegistryRow): StoredRegistry {
  return {
    id: row.id,
    url: row.url,
    branch: row.branch,
    enabled: row.enabled === 1,
    autoUpdate: row.auto_update === 1,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    canonicalKey: row.canonical_key,
    removedAt: row.removed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toStoredMarker(row: MarkerRow): StoredMarker {
  return {
    registryId: row.registry_id,
    lastSyncRevision: row.last_sync_revision,
    lastSyncAt: row.last_sync_at,
    status: decodeSyncMarkerStatus(row.last_sync_status),
    stale: row.stale === 1,
  }
}

export interface ListRegistriesOptions {
  /** Include soft-removed Registries (retained for orphan installs). */
  includeRemoved?: boolean
}

/** Active (not soft-removed) Registries by default, oldest first. */
export function listRegistries(
  db: DatabaseSync,
  options: ListRegistriesOptions = {}
): StoredRegistry[] {
  const where = options.includeRemoved ? '' : 'WHERE removed_at IS NULL'
  const rows = db
    .prepare(`SELECT * FROM registry ${where} ORDER BY created_at ASC, id ASC`)
    .all() as unknown as RegistryRow[]
  return rows.map(toStored)
}

export function getRegistry(db: DatabaseSync, id: string): StoredRegistry | undefined {
  const row = db.prepare(`SELECT * FROM registry WHERE id = ?`).get(id) as RegistryRow | undefined
  return row ? toStored(row) : undefined
}

/** Find an active Registry by canonical key (used to enforce one-per-owner/repo). */
export function findByCanonicalKey(
  db: DatabaseSync,
  canonicalKey: string
): StoredRegistry | undefined {
  const row = db
    .prepare(`SELECT * FROM registry WHERE canonical_key = ? AND removed_at IS NULL`)
    .get(canonicalKey) as RegistryRow | undefined
  return row ? toStored(row) : undefined
}

export interface InsertRegistryInput {
  url: string
  branch: string
  enabled: boolean
  autoUpdate: boolean
  githubOwner: string | null
  githubRepo: string | null
  canonicalKey: string
}

export function insertRegistry(db: DatabaseSync, input: InsertRegistryInput): StoredRegistry {
  const id = randomUUID()
  const now = new Date().toISOString()
  transaction(db, () => {
    db.prepare(
      `INSERT INTO registry
        (id, url, branch, enabled, auto_update, github_owner, github_repo, canonical_key, removed_at, created_at, updated_at)
       VALUES (@id, @url, @branch, @enabled, @auto_update, @github_owner, @github_repo, @canonical_key, NULL, @now, @now)`
    ).run({
      id,
      url: input.url,
      branch: input.branch,
      enabled: input.enabled ? 1 : 0,
      auto_update: input.autoUpdate ? 1 : 0,
      github_owner: input.githubOwner,
      github_repo: input.githubRepo,
      canonical_key: input.canonicalKey,
      now,
    })
    db.prepare(
      `INSERT INTO registry_sync_marker (registry_id, last_sync_status, stale)
       VALUES (?, 'never', 0)`
    ).run(id)
  })
  return getRegistry(db, id)!
}

export interface UpdateRegistryFields {
  url?: string
  branch?: string
  enabled?: boolean
  autoUpdate?: boolean
  githubOwner?: string | null
  githubRepo?: string | null
  canonicalKey?: string
}

export function updateRegistry(
  db: DatabaseSync,
  id: string,
  fields: UpdateRegistryFields
): StoredRegistry {
  const current = getRegistry(db, id)
  if (!current) throw new Error(`Registry "${id}" not found`)
  const next: StoredRegistry = {
    ...current,
    url: fields.url ?? current.url,
    branch: fields.branch ?? current.branch,
    enabled: fields.enabled ?? current.enabled,
    autoUpdate: fields.autoUpdate ?? current.autoUpdate,
    githubOwner: fields.githubOwner !== undefined ? fields.githubOwner : current.githubOwner,
    githubRepo: fields.githubRepo !== undefined ? fields.githubRepo : current.githubRepo,
    canonicalKey: fields.canonicalKey ?? current.canonicalKey,
    updatedAt: new Date().toISOString(),
  }
  db.prepare(
    `UPDATE registry SET
       url = @url, branch = @branch, enabled = @enabled, auto_update = @auto_update,
       github_owner = @github_owner, github_repo = @github_repo,
       canonical_key = @canonical_key, updated_at = @updated_at
     WHERE id = @id`
  ).run({
    id,
    url: next.url,
    branch: next.branch,
    enabled: next.enabled ? 1 : 0,
    auto_update: next.autoUpdate ? 1 : 0,
    github_owner: next.githubOwner,
    github_repo: next.githubRepo,
    canonical_key: next.canonicalKey,
    updated_at: next.updatedAt,
  })
  return next
}

/** Soft-remove: keep config/snapshot/mirror; hide from Settings/available. */
export function softRemoveRegistry(db: DatabaseSync, id: string): void {
  db.prepare(`UPDATE registry SET removed_at = ?, updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    new Date().toISOString(),
    id
  )
}

/** Hard-delete a Registry and its scoped skills/versions/marker (cascade). */
export function hardDeleteRegistry(db: DatabaseSync, id: string): void {
  db.prepare(`DELETE FROM registry WHERE id = ?`).run(id)
}

/** Display label for a Registry: `owner/repo` for GitHub, else host/path. */
export function registryLabel(registry: {
  githubOwner: string | null
  githubRepo: string | null
  url: string
}): string {
  if (registry.githubOwner && registry.githubRepo) {
    return `${registry.githubOwner}/${registry.githubRepo}`
  }
  try {
    const url = new URL(registry.url)
    return `${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return registry.url
  }
}

export function getMarker(db: DatabaseSync, registryId: string): StoredMarker | undefined {
  const row = db
    .prepare(`SELECT * FROM registry_sync_marker WHERE registry_id = ?`)
    .get(registryId) as MarkerRow | undefined
  return row ? toStoredMarker(row) : undefined
}

export function upsertMarkerSuccess(
  db: DatabaseSync,
  registryId: string,
  opts: { revision: string; at: string; status: Extract<SyncMarkerStatus, 'ok' | 'empty'> }
): void {
  db.prepare(
    `INSERT INTO registry_sync_marker (registry_id, last_sync_revision, last_sync_at, last_sync_status, stale)
     VALUES (@registry_id, @revision, @at, @status, 0)
     ON CONFLICT(registry_id) DO UPDATE SET
       last_sync_revision = excluded.last_sync_revision,
       last_sync_at = excluded.last_sync_at,
       last_sync_status = excluded.last_sync_status,
       stale = 0`
  ).run({
    registry_id: registryId,
    revision: opts.revision,
    at: opts.at,
    status: encodeSyncMarkerStatus(opts.status),
  })
}

/**
 * Record a failed sync without clearing the last-good snapshot marker.
 * Marks the retained snapshot stale so the catalogue can flag it.
 */
export function recordMarkerFailure(
  db: DatabaseSync,
  registryId: string,
  status: Extract<SyncMarkerStatus, 'offline' | 'access-required' | 'empty'>
): void {
  db.prepare(
    `INSERT INTO registry_sync_marker (registry_id, last_sync_status, stale)
     VALUES (@registry_id, @status, 1)
     ON CONFLICT(registry_id) DO UPDATE SET
       last_sync_status = excluded.last_sync_status,
       stale = 1`
  ).run({ registry_id: registryId, status: encodeSyncMarkerStatus(status) })
}
