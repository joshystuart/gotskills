import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { InstallTargetId, TargetResult } from '../shared/ipc'

/** Telemetry schema version for exported evidence rows. */
export const TELEMETRY_SCHEMA_VERSION = 2

export type TelemetryEventType =
  'session_started' | 'sync_completed' | 'install_requested' | 'install_target_completed'

export type TelemetryAction = 'install' | 'update' | 'remove'

export type TelemetryOutcome = 'success' | 'failure' | 'skipped'

export type ErrorCategory = 'link_failed' | 'cli_failed' | 'revision_mismatch' | 'unknown'

export interface TelemetryEventRow {
  event_id: string
  occurred_at_utc: string
  installation_id: string
  session_id: string
  event_type: TelemetryEventType
  schema_version: number
  app_version: string
  operation_id: string | null
  skill_id: string | null
  commit_sha: string | null
  content_hash: string | null
  action: TelemetryAction | null
  targets: InstallTargetId[] | null
  target_app: InstallTargetId | null
  outcome: TelemetryOutcome | null
  duration_ms: number | null
  error_category: ErrorCategory | null
  registry_revision: string | null
  visible_skill_count: number | null
}

export interface EmitInput {
  event_type: TelemetryEventType
  operation_id?: string | null
  skill_id?: string | null
  commit_sha?: string | null
  content_hash?: string | null
  action?: TelemetryAction | null
  targets?: readonly InstallTargetId[] | null
  target_app?: InstallTargetId | null
  outcome?: TelemetryOutcome | null
  duration_ms?: number | null
  error_category?: ErrorCategory | null
  registry_revision?: string | null
  visible_skill_count?: number | null
}

const INSTALLATION_ID_FILE = 'installation_id'
export function sanitizeTargets(
  targets: readonly unknown[] | null | undefined,
  known: ReadonlySet<InstallTargetId>
): InstallTargetId[] | null {
  if (!Array.isArray(targets)) return null

  const sanitized: InstallTargetId[] = []
  for (const target of targets) {
    if (typeof target === 'string' && known.has(target) && !sanitized.includes(target)) {
      sanitized.push(target)
    }
  }
  return sanitized
}

function sanitizeTarget(
  target: InstallTargetId | null | undefined,
  known: ReadonlySet<InstallTargetId>
): InstallTargetId | null {
  return target != null && known.has(target) ? target : null
}

function parseStoredTargets(
  value: string | null,
  known: ReadonlySet<InstallTargetId>
): InstallTargetId[] | null {
  if (value == null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? sanitizeTargets(parsed, known) : null
  } catch {
    return null
  }
}

/** Load or create a persistent random installation_id (no personal data). */
export function loadOrCreateInstallationId(userData: string): string {
  const path = join(userData, INSTALLATION_ID_FILE)
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing.length > 0) return existing
  }
  mkdirSync(userData, { recursive: true })
  const id = randomUUID()
  writeFileSync(path, id + '\n', 'utf8')
  return id
}

/**
 * Map a redacted install error (or known refusal) to a coarse category.
 * Never returns free-text — only enum values.
 */
export function sanitizeErrorCategory(input: {
  revisionMismatch?: boolean
  usedCopyFallback?: boolean
  error?: string | null
}): ErrorCategory {
  if (input.revisionMismatch) return 'revision_mismatch'
  const msg = (input.error ?? '').toLowerCase()
  if (/symlink|eperm|eacces|link|errno:\s*-1|operation not permitted/.test(msg)) {
    return 'link_failed'
  }
  if (/cli|skills|exit|spawn|enoent|command failed/.test(msg) || input.usedCopyFallback === false) {
    return 'cli_failed'
  }
  if (msg.length > 0) return 'cli_failed'
  return 'unknown'
}

export interface TelemetryLog {
  installationId: string
  sessionId: string
  knownTargets(): ReadonlySet<InstallTargetId>
  emit(input: EmitInput): void
  exportJsonl(): string
  /** Shared helper for install/repair/uninstall request + per-target completion. */
  beginOperation(): string
}

export interface InstallLifecycleOperation {
  operationId: string
}

export interface InstallLifecycleRequest {
  action: TelemetryAction
  skillId: string
  targets: readonly InstallTargetId[]
  commitSha?: string | null
  contentHash?: string | null
}

export interface SkillTelemetryDimensions {
  commitSha: string | null
  contentHash: string | null
}

function sanitizeGitObjectId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
    return null
  }
  return value.toLowerCase()
}

/**
 * Read the selected skill's catalogue version dimensions before an operation.
 * Soft-deleted rows remain eligible because an installed removed skill can still
 * be uninstalled. Missing, null, or malformed dimensions are exported as null.
 */
export function readSkillTelemetryDimensions(
  db: DatabaseSync,
  registryId: string,
  folderName: string
): SkillTelemetryDimensions {
  const row = db
    .prepare(
      `SELECT head_provenance_sha, head_content_hash
       FROM skill
       WHERE registry_id = ? AND folder_name = ?`
    )
    .get(registryId, folderName) as
    | {
        head_provenance_sha: string | null
        head_content_hash: string | null
      }
    | undefined

  return {
    commitSha: sanitizeGitObjectId(row?.head_provenance_sha),
    contentHash: sanitizeGitObjectId(row?.head_content_hash),
  }
}

export interface InstallLifecycleCompletion {
  commitSha?: string | null
  contentHash?: string | null
  perTarget: readonly TargetResult[]
  durationMs: number
  revisionMismatch?: boolean
}

export interface InstallLifecycleResult<T> {
  result: T
  completion: Omit<InstallLifecycleCompletion, 'durationMs'>
}

function mapTargetOutcome(outcome: TargetResult['outcome']): TelemetryOutcome {
  if (outcome === 'installed') return 'success'
  if (outcome === 'skipped') return 'skipped'
  return 'failure'
}

/**
 * Persist request evidence before an install, update, or remove operation starts.
 * The returned handle must be reused for every later target completion.
 */
export function beginInstallLifecycle(
  telemetry: TelemetryLog,
  input: InstallLifecycleRequest
): InstallLifecycleOperation {
  const operationId = telemetry.beginOperation()
  telemetry.emit({
    event_type: 'install_requested',
    operation_id: operationId,
    action: input.action,
    skill_id: input.skillId,
    commit_sha: input.commitSha ?? null,
    content_hash: input.contentHash ?? null,
    targets: sanitizeTargets(input.targets, telemetry.knownTargets()),
  })
  return { operationId }
}

/** Emit target completions for an already-persisted request. */
export function completeInstallLifecycle(
  telemetry: TelemetryLog,
  operation: InstallLifecycleOperation,
  request: InstallLifecycleRequest,
  completion: InstallLifecycleCompletion
): void {
  const targets =
    completion.perTarget.length > 0
      ? completion.perTarget
      : (sanitizeTargets(request.targets, telemetry.knownTargets()) ?? []).map(
          (target): TargetResult => ({
            target,
            outcome: 'failed',
            method: 'copy',
            paths: [],
          })
        )

  for (const result of targets) {
    const failed = result.outcome === 'failed'
    telemetry.emit({
      event_type: 'install_target_completed',
      operation_id: operation.operationId,
      action: request.action,
      skill_id: request.skillId,
      commit_sha: completion.commitSha ?? request.commitSha ?? null,
      content_hash: completion.contentHash ?? request.contentHash ?? null,
      target_app: result.target,
      outcome: mapTargetOutcome(result.outcome),
      duration_ms: completion.durationMs,
      error_category: failed
        ? sanitizeErrorCategory({
            revisionMismatch: completion.revisionMismatch,
            error: result.error,
          })
        : null,
    })
  }
}

/**
 * Stable operation seam: synchronously persists the request, then invokes work,
 * and finally emits correlated success or caught-failure completions.
 */
export async function executeInstallLifecycle<T>(
  telemetry: TelemetryLog,
  request: InstallLifecycleRequest,
  invoke: () => Promise<InstallLifecycleResult<T>>,
  classifyFailure: (
    error: unknown
  ) => Pick<InstallLifecycleCompletion, 'revisionMismatch'> = () => ({})
): Promise<T> {
  const operation = beginInstallLifecycle(telemetry, request)
  const started = Date.now()
  let completed: InstallLifecycleResult<T>

  try {
    completed = await invoke()
  } catch (error) {
    completeInstallLifecycle(telemetry, operation, request, {
      perTarget: [],
      durationMs: Math.max(0, Date.now() - started),
      ...classifyFailure(error),
    })
    throw error
  }

  completeInstallLifecycle(telemetry, operation, request, {
    ...completed.completion,
    durationMs: Math.max(0, Date.now() - started),
  })
  return completed.result
}

export function createTelemetryLog(options: {
  db: DatabaseSync
  userData: string
  appVersion: string
  knownTargets: () => ReadonlySet<InstallTargetId>
}): TelemetryLog {
  const { knownTargets } = options
  const installationId = loadOrCreateInstallationId(options.userData)
  const sessionId = randomUUID()

  const insert = options.db.prepare(`
    INSERT INTO telemetry_event (
      event_id, occurred_at_utc, installation_id, session_id, event_type,
      schema_version, app_version, operation_id, skill_id, commit_sha, content_hash,
      action, targets, target_app, outcome, duration_ms, error_category,
      registry_revision, visible_skill_count
    ) VALUES (
      @event_id, @occurred_at_utc, @installation_id, @session_id, @event_type,
      @schema_version, @app_version, @operation_id, @skill_id, @commit_sha, @content_hash,
      @action, @targets, @target_app, @outcome, @duration_ms, @error_category,
      @registry_revision, @visible_skill_count
    )
  `)

  function emit(input: EmitInput): void {
    const known = knownTargets()
    const row: TelemetryEventRow = {
      event_id: randomUUID(),
      occurred_at_utc: new Date().toISOString(),
      installation_id: installationId,
      session_id: sessionId,
      event_type: input.event_type,
      schema_version: TELEMETRY_SCHEMA_VERSION,
      app_version: options.appVersion,
      operation_id: input.operation_id ?? null,
      skill_id: input.skill_id ?? null,
      commit_sha: input.commit_sha ?? null,
      content_hash: input.content_hash ?? null,
      action: input.action ?? null,
      targets: sanitizeTargets(input.targets, known),
      target_app: sanitizeTarget(input.target_app, known),
      outcome: input.outcome ?? null,
      duration_ms: input.duration_ms ?? null,
      error_category: input.error_category ?? null,
      registry_revision: input.registry_revision ?? null,
      visible_skill_count: input.visible_skill_count ?? null,
    }
    insert.run({ ...row, targets: row.targets == null ? null : JSON.stringify(row.targets) })
  }

  function exportJsonl(): string {
    const rows = options.db
      .prepare(
        `SELECT
          event_id, occurred_at_utc, installation_id, session_id, event_type,
          schema_version, app_version, operation_id, skill_id, commit_sha, content_hash,
          action, targets, target_app, outcome, duration_ms, error_category,
          registry_revision, visible_skill_count
         FROM telemetry_event
         ORDER BY occurred_at_utc ASC, event_id ASC`
      )
      .all() as (Omit<TelemetryEventRow, 'targets'> & { targets: string | null })[]

    const known = knownTargets()
    return (
      rows
        .map((row) =>
          JSON.stringify({
            ...row,
            targets: parseStoredTargets(row.targets, known),
            target_app: sanitizeTarget(row.target_app, known),
          })
        )
        .join('\n') + (rows.length > 0 ? '\n' : '')
    )
  }

  return {
    installationId,
    sessionId,
    knownTargets,
    emit,
    exportJsonl,
    beginOperation: () => randomUUID(),
  }
}
