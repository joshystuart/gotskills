import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { recordSyncFailure } from '../catalogue'
import { decodeSyncMarkerStatus, encodeSyncMarkerStatus } from './syncMarkerStatus'

describe('sync marker status persistence boundary', () => {
  it('stores the canonical access-required status using the SQLite spelling', () => {
    expect(encodeSyncMarkerStatus('access-required')).toBe('access_required')
  })

  it('exposes an existing SQLite value using the canonical domain spelling', () => {
    expect(decodeSyncMarkerStatus('access_required')).toBe('access-required')
  })

  it.each(['never', 'ok', 'offline', 'empty'] as const)(
    'round-trips the unchanged %s status',
    (status) => {
      expect(decodeSyncMarkerStatus(encodeSyncMarkerStatus(status))).toBe(status)
    }
  )

  it('rejects values outside the persisted schema', () => {
    expect(() => decodeSyncMarkerStatus('access-required')).toThrow(
      'Unknown persisted sync marker status'
    )
  })

  it('keeps canonical failure names out of the SQLite schema', () => {
    let persistedStatus: unknown
    const db = {
      prepare: () => ({
        run: (values: { status: unknown }) => {
          persistedStatus = values.status
        },
      }),
    } as unknown as DatabaseSync

    recordSyncFailure(db, 'registry-1', 'access-required')
    expect(persistedStatus).toBe('access_required')
  })
})
