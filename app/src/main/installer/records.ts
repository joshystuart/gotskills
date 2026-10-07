import type { DatabaseSync } from 'node:sqlite'
import type { InstallMethod, InstallRecord, InstallTargetId } from '../../shared/ipc'

interface InstallRow {
  target: InstallTargetId
  folder_name: string
  registry_id: string
  content_hash: string
  provenance_sha: string
  method: InstallMethod
  paths: string
  cli_version: string
  installed_at: string
}

function toRecord(row: InstallRow): InstallRecord {
  return {
    registryId: row.registry_id,
    folderName: row.folder_name,
    target: row.target,
    contentHash: row.content_hash,
    provenanceSha: row.provenance_sha,
    method: row.method,
    paths: JSON.parse(row.paths) as string[],
    cliVersion: row.cli_version,
    installedAt: row.installed_at,
  }
}

/**
 * Persist an install occupancy row. Occupancy PK is (target, folder_name); the
 * supplying Registry is written as provenance so a later Registry removal can
 * leave the install in place as an Orphaned Installation.
 */
export function upsertInstallRecord(db: DatabaseSync, record: InstallRecord): void {
  db.prepare(
    `
    INSERT INTO install_record (
      target, folder_name, registry_id, content_hash, provenance_sha, method, paths, cli_version, installed_at
    ) VALUES (
      @target, @folder_name, @registry_id, @content_hash, @provenance_sha, @method, @paths, @cli_version, @installed_at
    )
    ON CONFLICT(target, folder_name) DO UPDATE SET
      registry_id = excluded.registry_id,
      content_hash = excluded.content_hash,
      provenance_sha = excluded.provenance_sha,
      method = excluded.method,
      paths = excluded.paths,
      cli_version = excluded.cli_version,
      installed_at = excluded.installed_at
    `
  ).run({
    target: record.target,
    folder_name: record.folderName,
    registry_id: record.registryId,
    content_hash: record.contentHash,
    provenance_sha: record.provenanceSha,
    method: record.method,
    paths: JSON.stringify(record.paths),
    cli_version: record.cliVersion,
    installed_at: record.installedAt,
  })
}

export interface InstallRecordFilter {
  registryId?: string
  folderName?: string
  target?: InstallTargetId
}

export function readInstallRecords(
  db: DatabaseSync,
  filter: InstallRecordFilter = {}
): InstallRecord[] {
  const clauses: string[] = []
  const params: Record<string, string> = {}
  if (filter.registryId !== undefined) {
    clauses.push('registry_id = @registry_id')
    params.registry_id = filter.registryId
  }
  if (filter.folderName !== undefined) {
    clauses.push('folder_name = @folder_name')
    params.folder_name = filter.folderName
  }
  if (filter.target !== undefined) {
    clauses.push('target = @target')
    params.target = filter.target
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT target, folder_name, registry_id, content_hash, provenance_sha, method, paths, cli_version, installed_at
       FROM install_record ${where}`
    )
    .all(params) as unknown as InstallRow[]
  return rows.map(toRecord)
}

export function readOccupancy(
  db: DatabaseSync,
  target: InstallTargetId,
  folderName: string
): InstallRecord | undefined {
  const records = readInstallRecords(db, { target, folderName })
  return records[0]
}

export function deleteInstallRecord(
  db: DatabaseSync,
  target: InstallTargetId,
  folderName: string
): void {
  db.prepare(`DELETE FROM install_record WHERE target = ? AND folder_name = ?`).run(
    target,
    folderName
  )
}
