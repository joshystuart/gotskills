import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { TargetResult } from '../shared/ipc'
import { MIGRATION_001_SQL } from './db/migrations/001_schema'
import { MIGRATION_002_SQL } from './db/migrations/002_telemetry'
import { MIGRATION_003_SQL } from './db/migrations/003_telemetry_targets'
import { MIGRATION_004_SQL } from './db/migrations/004_multi_registry'
import {
  beginInstallLifecycle,
  completeInstallLifecycle,
  executeInstallLifecycle,
  readSkillTelemetryDimensions,
  type EmitInput,
  type InstallLifecycleRequest,
  type TelemetryLog,
} from './telemetry'

function createTelemetrySeam(): { telemetry: TelemetryLog; events: EmitInput[] } {
  const events: EmitInput[] = []
  let nextOperation = 0
  return {
    events,
    telemetry: {
      installationId: 'installation',
      sessionId: 'session',
      knownTargets: () => new Set(['~/.claude/skills', '~/.agents/skills']),
      beginOperation: () => `operation-${++nextOperation}`,
      emit: (event) => {
        events.push(event)
      },
      exportJsonl: () => '',
    },
  }
}

describe('install telemetry lifecycle seam', () => {
  it('reads sanitized per-skill dimensions, including soft-deleted rows and nulls', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(MIGRATION_001_SQL)
    db.exec(MIGRATION_002_SQL)
    db.exec(MIGRATION_003_SQL)
    db.exec(MIGRATION_004_SQL)
    db.prepare(
      `INSERT INTO registry (id, url, branch, canonical_key, created_at, updated_at)
       VALUES ('r1', 'https://example.test/skills.git', 'main', 'git:example', '2026-01-01', '2026-01-01')`
    ).run()
    const insert = db.prepare(
      `INSERT INTO skill
        (registry_id, folder_name, name, description, head_provenance_sha, head_content_hash, soft_deleted)
       VALUES ('r1', ?, ?, '', ?, ?, ?)`
    )
    const commitSha = 'A'.repeat(40)
    const contentHash = 'B'.repeat(40)
    insert.run('removed', 'Removed', commitSha, contentHash, 1)
    insert.run('null-head', 'Null head', null, null, 0)
    insert.run('malformed', 'Malformed', 'private revision', '/local/content/path', 0)

    expect(readSkillTelemetryDimensions(db, 'r1', 'removed')).toEqual({
      commitSha: commitSha.toLowerCase(),
      contentHash: contentHash.toLowerCase(),
    })
    expect(readSkillTelemetryDimensions(db, 'r1', 'null-head')).toEqual({
      commitSha: null,
      contentHash: null,
    })
    expect(readSkillTelemetryDimensions(db, 'r1', 'malformed')).toEqual({
      commitSha: null,
      contentHash: null,
    })
    expect(readSkillTelemetryDimensions(db, 'r1', 'missing')).toEqual({
      commitSha: null,
      contentHash: null,
    })
    db.close()
  })

  it.each([
    ['install', 'install'],
    ['update', 'repair'],
    ['remove', 'uninstall'],
  ] as const)('persists one %s request before invoking %s', async (action, _operationName) => {
    const { telemetry, events } = createTelemetrySeam()
    const request = {
      action,
      skillId: 'alpha',
      targets: ['~/.claude/skills', '~/.claude/skills', '~/.agents/skills', 'invalid'],
      commitSha: 'requested-revision',
    } satisfies InstallLifecycleRequest

    const result = await executeInstallLifecycle(telemetry, request, async () => {
      expect(events).toHaveLength(1)
      expect(events[0]?.event_type).toBe('install_requested')
      return {
        result: 'done',
        completion: {
          perTarget: [
            {
              target: '~/.claude/skills',
              outcome: 'installed',
              method: 'symlink',
              paths: [],
            },
          ] satisfies TargetResult[],
        },
      }
    })

    expect(result).toBe('done')
    expect(events.filter((event) => event.event_type === 'install_requested')).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event_type: 'install_requested',
      operation_id: expect.any(String),
      action,
      skill_id: 'alpha',
      commit_sha: 'requested-revision',
      targets: ['~/.claude/skills', '~/.agents/skills'],
    })
    expect(events[1]).toMatchObject({
      event_type: 'install_target_completed',
      operation_id: events[0]?.operation_id,
      action,
      outcome: 'success',
    })
  })

  it('leaves request evidence when an operation is abandoned before completion', () => {
    const { telemetry, events } = createTelemetrySeam()
    const request = {
      action: 'install',
      skillId: 'alpha',
      targets: ['~/.agents/skills'],
    } satisfies InstallLifecycleRequest

    void executeInstallLifecycle(telemetry, request, () => new Promise<never>(() => {}))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event_type: 'install_requested',
      operation_id: expect.any(String),
      targets: ['~/.agents/skills'],
    })
  })

  it('correlates successful, failed, and skipped completions without another request', () => {
    const { telemetry, events } = createTelemetrySeam()
    const request = {
      action: 'update',
      skillId: 'alpha',
      targets: ['~/.claude/skills', '~/.agents/skills'],
    } satisfies InstallLifecycleRequest
    const operation = beginInstallLifecycle(telemetry, request)
    const perTarget: TargetResult[] = [
      {
        target: '~/.claude/skills',
        outcome: 'installed',
        method: 'symlink',
        paths: [],
      },
      {
        target: '~/.agents/skills',
        outcome: 'failed',
        method: 'copy',
        paths: [],
        error: 'skills CLI exited',
      },
      {
        target: '~/.agents/skills',
        outcome: 'skipped',
        method: 'copy',
        paths: [],
      },
    ]

    completeInstallLifecycle(telemetry, operation, request, {
      commitSha: 'completed-revision',
      contentHash: 'content-hash',
      perTarget,
      durationMs: 42,
    })

    expect(events.filter((event) => event.event_type === 'install_requested')).toHaveLength(1)
    const completed = events.filter((event) => event.event_type === 'install_target_completed')
    expect(completed).toHaveLength(3)
    expect(completed.every((event) => event.operation_id === operation.operationId)).toBe(true)
    expect(completed.map((event) => event.outcome)).toEqual(['success', 'failure', 'skipped'])
    expect(completed[1]?.error_category).toBe('cli_failed')
    expect(completed.every((event) => event.commit_sha === 'completed-revision')).toBe(true)
  })

  it('emits sanitized synthetic failures for a caught pre-target error', async () => {
    const { telemetry, events } = createTelemetrySeam()
    const request = {
      action: 'remove',
      skillId: 'alpha',
      targets: ['~/.agents/skills', 'invalid'],
    } satisfies InstallLifecycleRequest
    await expect(
      executeInstallLifecycle(
        telemetry,
        request,
        async () => {
          throw new Error('revision refused')
        },
        () => ({ revisionMismatch: true })
      )
    ).rejects.toThrow('revision refused')

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      event_type: 'install_target_completed',
      operation_id: events[0]?.operation_id,
      action: 'remove',
      target_app: '~/.agents/skills',
      outcome: 'failure',
      error_category: 'revision_mismatch',
    })
  })
})
