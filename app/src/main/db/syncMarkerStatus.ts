export type SyncMarkerStatus = 'never' | 'ok' | 'offline' | 'empty' | 'access-required'

type PersistedSyncMarkerStatus = 'never' | 'ok' | 'offline' | 'empty' | 'access_required'

export function encodeSyncMarkerStatus(status: SyncMarkerStatus): PersistedSyncMarkerStatus {
  return status === 'access-required' ? 'access_required' : status
}

export function decodeSyncMarkerStatus(status: string): SyncMarkerStatus {
  if (status === 'access_required') return 'access-required'
  if (status === 'never' || status === 'ok' || status === 'offline' || status === 'empty') {
    return status
  }
  throw new Error(`Unknown persisted sync marker status: ${status}`)
}
