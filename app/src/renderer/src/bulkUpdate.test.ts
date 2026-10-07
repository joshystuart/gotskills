import { describe, expect, it, vi } from 'vitest'
import type { CatalogueSnapshot, InstallRequest, InstallResult, SyncStatus } from '../../shared/ipc'
import { runBulkUpdate, type BulkUpdateApi, type BulkUpdateProgress } from './bulkUpdate'
import type { UpdateItem } from './cataloguePresentation'

function item(overrides: Partial<UpdateItem> = {}): UpdateItem {
  return {
    registryId: 'r1',
    folderName: 'alpha',
    skillId: 'r1/alpha',
    name: 'Alpha',
    targets: ['~/.claude/skills'],
    staleGated: false,
    ...overrides,
  }
}

function installResult(overrides: Partial<InstallResult> = {}): InstallResult {
  return {
    registryId: 'r1',
    folderName: 'alpha',
    skillId: 'r1/alpha',
    mirrorRevision: 'rev1',
    contentHash: 'hash',
    provenanceSha: 'rev1',
    cliVersion: '1.5.15',
    perTarget: [{ target: '~/.claude/skills', outcome: 'installed', method: 'symlink', paths: [] }],
    installedAt: new Date().toISOString(),
    ...overrides,
  }
}

function syncStatus(): SyncStatus {
  return { phase: 'synced', lastSyncedAt: null, registries: [] }
}

/** A minimal SkillSummary carrying just the fields deriveUpdateItems reads. */
function skillFor(
  updateItem: UpdateItem,
  states: Array<'update-available' | 'installed'> = updateItem.targets.map(() => 'update-available')
): CatalogueSnapshot['skills'][number] {
  return {
    registryId: updateItem.registryId,
    folderName: updateItem.folderName,
    id: updateItem.skillId,
    name: updateItem.name,
    description: '',
    registryLabel: updateItem.registryId,
    conflict: false,
    stale: updateItem.staleGated,
    orphaned: false,
    softDeleted: false,
    perTarget: updateItem.targets.map((target, i) => ({ target, state: states[i] })),
  }
}

function catalogue(skills: CatalogueSnapshot['skills']): CatalogueSnapshot {
  return { skills, syncStatus: syncStatus() }
}

/** Builds a fake BulkUpdateApi whose getCatalogue reflects `items` as behind. */
function fakeApi(
  overrides: Partial<BulkUpdateApi> & { repair: BulkUpdateApi['repair'] },
  items: UpdateItem[]
): BulkUpdateApi {
  return {
    refresh: vi.fn().mockResolvedValue({ registries: [] }),
    getCatalogue: vi.fn().mockResolvedValue(catalogue(items.map((it) => skillFor(it)))),
    ...overrides,
  }
}

describe('runBulkUpdate', () => {
  it('awaits refresh exactly once, before the catalogue is re-pulled or any item is dispatched', async () => {
    const items = [item({ folderName: 'a', skillId: 'r1/a' })]
    const order: string[] = []
    const refresh = vi.fn(() => {
      order.push('refresh')
      return Promise.resolve({ registries: [] })
    })
    const getCatalogue = vi.fn(() => {
      order.push('getCatalogue')
      return Promise.resolve(catalogue(items.map((it) => skillFor(it))))
    })
    const repair = vi.fn((req: InstallRequest) => {
      order.push(`repair:${req.folderName}`)
      return Promise.resolve(installResult({ folderName: req.folderName }))
    })

    await runBulkUpdate({
      api: { refresh, getCatalogue, repair },
      getRevision: () => 'rev1',
    })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['refresh', 'getCatalogue', 'repair:a'])
  })

  it('derives the work set from the post-refresh catalogue, not any list computed beforehand', async () => {
    const b = item({ folderName: 'b', skillId: 'r1/b', name: 'B' })
    const repair = vi.fn().mockResolvedValue(installResult())
    const api = fakeApi({ repair }, [b])

    const result = await runBulkUpdate({
      api,
      getRevision: () => 'rev1',
    })

    expect(api.getCatalogue).toHaveBeenCalledTimes(1)
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair).toHaveBeenCalledWith({
      registryId: 'r1',
      folderName: 'b',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'rev1',
    })
    expect(result.items).toEqual([b])
    expect(result.updated).toBe(1)
  })

  it('dispatches strictly sequentially, never issuing item N+1 before item N settles', async () => {
    const items = [
      item({ registryId: 'r1', folderName: 'a', skillId: 'r1/a', name: 'A' }),
      item({ registryId: 'r1', folderName: 'b', skillId: 'r1/b', name: 'B' }),
      item({ registryId: 'r1', folderName: 'c', skillId: 'r1/c', name: 'C' }),
    ]
    const order: string[] = []
    let resolveCurrent: (() => void) | undefined
    const repair = vi.fn((req: InstallRequest) => {
      order.push(`start:${req.folderName}`)
      return new Promise<InstallResult>((resolve) => {
        resolveCurrent = () => {
          order.push(`end:${req.folderName}`)
          resolve(installResult({ folderName: req.folderName }))
        }
      })
    })
    const api = fakeApi({ repair }, items)

    const donePromise = runBulkUpdate({
      api,
      getRevision: () => 'rev1',
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['start:a'])

    resolveCurrent?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['start:a', 'end:a', 'start:b'])

    resolveCurrent?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c'])

    resolveCurrent?.()
    const result = await donePromise
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
    expect(result.updated).toBe(3)
    expect(result.failures).toEqual([])
    expect(result.cancelled).toBe(false)
  })

  it('reports the progress callback sequence in order', async () => {
    const items = [
      item({ folderName: 'a', skillId: 'r1/a' }),
      item({ folderName: 'b', skillId: 'r1/b' }),
    ]
    const repair = vi.fn().mockResolvedValue(installResult())
    const api = fakeApi({ repair }, items)
    const progress: BulkUpdateProgress[] = []

    await runBulkUpdate({
      api,
      getRevision: () => 'rev1',
      onProgress: (p) => progress.push(p),
    })

    expect(progress).toHaveLength(2)
    expect(progress[0]).toMatchObject({ index: 0, total: 2, item: items[0] })
    expect(progress[1]).toMatchObject({ index: 1, total: 2, item: items[1] })
  })

  it('pins each item to the Registry revision current at dispatch, absorbing a mid-run advance', async () => {
    const items = [
      item({ registryId: 'r1', folderName: 'a', skillId: 'r1/a' }),
      item({ registryId: 'r1', folderName: 'b', skillId: 'r1/b' }),
    ]
    let revision = 'rev1'
    const repair = vi.fn((req: InstallRequest) => {
      const result = installResult({ folderName: req.folderName })
      if (req.folderName === 'a') revision = 'rev2'
      return Promise.resolve(result)
    })
    const api = fakeApi({ repair }, items)

    const result = await runBulkUpdate({
      api,
      getRevision: () => revision,
    })

    expect(repair).toHaveBeenNthCalledWith(1, {
      registryId: 'r1',
      folderName: 'a',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'rev1',
    })
    expect(repair).toHaveBeenNthCalledWith(2, {
      registryId: 'r1',
      folderName: 'b',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'rev2',
    })
    expect(result.failures).toEqual([])
    expect(result.updated).toBe(2)
  })

  it('does not abort the run on a failing item — items after it still dispatch', async () => {
    const items = [
      item({ folderName: 'a', skillId: 'r1/a', name: 'A' }),
      item({ folderName: 'b', skillId: 'r1/b', name: 'B' }),
      item({ folderName: 'c', skillId: 'r1/c', name: 'C' }),
      item({ folderName: 'd', skillId: 'r1/d', name: 'D' }),
      item({ folderName: 'e', skillId: 'r1/e', name: 'E' }),
    ]
    const repair = vi.fn((req: InstallRequest) => {
      if (req.folderName === 'c') {
        return Promise.reject(new Error('collision: external skill occupies this folder'))
      }
      return Promise.resolve(installResult({ folderName: req.folderName }))
    })
    const api = fakeApi({ repair }, items)

    const result = await runBulkUpdate({
      api,
      getRevision: () => 'rev1',
    })

    expect(repair).toHaveBeenCalledTimes(5)
    expect(result.updated).toBe(4)
    expect(result.failures).toEqual([
      { item: items[2], reason: 'collision: external skill occupies this folder' },
    ])
  })

  it('reports a Skill that vanished from its Registry during the refresh as an ordinary failed item, without aborting the run', async () => {
    const items = [
      item({ folderName: 'a', skillId: 'r1/a', name: 'A' }),
      item({ folderName: 'gone', skillId: 'r1/gone', name: 'Gone' }),
      item({ folderName: 'c', skillId: 'r1/c', name: 'C' }),
    ]
    const repair = vi.fn((req: InstallRequest) => {
      if (req.folderName === 'gone') {
        return Promise.reject(new Error('not in the catalogue'))
      }
      return Promise.resolve(installResult({ folderName: req.folderName }))
    })
    const api = fakeApi({ repair }, items)

    const result = await runBulkUpdate({
      api,
      getRevision: () => 'rev1',
    })

    expect(repair).toHaveBeenCalledTimes(3)
    expect(result.updated).toBe(2)
    expect(result.failures).toEqual([{ item: items[1], reason: 'not in the catalogue' }])
  })

  it('records a failure with a non-Error rejection stringified as the reason', async () => {
    const repair = vi.fn().mockRejectedValue('boom')
    const api = fakeApi({ repair }, [item()])
    const result = await runBulkUpdate({
      api,
      getRevision: () => 'rev1',
    })
    expect(result.failures).toEqual([{ item: item(), reason: 'boom' }])
  })

  it('stops before the next item when cancelled, leaving no half-dispatched item', async () => {
    const items = [
      item({ folderName: 'a', skillId: 'r1/a' }),
      item({ folderName: 'b', skillId: 'r1/b' }),
    ]
    const repair = vi.fn().mockResolvedValue(installResult())
    const api = fakeApi({ repair }, items)
    let cancelled = false

    const result = await runBulkUpdate({
      api,
      getRevision: () => 'rev1',
      onProgress: () => {
        cancelled = true
      },
      isCancelled: () => cancelled,
    })

    expect(repair).toHaveBeenCalledTimes(1)
    expect(result.updated).toBe(1)
    expect(result.failures).toEqual([])
    expect(result.cancelled).toBe(true)
  })

  it('a cancel issued during item two of five prevents item three from being dispatched, while item two still completes and is recorded', async () => {
    const items = [
      item({ folderName: 'a', skillId: 'r1/a', name: 'A' }),
      item({ folderName: 'b', skillId: 'r1/b', name: 'B' }),
      item({ folderName: 'c', skillId: 'r1/c', name: 'C' }),
      item({ folderName: 'd', skillId: 'r1/d', name: 'D' }),
      item({ folderName: 'e', skillId: 'r1/e', name: 'E' }),
    ]
    let cancelled = false
    let resolveSecond: ((result: InstallResult) => void) | undefined
    const repair = vi.fn((req: InstallRequest) => {
      if (req.folderName === 'b') {
        return new Promise<InstallResult>((resolve) => {
          resolveSecond = resolve
        })
      }
      return Promise.resolve(installResult({ folderName: req.folderName }))
    })
    const api = fakeApi({ repair }, items)

    const donePromise = runBulkUpdate({
      api,
      getRevision: () => 'rev1',
      isCancelled: () => cancelled,
    })

    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(repair).toHaveBeenCalledTimes(2)

    cancelled = true
    resolveSecond?.(installResult({ folderName: 'b' }))
    const result = await donePromise

    expect(repair).toHaveBeenCalledTimes(2)
    expect(repair).toHaveBeenNthCalledWith(2, {
      registryId: 'r1',
      folderName: 'b',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'rev1',
    })
    expect(result.updated).toBe(2)
    expect(result.failures).toEqual([])
    expect(result.cancelled).toBe(true)
  })

  it('dispatches no item at all when cancelled during the refresh phase', async () => {
    const items = [item({ folderName: 'a', skillId: 'r1/a' })]
    let cancelled = false
    const refresh = vi.fn(() => {
      cancelled = true
      return Promise.resolve({ registries: [] })
    })
    const repair = vi.fn().mockResolvedValue(installResult())
    const api = fakeApi({ refresh, repair }, items)

    const result = await runBulkUpdate({
      api,
      getRevision: () => 'rev1',
      isCancelled: () => cancelled,
    })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(repair).not.toHaveBeenCalled()
    expect(result.updated).toBe(0)
    expect(result.cancelled).toBe(true)
  })

  it('dispatches no stale-gated item when the acknowledgement is off, reporting them as held back rather than failures', async () => {
    const ready = item({ folderName: 'a', skillId: 'r1/a', name: 'A' })
    const gated = item({ folderName: 'b', skillId: 'r1/b', name: 'B', staleGated: true })
    const repair = vi.fn().mockResolvedValue(installResult())
    const api = fakeApi({ repair }, [ready, gated])

    const result = await runBulkUpdate({
      api,
      getRevision: () => 'rev1',
    })

    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair).toHaveBeenCalledWith({
      registryId: 'r1',
      folderName: 'a',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'rev1',
    })
    expect(result.updated).toBe(1)
    expect(result.failures).toEqual([])
    expect(result.heldBack).toEqual([gated])
    expect(result.items).toEqual([ready])
  })

  it('with the acknowledgement on, the stale flag appears on gated items only', async () => {
    const ready = item({ folderName: 'a', skillId: 'r1/a', name: 'A' })
    const gated = item({ folderName: 'b', skillId: 'r1/b', name: 'B', staleGated: true })
    const repair = vi.fn().mockResolvedValue(installResult())
    const api = fakeApi({ repair }, [ready, gated])

    const result = await runBulkUpdate({
      api,
      getRevision: () => 'rev1',
      acknowledgeStale: true,
    })

    expect(repair).toHaveBeenCalledTimes(2)
    expect(repair).toHaveBeenNthCalledWith(1, {
      registryId: 'r1',
      folderName: 'a',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'rev1',
    })
    expect(repair).toHaveBeenNthCalledWith(2, {
      registryId: 'r1',
      folderName: 'b',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'rev1',
      acknowledgeStale: true,
    })
    expect(result.heldBack).toEqual([])
    expect(result.updated).toBe(2)
  })

  it('holds back a Registry whose refresh failed — its Skills arrive stale and are not dispatched by default', async () => {
    const items = [item({ folderName: 'a', skillId: 'r1/a', name: 'A', staleGated: true })]
    const refresh = vi.fn().mockResolvedValue({
      registries: [{ registryId: 'r1', phase: 'failed', lastSyncedAt: null, reason: 'offline' }],
    })
    const repair = vi.fn()
    const getCatalogue = vi.fn().mockResolvedValue(catalogue(items.map((it) => skillFor(it))))

    const result = await runBulkUpdate({
      api: { refresh, getCatalogue, repair },
      getRevision: () => 'rev1',
    })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(repair).not.toHaveBeenCalled()
    expect(result.updated).toBe(0)
    expect(result.failures).toEqual([])
    expect(result.heldBack).toEqual(items)
  })
})
