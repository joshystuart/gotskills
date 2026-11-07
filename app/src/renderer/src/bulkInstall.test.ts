import { describe, expect, it, vi } from 'vitest'
import type { InstallRequest, InstallResult, SkillSummary } from '../../shared/ipc'
import { deriveInstallWork, runBulkInstall, type BulkInstallProgress } from './bulkInstall'

const CLAUDE = '~/.claude/skills'
const SHARED = '~/.agents/skills'

function skill(
  id: string,
  perTarget: SkillSummary['perTarget'] = [],
  overrides: Partial<SkillSummary> = {}
): SkillSummary {
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
    ...overrides,
  }
}

const notInstalled = (...targets: string[]): SkillSummary['perTarget'] =>
  targets.map((target) => ({ target, state: 'not-installed' }))

const noneInstalledOnly = (): boolean => false

function installResult(): InstallResult {
  return {
    registryId: 'r1',
    folderName: 'a',
    skillId: 'r1/a',
    mirrorRevision: 'rev1',
    contentHash: 'hash',
    provenanceSha: 'rev1',
    cliVersion: '1.7.0',
    perTarget: [],
    installedAt: new Date().toISOString(),
  }
}

describe('deriveInstallWork', () => {
  it('requests only the chosen targets the skill is missing from', () => {
    const work = deriveInstallWork(
      [
        skill('a', [
          { target: CLAUDE, state: 'installed' },
          { target: SHARED, state: 'not-installed' },
        ]),
        skill('b', notInstalled(CLAUDE, SHARED)),
      ],
      [CLAUDE, SHARED],
      { acknowledgeStale: false, isInstalledOnly: noneInstalledOnly }
    )
    expect(work.items.map((i) => [i.folderName, i.targets])).toEqual([
      ['a', [SHARED]],
      ['b', [CLAUDE, SHARED]],
    ])
    expect(work.skipped).toBe(0)

    const claudeOnly = deriveInstallWork([skill('b', notInstalled(CLAUDE, SHARED))], [CLAUDE], {
      acknowledgeStale: false,
      isInstalledOnly: noneInstalledOnly,
    })
    expect(claudeOnly.items[0].targets).toEqual([CLAUDE])
  })

  it('skips fully installed, installed-only and removed skills', () => {
    const work = deriveInstallWork(
      [
        skill('full', [
          { target: CLAUDE, state: 'installed' },
          { target: SHARED, state: 'update-available' },
        ]),
        skill('orphan', notInstalled(CLAUDE), { orphaned: true }),
        skill('removed', notInstalled(CLAUDE), { softDeleted: true }),
        skill('ok', notInstalled(CLAUDE)),
      ],
      [CLAUDE, SHARED],
      { acknowledgeStale: false, isInstalledOnly: (s) => s.orphaned }
    )
    expect(work.items.map((i) => i.folderName)).toEqual(['ok'])
    expect(work.skipped).toBe(3)
  })

  it('holds back stale skills unless acknowledged', () => {
    const skills = [
      skill('s', notInstalled(CLAUDE), { stale: true }),
      skill('f', notInstalled(CLAUDE)),
    ]
    const held = deriveInstallWork(skills, [CLAUDE], {
      acknowledgeStale: false,
      isInstalledOnly: noneInstalledOnly,
    })
    expect(held.items.map((i) => i.folderName)).toEqual(['f'])
    expect(held.heldBack.map((i) => i.folderName)).toEqual(['s'])
    expect(held.skipped).toBe(0)

    const acked = deriveInstallWork(skills, [CLAUDE], {
      acknowledgeStale: true,
      isInstalledOnly: noneInstalledOnly,
    })
    expect(acked.items.map((i) => i.folderName)).toEqual(['s', 'f'])
    expect(acked.heldBack).toEqual([])
  })

  const collided = [
    skill('mixed', [
      { target: CLAUDE, state: 'external', occupant: { kind: 'symlink' } },
      { target: SHARED, state: 'not-installed' },
    ]),
    skill('held', [
      { target: CLAUDE, state: 'other-registry' },
      { target: SHARED, state: 'external' },
    ]),
    skill('empty', notInstalled(CLAUDE, SHARED)),
  ]

  it('skips and counts collided targets when replacing is off', () => {
    const work = deriveInstallWork(collided, [CLAUDE, SHARED], {
      acknowledgeStale: false,
      isInstalledOnly: noneInstalledOnly,
    })
    expect(work.items.map((i) => [i.folderName, i.targets, i.replaceTargets])).toEqual([
      ['mixed', [SHARED], []],
      ['empty', [CLAUDE, SHARED], []],
    ])
    expect(work.skippedCollisions).toBe(3)
    expect(work.skipped).toBe(1)
  })

  it('includes collided targets marked for replacement when replacing is on', () => {
    const work = deriveInstallWork(collided, [CLAUDE, SHARED], {
      acknowledgeStale: false,
      replaceExisting: true,
      isInstalledOnly: noneInstalledOnly,
    })
    expect(work.items.map((i) => [i.folderName, i.targets, i.replaceTargets])).toEqual([
      ['mixed', [CLAUDE, SHARED], [CLAUDE]],
      ['held', [CLAUDE, SHARED], [CLAUDE, SHARED]],
      ['empty', [CLAUDE, SHARED], []],
    ])
    expect(work.skippedCollisions).toBe(0)
    expect(work.skipped).toBe(0)
  })

  it('never replaces for an installed-only or removed skill', () => {
    const work = deriveInstallWork(
      [
        skill('orphan', [{ target: CLAUDE, state: 'external' }], { orphaned: true }),
        skill('removed', [{ target: CLAUDE, state: 'external' }], { softDeleted: true }),
      ],
      [CLAUDE],
      { acknowledgeStale: false, replaceExisting: true, isInstalledOnly: (s) => s.orphaned }
    )
    expect(work.items).toEqual([])
    expect(work.skipped).toBe(2)
  })
})

describe('runBulkInstall', () => {
  const work = deriveInstallWork(
    [
      skill('a', notInstalled(CLAUDE)),
      skill('b', notInstalled(CLAUDE), { stale: true }),
      skill('c', notInstalled(CLAUDE)),
    ],
    [CLAUDE],
    { acknowledgeStale: true, isInstalledOnly: noneInstalledOnly }
  )

  it('installs one at a time pinned to the revision at dispatch, and continues past a failure', async () => {
    let revision = 'rev1'
    const progress: BulkInstallProgress[] = []
    const install = vi.fn((req: InstallRequest) => {
      revision = 'rev2'
      if (req.folderName === 'b') return Promise.reject(new Error('collision'))
      return Promise.resolve(installResult())
    })
    const repair = vi.fn()
    const result = await runBulkInstall({
      api: { install, repair } as never,
      work,
      getRevision: () => revision,
      onProgress: (p) => progress.push(p),
    })

    expect(install.mock.calls.map(([req]) => req)).toEqual([
      { registryId: 'r1', folderName: 'a', targets: [CLAUDE], mirrorRevision: 'rev1' },
      {
        registryId: 'r1',
        folderName: 'b',
        targets: [CLAUDE],
        mirrorRevision: 'rev2',
        acknowledgeStale: true,
      },
      { registryId: 'r1', folderName: 'c', targets: [CLAUDE], mirrorRevision: 'rev2' },
    ])
    expect(repair).not.toHaveBeenCalled()
    expect(progress.map((p) => `${p.item.name} ${p.index + 1}/${p.total}`)).toEqual([
      'A 1/3',
      'B 2/3',
      'C 3/3',
    ])
    expect(result.installed).toBe(2)
    expect(result.failures.map((f) => [f.item.name, f.reason])).toEqual([['B', 'collision']])
    expect(result.cancelled).toBe(false)
  })

  it('sends the targets to replace with each request that has them', async () => {
    const install = vi.fn((_req: InstallRequest) => Promise.resolve(installResult()))
    await runBulkInstall({
      api: { install },
      work: deriveInstallWork(
        [
          skill('a', [
            { target: CLAUDE, state: 'external' },
            { target: SHARED, state: 'not-installed' },
          ]),
          skill('b', notInstalled(CLAUDE)),
        ],
        [CLAUDE, SHARED],
        { acknowledgeStale: false, replaceExisting: true, isInstalledOnly: noneInstalledOnly }
      ),
      getRevision: () => 'rev1',
    })
    expect(install.mock.calls.map(([req]) => req)).toEqual([
      {
        registryId: 'r1',
        folderName: 'a',
        targets: [CLAUDE, SHARED],
        mirrorRevision: 'rev1',
        replaceTargets: [CLAUDE],
      },
      { registryId: 'r1', folderName: 'b', targets: [CLAUDE, SHARED], mirrorRevision: 'rev1' },
    ])
  })

  it('stops after the current skill on cancel', async () => {
    let cancelled = false
    const install = vi.fn(() => {
      cancelled = true
      return Promise.resolve(installResult())
    })
    const result = await runBulkInstall({
      api: { install },
      work,
      getRevision: () => 'rev1',
      isCancelled: () => cancelled,
    })
    expect(install).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ installed: 1, cancelled: true })
  })
})
