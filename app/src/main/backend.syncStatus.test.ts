import { describe, expect, it } from 'vitest'
import type { RegistrySyncStatus } from '../shared/ipc'
import { aggregateSyncStatus } from './catalogue'

function ok(registryId: string, at: string, revision: string): RegistrySyncStatus {
  return { registryId, phase: 'synced', lastSyncedAt: at, revision, visibleSkillCount: 2 }
}

function failed(registryId: string, reason: RegistrySyncStatus['reason']): RegistrySyncStatus {
  return { registryId, phase: 'failed', lastSyncedAt: null, reason, visibleSkillCount: 0 }
}

describe('aggregateSyncStatus', () => {
  it('is synced with a null timestamp when there are no Registries', () => {
    expect(aggregateSyncStatus([])).toEqual({
      phase: 'synced',
      lastSyncedAt: null,
      registries: [],
    })
  })

  it('reports the most recent successful timestamp across Registries', () => {
    const status = aggregateSyncStatus([
      ok('a', '2026-07-10T01:00:00.000Z', 'rev-a'),
      ok('b', '2026-07-11T02:00:00.000Z', 'rev-b'),
    ])
    expect(status.phase).toBe('synced')
    expect(status.lastSyncedAt).toBe('2026-07-11T02:00:00.000Z')
    expect(status.registries).toHaveLength(2)
  })

  it('is syncing when any Registry is syncing', () => {
    const status = aggregateSyncStatus([
      ok('a', '2026-07-10T01:00:00.000Z', 'rev-a'),
      { registryId: 'b', phase: 'syncing', lastSyncedAt: null },
    ])
    expect(status.phase).toBe('syncing')
  })

  it('is partial when some Registries fail and others succeed', () => {
    const status = aggregateSyncStatus([
      ok('a', '2026-07-10T01:00:00.000Z', 'rev-a'),
      failed('b', 'offline'),
    ])
    expect(status.phase).toBe('partial')
    expect(status.reason).toBeUndefined()
  })

  it('is failed with a shared reason only when every Registry failed the same way', () => {
    const same = aggregateSyncStatus([failed('a', 'offline'), failed('b', 'offline')])
    expect(same.phase).toBe('failed')
    expect(same.reason).toBe('offline')

    const mixed = aggregateSyncStatus([failed('a', 'offline'), failed('b', 'access-required')])
    expect(mixed.phase).toBe('failed')
    expect(mixed.reason).toBeUndefined()
  })
})
