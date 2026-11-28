import { describe, expect, it, vi } from 'vitest'
import type { SkillSummary, UninstallResult } from '../../shared/ipc'
import { deriveUninstallWork, runBulkUninstall, type UninstallItem } from './bulkUninstall'

const CLAUDE = '~/.claude/skills'
const SHARED = '~/.agents/skills'

function skill(id: string, perTarget: SkillSummary['perTarget']): SkillSummary {
  return {
    registryId: 'r1',
    folderName: id,
    id: `r1/${id}`,
    name: id.toUpperCase(),
    description: '',
    registryLabel: 'owner/repo',
    conflict: false,
    stale: false,
    orphaned: false,
    softDeleted: false,
    perTarget,
  }
}

function item(id: string, targets: string[] = [CLAUDE]): UninstallItem {
  return { registryId: 'r1', folderName: id, skillId: `r1/${id}`, name: id.toUpperCase(), targets }
}

function result(perTarget: UninstallResult['perTarget'] = []): UninstallResult {
  return { registryId: 'r1', folderName: 'a', skillId: 'r1/a', perTarget }
}

describe('deriveUninstallWork', () => {
  it('requests only the chosen targets where Got Skills installed the skill', () => {
    const items = deriveUninstallWork(
      [
        skill('a', [
          { target: CLAUDE, state: 'installed' },
          { target: SHARED, state: 'update-available' },
        ]),
        skill('b', [
          { target: CLAUDE, state: 'needs-repair' },
          { target: SHARED, state: 'removed-from-registry' },
        ]),
        skill('c', [
          { target: CLAUDE, state: 'not-installed' },
          { target: SHARED, state: 'installed' },
        ]),
      ],
      [CLAUDE, SHARED]
    )
    expect(items.map((i) => [i.folderName, i.targets])).toEqual([
      ['a', [CLAUDE, SHARED]],
      ['b', [CLAUDE, SHARED]],
      ['c', [SHARED]],
    ])

    expect(
      deriveUninstallWork([skill('a', [{ target: SHARED, state: 'installed' }])], [CLAUDE])
    ).toEqual([])
  })

  it('never removes a collided target or one the skill is missing from', () => {
    const items = deriveUninstallWork(
      [
        skill('a', [
          { target: CLAUDE, state: 'external', occupant: { kind: 'folder' } },
          { target: SHARED, state: 'installed' },
        ]),
        skill('b', [
          { target: CLAUDE, state: 'other-registry' },
          { target: SHARED, state: 'not-installed' },
        ]),
      ],
      [CLAUDE, SHARED]
    )
    expect(items.map((i) => [i.folderName, i.targets])).toEqual([['a', [SHARED]]])
  })
})

describe('runBulkUninstall', () => {
  it('uninstalls one skill at a time, records failures and keeps going', async () => {
    const uninstall = vi
      .fn()
      .mockResolvedValueOnce(result([{ target: CLAUDE, outcome: 'installed', paths: [] }]))
      .mockRejectedValueOnce(new Error('Database locked'))
      .mockResolvedValueOnce(
        result([
          { target: CLAUDE, outcome: 'installed', paths: [] },
          { target: SHARED, outcome: 'failed', paths: [], error: 'Permission denied' },
        ])
      )
    const progress = vi.fn()
    const outcome = await runBulkUninstall({
      api: { uninstall },
      items: [item('a'), item('b'), item('c', [CLAUDE, SHARED])],
      onProgress: progress,
    })

    expect(uninstall.mock.calls.map(([req]) => req)).toEqual([
      { registryId: 'r1', folderName: 'a', targets: [CLAUDE] },
      { registryId: 'r1', folderName: 'b', targets: [CLAUDE] },
      { registryId: 'r1', folderName: 'c', targets: [CLAUDE, SHARED] },
    ])
    expect(progress.mock.calls.map(([p]) => [p.index, p.total, p.item.folderName])).toEqual([
      [0, 3, 'a'],
      [1, 3, 'b'],
      [2, 3, 'c'],
    ])
    expect(outcome.uninstalled).toBe(1)
    expect(outcome.failures.map((f) => [f.item.folderName, f.reason])).toEqual([
      ['b', 'Database locked'],
      ['c', 'Permission denied'],
    ])
    expect(outcome.cancelled).toBe(false)
  })

  it('stops before the next dispatch once cancelled', async () => {
    let cancelled = false
    const uninstall = vi.fn(() => {
      cancelled = true
      return Promise.resolve(result())
    })
    const outcome = await runBulkUninstall({
      api: { uninstall },
      items: [item('a'), item('b')],
      isCancelled: () => cancelled,
    })
    expect(uninstall).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ uninstalled: 1, failures: [], cancelled: true })
  })
})
