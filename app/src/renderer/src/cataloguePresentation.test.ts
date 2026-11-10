import { describe, expect, it } from 'vitest'
import type {
  InstallTargetStatus,
  RegistrySyncStatus,
  SkillSummary,
  SyncStatus,
} from '../../shared/ipc'
import {
  ACCESS_REQUIRED_GUIDANCE,
  bannerMessage,
  deriveUpdateItems,
  deriveUpdateWork,
  filterByRegistry,
  REGISTRY_PALETTE,
  registryColour,
  registryOwnerLabel,
  registryRecordLabel,
  registryStatusLabel,
  rowAttention,
  skillsInView,
  staleSkillNotice,
  syncLabel,
} from './cataloguePresentation'

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return { phase: 'synced', lastSyncedAt: null, registries: [], ...overrides }
}

function regStatus(overrides: Partial<RegistrySyncStatus> = {}): RegistrySyncStatus {
  return { registryId: 'r1', phase: 'synced', lastSyncedAt: null, ...overrides }
}

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    registryId: 'r1',
    folderName: 'alpha',
    id: 'r1/alpha',
    name: 'Alpha',
    description: 'desc',
    registryLabel: 'anthropics/skills',
    conflict: false,
    stale: false,
    orphaned: false,
    softDeleted: false,
    perTarget: [],
    ...overrides,
  }
}

describe('syncLabel', () => {
  it('labels a partial refresh distinctly from a full failure', () => {
    expect(syncLabel(syncStatus({ phase: 'partial' })).text).toBe('Partial sync')
    expect(syncLabel(syncStatus({ phase: 'failed', reason: 'offline' })).text).toBe('Sync failed')
  })
})

describe('bannerMessage', () => {
  it('represents partial success without claiming total failure', () => {
    const banner = bannerMessage(syncStatus({ phase: 'partial' }))
    expect(banner).toBeTruthy()
    expect(banner).toMatch(/latest available skills/i)
    expect(banner).not.toMatch(/failed/i)
  })

  it('adds system-Git guidance to the access-required banner', () => {
    const banner = bannerMessage(syncStatus({ phase: 'failed', reason: 'access-required' }))
    expect(banner).toMatch(/Repository not found or access required/)
    expect(banner).toContain(ACCESS_REQUIRED_GUIDANCE)
  })
})

describe('registryStatusLabel', () => {
  it('describes access-required and stale snapshots for the Settings list', () => {
    expect(
      registryStatusLabel(regStatus({ phase: 'failed', reason: 'access-required' })).text
    ).toBe('Repository not found or access required')
    const stale = registryStatusLabel(
      regStatus({ phase: 'failed', reason: 'offline', stale: true })
    )
    expect(stale.text).toMatch(/last snapshot/i)
  })

  it('reports synced and never-synced states', () => {
    expect(registryStatusLabel(regStatus({ phase: 'synced', lastSyncedAt: null })).text).toBe(
      'Not yet synced'
    )
    expect(
      registryStatusLabel(regStatus({ phase: 'synced', lastSyncedAt: new Date().toISOString() }))
        .text
    ).toBe('Synced')
  })
})

describe('staleSkillNotice', () => {
  it('is null when the skill is fresh', () => {
    expect(staleSkillNotice(skill({ stale: false }))).toBeNull()
  })

  it('surfaces the stale revision and age', () => {
    const notice = staleSkillNotice(
      skill({ stale: true, latestVersion: 'abc1234', updatedAt: '2026-07-10T00:00:00Z' })
    )
    expect(notice).toMatch(/stale/i)
    expect(notice).toContain('abc1234')
    expect(notice).toMatch(/Jul 10, 2026/)
  })
})

describe('filterByRegistry', () => {
  it('returns all skills when the filter is all', () => {
    const skills = [
      skill({ registryId: 'r1', id: 'r1/a' }),
      skill({ registryId: 'r2', id: 'r2/b', registryLabel: 'other/repo' }),
    ]
    expect(filterByRegistry(skills, 'all')).toHaveLength(2)
  })

  it('keeps only skills from the selected registry', () => {
    const skills = [
      skill({ registryId: 'r1', id: 'r1/a', name: 'Alpha' }),
      skill({ registryId: 'r2', id: 'r2/b', name: 'Beta', registryLabel: 'other/repo' }),
    ]
    expect(filterByRegistry(skills, 'r2').map((s) => s.name)).toEqual(['Beta'])
  })
})

describe('registryRecordLabel', () => {
  const github = {
    source: 'git' as const,
    automaticName: 'anthropics/skills',
    githubOwner: 'anthropics',
    githubRepo: 'skills',
    url: 'https://github.com/anthropics/skills',
  }

  it('uses the friendly name when one is set', () => {
    expect(registryRecordLabel({ ...github, name: 'Team skills' })).toBe('Team skills')
  })

  it('falls back to owner/repo without a name', () => {
    expect(registryRecordLabel({ ...github, name: null })).toBe('anthropics/skills')
  })

  it('falls back to host and path for a non-GitHub Registry without a name', () => {
    expect(
      registryRecordLabel({
        source: 'git',
        automaticName: 'git.example.com/team/skills',
        githubOwner: null,
        githubRepo: null,
        url: 'https://git.example.com/team/skills/',
        name: null,
      })
    ).toBe('git.example.com/team/skills')
  })
})

describe('registryOwnerLabel', () => {
  it.each([
    ['https://github.com/anthropics/skills', 'anthropics'],
    ['https://github.com/example-org/trial-skills.git', 'example-org'],
    ['ssh://git@github.com/example-org/trial-skills.git', 'example-org'],
    ['git@github.com:example-org/trial-skills.git', 'example-org'],
  ])('derives a GitHub repository owner from %s', (url, owner) => {
    expect(registryOwnerLabel(url)).toBe(owner)
  })

  it.each([
    'https://git.example.com/groups/team/skills',
    'https://github.com/anthropics/skills/tree/main',
    '/tmp/local-registry',
    '',
  ])('does not invent an owner for %s', (url) => {
    expect(registryOwnerLabel(url)).toBeNull()
  })
})

function target(id: string, label: string): InstallTargetStatus {
  return { id, label, shared: false, visible: true, agents: [] }
}

const CLAUDE = target('~/.claude/skills', 'Claude Code')
const AGENTS = target('~/.agents/skills', 'Agents')

describe('rowAttention', () => {
  it('reports External, quietly, for targets holding the skill outside the app', () => {
    const external = skill({
      perTarget: [
        { target: CLAUDE.id, state: 'external' },
        { target: AGENTS.id, state: 'not-installed' },
      ],
    })

    const attention = rowAttention(external, [CLAUDE, AGENTS])

    expect(attention?.label.cellText).toBe('External')
    expect(attention?.label.tone).toBe('quiet')
    expect(attention?.targets).toEqual([CLAUDE])
  })

  it('reports Other registry, quietly, for targets held by another registry', () => {
    const held = skill({
      perTarget: [
        { target: CLAUDE.id, state: 'not-installed' },
        { target: AGENTS.id, state: 'other-registry' },
      ],
    })

    const attention = rowAttention(held, [CLAUDE, AGENTS])

    expect(attention?.label.cellText).toBe('Other registry')
    expect(attention?.label.tone).toBe('quiet')
    expect(attention?.targets).toEqual([AGENTS])
  })

  it.each([
    ['needs-repair', 'Repair'],
    ['removed-from-registry', 'Removed'],
    ['update-available', 'Update'],
  ] as const)('ranks %s above a collision', (state, cellText) => {
    for (const collided of ['external', 'other-registry'] as const) {
      const both = skill({
        perTarget: [
          { target: CLAUDE.id, state },
          { target: AGENTS.id, state: collided },
        ],
      })

      expect(rowAttention(both, [CLAUDE, AGENTS])?.label.cellText).toBe(cellText)
    }
  })

  it('ranks Orphaned above a collision', () => {
    const both = skill({
      orphaned: true,
      perTarget: [
        { target: CLAUDE.id, state: 'installed' },
        { target: AGENTS.id, state: 'external' },
      ],
    })

    expect(rowAttention(both, [CLAUDE, AGENTS])?.label.cellText).toBe('Orphaned')
  })

  it('reports External over Other registry when a skill has both', () => {
    const both = skill({
      perTarget: [
        { target: CLAUDE.id, state: 'other-registry' },
        { target: AGENTS.id, state: 'external' },
      ],
    })

    expect(rowAttention(both, [CLAUDE, AGENTS])?.label.cellText).toBe('External')
  })
})

describe('skillsInView', () => {
  it('leaves skills that only collide out of the Installed view', () => {
    const managed = skill({
      id: 'r1/managed',
      perTarget: [
        { target: CLAUDE.id, state: 'installed' },
        { target: AGENTS.id, state: 'external' },
      ],
    })
    const external = skill({
      id: 'r1/external',
      perTarget: [{ target: CLAUDE.id, state: 'external' }],
    })
    const held = skill({
      id: 'r1/held',
      perTarget: [{ target: CLAUDE.id, state: 'other-registry' }],
    })

    expect(skillsInView([managed, external, held], 'installed')).toEqual([managed])
  })
})

describe('deriveUpdateItems', () => {
  it('yields no item for an empty catalogue', () => {
    expect(deriveUpdateItems([])).toEqual([])
  })

  it('yields no item when no target is behind', () => {
    const skills = [
      skill({
        perTarget: [
          { target: '~/.claude/skills', state: 'installed' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
    ]
    expect(deriveUpdateItems(skills)).toEqual([])
  })

  it('includes only the behind target for a skill stale on one target and current on the other', () => {
    const skills = [
      skill({
        registryId: 'r1',
        folderName: 'alpha',
        id: 'r1/alpha',
        name: 'Alpha',
        perTarget: [
          { target: '~/.claude/skills', state: 'update-available' },
          { target: '~/.agents/skills', state: 'installed' },
        ],
      }),
    ]
    const items = deriveUpdateItems(skills)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      registryId: 'r1',
      folderName: 'alpha',
      skillId: 'r1/alpha',
      name: 'Alpha',
      targets: ['~/.claude/skills'],
    })
  })

  it('never includes a Skill supplied by a Disabled Registry', () => {
    const skills = [
      skill({
        registryId: 'disabled-reg',
        id: 'disabled-reg/alpha',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
    ]
    expect(deriveUpdateItems(skills)).toEqual([])
  })

  it('never includes an Orphaned Installation', () => {
    const skills = [
      skill({
        registryId: 'gone',
        id: 'gone/alpha',
        orphaned: true,
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
    ]
    expect(deriveUpdateItems(skills)).toEqual([])
  })
})

describe('deriveUpdateWork', () => {
  const behind = { target: '~/.claude/skills', state: 'update-available' } as const

  it('represents an empty set', () => {
    expect(deriveUpdateWork([], syncStatus())).toEqual({
      all: [],
      ready: [],
      staleGated: [],
      disclosures: [],
    })
  })

  it('partitions items into ready and stale-gated groups, preserving Catalogue order in `all`', () => {
    const skills = [
      skill({ id: 'r1/alpha', folderName: 'alpha', name: 'Alpha', perTarget: [behind] }),
      skill({
        id: 'r2/beta',
        folderName: 'beta',
        name: 'Beta',
        registryId: 'r2',
        registryLabel: 'example-org/skills',
        stale: true,
        perTarget: [behind],
      }),
      skill({ id: 'r1/gamma', folderName: 'gamma', name: 'Gamma', perTarget: [behind] }),
    ]

    const work = deriveUpdateWork(skills, syncStatus())

    expect(work.all.map((i) => i.skillId)).toEqual(['r1/alpha', 'r2/beta', 'r1/gamma'])
    expect(work.ready.map((i) => i.skillId)).toEqual(['r1/alpha', 'r1/gamma'])
    expect(work.staleGated.map((i) => i.skillId)).toEqual(['r2/beta'])
    expect(work.all[1].staleGated).toBe(true)
    expect(work.ready.every((i) => !i.staleGated)).toBe(true)
  })

  it('returns per-Registry disclosure data — label, last-synced time, affected count — only for stale Registries that contribute behind Skills', () => {
    const lastSynced = '2026-08-20T10:00:00Z'
    const skills = [
      skill({
        id: 'r2/beta',
        folderName: 'beta',
        name: 'Beta',
        registryId: 'r2',
        registryLabel: 'example-org/skills',
        stale: true,
        perTarget: [behind],
      }),
      skill({
        id: 'r2/delta',
        folderName: 'delta',
        name: 'Delta',
        registryId: 'r2',
        registryLabel: 'example-org/skills',
        stale: true,
        perTarget: [behind],
      }),
      skill({ id: 'r1/alpha', folderName: 'alpha', name: 'Alpha', perTarget: [behind] }),
      skill({
        id: 'r3/epsilon',
        folderName: 'epsilon',
        name: 'Epsilon',
        registryId: 'r3',
        stale: true,
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
    ]
    const status = syncStatus({
      registries: [
        regStatus({ registryId: 'r2', phase: 'failed', stale: true, lastSyncedAt: lastSynced }),
      ],
    })

    const work = deriveUpdateWork(skills, status)

    expect(work.disclosures).toEqual([
      {
        registryId: 'r2',
        label: 'example-org/skills',
        lastSyncedAt: lastSynced,
        affected: 2,
      },
    ])
  })

  it('reports a null last-synced time when the Registry has never synced', () => {
    const skills = [
      skill({
        id: 'r1/alpha',
        folderName: 'alpha',
        name: 'Alpha',
        stale: true,
        perTarget: [behind],
      }),
    ]
    const work = deriveUpdateWork(skills, syncStatus({ registries: [regStatus()] }))
    expect(work.disclosures).toEqual([
      { registryId: 'r1', label: 'anthropics/skills', lastSyncedAt: null, affected: 1 },
    ])
  })
})

describe('registryColour', () => {
  it('gives the same Registry id the same palette colour every time', () => {
    for (const id of ['default', 'reg-2', 'team', 'a8f3c1d2-0b7e-4c55-9a11-3e2f4d5c6b7a']) {
      const colour = registryColour(id)
      expect(REGISTRY_PALETTE).toContain(colour)
      expect(registryColour(id)).toBe(colour)
    }
  })

  it('keeps each Registry colour when another Registry is removed', () => {
    const ids = ['default', 'reg-2', 'team', 'acme']
    const before = new Map(ids.map((id) => [id, registryColour(id)]))
    const remaining = ids.filter((id) => id !== 'reg-2')
    for (const id of remaining) {
      expect(registryColour(id)).toBe(before.get(id))
    }
  })

  it('spreads Registries across more than one palette colour', () => {
    const colours = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(registryColour))
    expect(colours.size).toBeGreaterThan(1)
  })
})

it('names missing folders in registry status and full or partial catalogue banners', () => {
  const missing = regStatus({
    phase: 'failed',
    reason: 'folder-not-found',
    folderPath: '/skills/drafts',
    stale: true,
  })
  expect(registryStatusLabel(missing).text).toBe(
    'Folder not found: /skills/drafts — showing last snapshot'
  )
  for (const phase of ['failed', 'partial'] as const) {
    const banner = bannerMessage(
      syncStatus({
        phase,
        reason: phase === 'failed' ? 'folder-not-found' : undefined,
        registries: [missing],
      })
    )
    expect(banner).toContain('Folder not found: /skills/drafts')
    expect(banner).not.toContain('system Git')
  }
})

it.each([
  ['folder-unreadable', "Folder can't be read: /skills/drafts"],
  ['folder-changed', 'Folder changed during sync: /skills/drafts'],
  ['snapshot-failed', "Couldn't save a snapshot of the folder: /skills/drafts"],
] as const)('names the folder for a %s failure', (reason, label) => {
  const failed = regStatus({ phase: 'failed', reason, folderPath: '/skills/drafts' })
  expect(registryStatusLabel(failed).text).toBe(label)
  expect(bannerMessage(syncStatus({ phase: 'failed', reason, registries: [failed] }))).toContain(
    label
  )
})
