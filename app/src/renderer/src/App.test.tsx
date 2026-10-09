/** @vitest-environment jsdom */
import { act, fireEvent, isInaccessible, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { AppUpdateBanner } from './AppUpdateBanner'
import {
  InstallationCollisionError,
  type AppUpdateState,
  type AutoUpdateResult,
  type InstallRequest,
  type InstallResult,
  type InstallTargetStatus,
  type RegistryRecord,
  type RegistrySyncStatus,
  type RendererApi,
  type SkillSummary,
  type SupportedAgent,
  type SyncAllResult,
  type SyncStatus,
  type TargetDetection,
} from '../../shared/ipc'

const REG = 'reg-1'

const DEFAULT_REGISTRY_RECORD: RegistryRecord = {
  id: 'default',
  url: 'https://github.com/anthropics/skills',
  branch: 'main',
  enabled: true,
  autoUpdate: false,
  githubOwner: 'anthropics',
  githubRepo: 'skills',
  colour: null,
  syncStatus: { registryId: 'default', phase: 'synced', lastSyncedAt: null },
}

function reg(overrides: Partial<RegistrySyncStatus> = {}): RegistrySyncStatus {
  return {
    registryId: REG,
    phase: 'synced',
    lastSyncedAt: new Date().toISOString(),
    revision: 'deadbeef',
    ...overrides,
  }
}

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return { phase: 'synced', lastSyncedAt: null, registries: [], ...overrides }
}

function ready(overrides: { waiting?: boolean } = {}): AppUpdateState {
  return { kind: 'ready', currentVersion: '0.0.6', version: '0.0.7', waiting: false, ...overrides }
}

function captureAppUpdateState(api: RendererApi): ((state: AppUpdateState) => void)[] {
  const callbacks: ((state: AppUpdateState) => void)[] = []
  vi.mocked(api.onAppUpdateState).mockImplementation((cb) => {
    callbacks.push(cb)
    return () => {}
  })
  return callbacks
}

function skill(
  overrides: Partial<SkillSummary> & { id: string; name: string; description: string }
): SkillSummary {
  return {
    registryId: REG,
    folderName: overrides.id,
    registryLabel: 'anthropics/skills',
    conflict: false,
    stale: false,
    orphaned: false,
    softDeleted: false,
    perTarget: [],
    ...overrides,
  }
}

const CLAUDE_CODE_TARGET: InstallTargetStatus = {
  id: '~/.claude/skills',
  label: 'Claude Code',
  shared: false,
  visible: true,
  agents: [{ id: 'claude-code', displayName: 'Claude Code', detected: true }],
}

const CURSOR_SHARED_TARGET: InstallTargetStatus = {
  id: '~/.agents/skills',
  label: 'Cursor',
  shared: true,
  visible: true,
  agents: [{ id: 'cursor', displayName: 'Cursor', detected: true }],
}

const GOOSE_TARGET: InstallTargetStatus = {
  id: '~/.config/goose/skills',
  label: 'Goose',
  shared: false,
  visible: true,
  agents: [{ id: 'goose', displayName: 'Goose', detected: true }],
}

const WIDE_SHARED_TARGET: InstallTargetStatus = {
  id: '~/.agents/skills',
  label: 'Cline, Codex, Cursor, Zed',
  shared: true,
  visible: true,
  agents: ['Cline', 'Codex', 'Cursor', 'Zed'].map((name) => ({
    id: name.toLowerCase(),
    displayName: name,
    detected: true,
  })),
}

function detection(targets: InstallTargetStatus[], agents: SupportedAgent[] = []): TargetDetection {
  return { targets, agents }
}

function fakeApi(
  status: SyncStatus,
  skills: SkillSummary[] = [],
  overrides: Partial<RendererApi> = {}
): RendererApi {
  return {
    detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET, CURSOR_SHARED_TARGET])),
    install: vi.fn(),
    reconcile: vi.fn(),
    repair: vi.fn(),
    uninstall: vi.fn(),
    getCatalogue: vi.fn().mockResolvedValue({ skills, syncStatus: status }),
    refresh: vi.fn().mockResolvedValue({ registries: [] }),
    getSyncStatus: vi.fn().mockResolvedValue(status),
    listRegistries: vi.fn().mockResolvedValue([DEFAULT_REGISTRY_RECORD]),
    addRegistry: vi.fn().mockResolvedValue(DEFAULT_REGISTRY_RECORD),
    updateRegistry: vi.fn().mockResolvedValue(DEFAULT_REGISTRY_RECORD),
    removeRegistry: vi.fn().mockResolvedValue(undefined),
    syncRegistry: vi.fn().mockResolvedValue(DEFAULT_REGISTRY_RECORD.syncStatus),
    listSkillFiles: vi.fn().mockResolvedValue({ files: [] }),
    readSkillFile: vi.fn().mockResolvedValue({ path: '', sizeBytes: 0, kind: 'missing' }),
    checkAppUpdate: vi.fn().mockResolvedValue(undefined),
    getAutoDownloadAppUpdates: vi.fn().mockResolvedValue(true),
    setAutoDownloadAppUpdates: vi.fn().mockResolvedValue(undefined),
    getAppUpdateState: vi.fn().mockResolvedValue({ kind: 'idle', currentVersion: '0.0.6' }),
    downloadAppUpdate: vi.fn().mockResolvedValue(undefined),
    restartForAppUpdate: vi.fn().mockResolvedValue(undefined),
    onAppUpdateState: vi.fn().mockReturnValue(() => {}),
    onSyncStatus: vi.fn().mockReturnValue(() => {}),
    onCatalogueUpdated: vi.fn().mockReturnValue(() => {}),
    onAutoUpdateResult: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as RendererApi
}

function viewButton(name: 'Catalogue' | 'Installed' | 'Updates'): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Views' })).getByRole('button', {
    name: new RegExp(`^${name}`),
  })
}

describe('App shell', () => {
  it('renders the wordmark and the catalogue with no skill detail panel before a selection', async () => {
    const skills = [skill({ id: 'alpha', name: 'Alpha', description: 'First skill' })]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    expect(screen.getByText('Got Skills')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Catalogue' })).toBeInTheDocument()
    await screen.findByText('Alpha')
    expect(screen.queryByRole('region', { name: 'Skill detail' })).not.toBeInTheDocument()
    await screen.findByText('Synced')
  })

  it('selecting a skill opens its detail panel, and the close control hides it and clears the selection', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [{ target: '~/.claude/skills', state: 'not-installed' }],
      }),
    ]
    const install = vi.fn().mockResolvedValue({
      registryId: REG,
      folderName: 'alpha',
      skillId: `${REG}/alpha`,
      mirrorRevision: 'deadbeef',
      contentHash: 'hash',
      provenanceSha: 'deadbeef',
      cliVersion: '1.5.15',
      perTarget: [
        { target: '~/.claude/skills', outcome: 'installed', method: 'symlink', paths: [] },
      ],
      installedAt: new Date().toISOString(),
    })
    const api = fakeApi(
      syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg()] }),
      skills,
      {
        install,
        detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET])),
      }
    )
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Alpha'))
    const detail = screen.getByRole('region', { name: 'Skill detail' })
    expect(within(detail).getByRole('heading', { name: 'Alpha' })).toBeInTheDocument()
    await act(async () => {
      within(detail).getByRole('button', { name: 'Install to all' }).click()
    })
    expect(await screen.findByRole('list', { name: 'Install results' })).toBeInTheDocument()

    fireEvent.click(within(detail).getByRole('button', { name: 'Close skill detail' }))
    expect(screen.queryByRole('region', { name: 'Skill detail' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Alpha'))
    expect(screen.getByRole('region', { name: 'Skill detail' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Install results' })).not.toBeInTheDocument()
  })

  it('renders the sync status fetched over the IPC seam', async () => {
    const api = fakeApi(syncStatus({ lastSyncedAt: new Date().toISOString(), revision: 'abc1234' }))
    render(<App api={api} />)
    expect(await screen.findByText('Synced')).toBeInTheDocument()
    expect(api.getSyncStatus).toHaveBeenCalledOnce()
  })

  it('subscribes to sync status updates and reflects a pushed failure', async () => {
    let push: ((s: SyncStatus) => void) | undefined
    const api = fakeApi(syncStatus(), [], {
      onSyncStatus: vi.fn((cb: (s: SyncStatus) => void) => {
        push = cb
        return () => {}
      }),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')

    act(() => push?.(syncStatus({ phase: 'failed', reason: 'offline' })))
    expect(await screen.findByText('Sync failed')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't reach the registry/)
  })

  it('renders catalogue rows from getCatalogue (name + one-line description)', async () => {
    const skills = [
      skill({ id: 'alpha', name: 'Alpha', description: 'First skill' }),
      skill({ id: 'beta', name: 'Beta', description: 'Second skill' }),
    ]
    render(<App api={fakeApi(syncStatus({ visibleSkillCount: 2 }), skills)} />)
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('First skill')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('searches skill names, descriptions, and ids case-insensitively', async () => {
    const skills = [
      skill({
        id: 'to-spec',
        name: 'Write a Spec',
        description: 'Turn rough notes into a written specification',
      }),
      skill({
        id: 'grilling',
        name: 'Grilling',
        description: 'Stress-test a plan before building',
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Write a Spec')

    const search = screen.getByRole('searchbox', { name: 'Search skills' })
    expect(search).toBeEnabled()

    fireEvent.change(search, { target: { value: 'ROUGH NOTES' } })
    expect(screen.getByText('Write a Spec')).toBeInTheDocument()
    expect(screen.queryByText('Grilling')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'grilling' } })
    expect(screen.queryByText('Write a Spec')).not.toBeInTheDocument()
    expect(screen.getByText('Grilling')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'to-spec' } })
    expect(screen.getByText('Write a Spec')).toBeInTheDocument()
    expect(screen.queryByText('Grilling')).not.toBeInTheDocument()
  })

  it('has no registry dropdown', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('filters the catalogue by registry when multiple registries are configured', async () => {
    const secondRegistry: RegistryRecord = {
      id: 'reg-2',
      url: 'https://github.com/example-org/skills',
      branch: 'main',
      enabled: true,
      autoUpdate: false,
      githubOwner: 'example-org',
      githubRepo: 'skills',
      colour: null,
      syncStatus: { registryId: 'reg-2', phase: 'synced', lastSyncedAt: null },
    }
    const skills = [
      skill({
        id: 'alpha',
        registryId: REG,
        name: 'Alpha Skill',
        description: 'From default registry',
      }),
      skill({
        id: 'beta',
        registryId: 'reg-2',
        registryLabel: 'example-org/skills',
        name: 'Beta Skill',
        description: 'From second registry',
      }),
    ]
    render(
      <App
        api={fakeApi(syncStatus(), skills, {
          listRegistries: vi.fn().mockResolvedValue([DEFAULT_REGISTRY_RECORD, secondRegistry]),
        })}
      />
    )
    await screen.findByText('Alpha Skill')

    fireEvent.click(registryButton('example-org/skills'))

    expect(screen.queryByText('Alpha Skill')).not.toBeInTheDocument()
    expect(screen.getByText('Beta Skill')).toBeInTheDocument()
  })

  it('combines search with the selected view and explains no matches', async () => {
    const skills = [
      skill({
        id: 'installed',
        name: 'Installed Skill',
        description: 'Already on this Mac',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
      skill({
        id: 'discover',
        name: 'Discover Skill',
        description: 'Not installed yet',
        perTarget: [{ target: '~/.claude/skills', state: 'not-installed' }],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Installed Skill')

    fireEvent.click(viewButton('Installed'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: 'Discover' },
    })

    expect(screen.queryByText('Installed Skill')).not.toBeInTheDocument()
    expect(screen.queryByText('Discover Skill')).not.toBeInTheDocument()
    expect(screen.getByText('No skills match your search.')).toBeInTheDocument()
  })

  it('shows the offline banner with last-synced copy while keeping the Refresh control', async () => {
    const lastSyncedAt = new Date().toISOString()
    render(
      <App
        api={fakeApi(
          syncStatus({ phase: 'failed', lastSyncedAt, reason: 'offline', visibleSkillCount: 2 }),
          [skill({ id: 'alpha', name: 'Alpha', description: 'Cached' })]
        )}
      />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't reach the registry/)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh catalogue' })).toBeInTheDocument()
  })

  it('shows distinct empty and access-required banners', async () => {
    const { rerender } = render(
      <App api={fakeApi(syncStatus({ phase: 'failed', reason: 'empty' }))} />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/check the repo URL in Settings/)

    rerender(<App api={fakeApi(syncStatus({ phase: 'failed', reason: 'access-required' }))} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Repository not found or access required/
    )
  })

  it('clears the access-required banner once system Git access recovers', async () => {
    let push: ((s: SyncStatus) => void) | undefined
    const api = fakeApi(syncStatus({ phase: 'failed', reason: 'access-required' }), [], {
      onSyncStatus: vi.fn((cb: (s: SyncStatus) => void) => {
        push = cb
        return () => {}
      }),
    })
    render(<App api={api} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Repository not found or access required/
    )
    expect(await screen.findByText('Sync failed')).toBeInTheDocument()

    act(() =>
      push?.(
        syncStatus({
          phase: 'synced',
          lastSyncedAt: new Date().toISOString(),
          revision: 'abc1234',
          registries: [reg()],
        })
      )
    )
    expect(await screen.findByText('Synced')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Refresh calls api.refresh()', async () => {
    const api = fakeApi(syncStatus())
    render(<App api={api} />)
    await screen.findByText('Synced')
    await act(async () => {
      screen.getByRole('button', { name: 'Refresh catalogue' }).click()
    })
    expect(api.refresh).toHaveBeenCalled()
  })

  it('Settings edits a registry url/branch via updateRegistry', async () => {
    const api = fakeApi(syncStatus())
    render(<App api={api} />)
    await screen.findByText('Synced')

    await act(async () => {
      screen.getByRole('button', { name: 'Settings' }).click()
    })
    expect(await screen.findByRole('main', { name: 'Settings' })).toBeInTheDocument()

    await act(async () => {
      screen.getByRole('button', { name: 'Edit anthropics/skills' }).click()
    })
    const url = screen.getByLabelText('Registry URL') as HTMLInputElement
    const branch = screen.getByLabelText('Branch') as HTMLInputElement
    expect(url.value).toBe(DEFAULT_REGISTRY_RECORD.url)
    expect(branch.value).toBe(DEFAULT_REGISTRY_RECORD.branch)

    await act(async () => {
      fireEvent.change(url, { target: { value: 'https://github.com/example/trial-skills' } })
      fireEvent.change(branch, { target: { value: 'main' } })
      screen.getByRole('button', { name: 'Save' }).click()
    })

    expect(api.updateRegistry).toHaveBeenCalledWith({
      id: 'default',
      url: 'https://github.com/example/trial-skills',
      branch: 'main',
    })
  })

  it('fresh-install primary control still routes through install', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        latestVersion: 'abc1234',
        perTarget: [
          { target: '~/.claude/skills', state: 'not-installed' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
    ]
    const api = fakeApi(
      syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg()] }),
      skills,
      {
        detectTargets: vi
          .fn()
          .mockResolvedValue(detection([CLAUDE_CODE_TARGET, CURSOR_SHARED_TARGET])),
      }
    )
    render(<App api={api} />)
    await screen.findByText('Alpha')
    await act(async () => {
      screen.getByText('Alpha').click()
    })
    expect(await screen.findByRole('button', { name: 'Install to all' })).toBeInTheDocument()
    const onThisMac = screen.getByRole('region', { name: 'On this Mac' })
    expect(within(onThisMac).getByText('Claude Code')).toBeInTheDocument()
    expect(within(onThisMac).getByText('Cursor')).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'Install to all' }).click()
    })
    expect(api.install).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.claude/skills', '~/.agents/skills'],
      mirrorRevision: 'deadbeef',
    })
    expect(api.repair).not.toHaveBeenCalled()
  })

  it('detail hero shows registry owner, updated date, and labeled identity chips', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        latestVersion: 'abc1234',
        updatedAt: '2026-07-10T03:04:05Z',
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByText('Alpha'))

    expect(await screen.findByText('anthropics/skills · Updated Jul 10, 2026')).toBeInTheDocument()
    const identity = screen.getByLabelText('Skill identity')
    expect(within(identity).getByText('ID')).toBeInTheDocument()
    expect(within(identity).getByText('alpha')).toBeInTheDocument()
    expect(within(identity).getByText('Revision')).toBeInTheDocument()
    expect(within(identity).getByText('abc1234')).toBeInTheDocument()
  })

  it('detail hero omits unavailable updated and revision metadata cleanly', async () => {
    const skills = [skill({ id: 'alpha', name: 'Alpha', description: 'First skill' })]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByText('Alpha'))

    expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument()
    const detail = screen.getByRole('region', { name: 'Skill detail' })
    expect(await within(detail).findByText('anthropics/skills')).toBeInTheDocument()
    const identity = screen.getByLabelText('Skill identity')
    expect(within(identity).getByText('alpha')).toBeInTheDocument()
    expect(within(identity).queryByText('Revision')).not.toBeInTheDocument()
  })

  it('Catalogue / Installed / Updates views filter the rows, and rows show status glyphs', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'Installed skill',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed', installedVersion: 'abc1234' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
      skill({
        id: 'beta',
        name: 'Beta',
        description: 'Has update',
        perTarget: [
          { target: '~/.claude/skills', state: 'update-available', installedVersion: 'abc1234' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
      skill({
        id: 'gamma',
        name: 'Gamma',
        description: 'Not installed',
        perTarget: [
          { target: '~/.claude/skills', state: 'not-installed' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
    ]
    render(<App api={fakeApi(syncStatus({ visibleSkillCount: 3 }), skills)} />)
    await screen.findByText('Alpha')
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
    expect(screen.getByText('Installed in Claude Code')).toBeInTheDocument()
    expect(
      screen.getByText('Installed in Claude Code. Update ready in Claude Code')
    ).toBeInTheDocument()

    await act(async () => {
      viewButton('Installed').click()
    })
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument()

    await act(async () => {
      viewButton('Updates').click()
    })
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
  })

  it('excludes external skills from Installed and repair-only skills from Updates', async () => {
    const skills = [
      skill({
        id: 'installed',
        name: 'Managed install',
        description: 'Installed by the app',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
      skill({
        id: 'update',
        name: 'Catalogue update',
        description: 'Has a catalogue update',
        perTarget: [{ target: '~/.claude/skills', state: 'update-available' }],
      }),
      skill({
        id: 'repair',
        name: 'Repair needed',
        description: 'Installed but damaged',
        perTarget: [{ target: '~/.claude/skills', state: 'needs-repair' }],
      }),
      skill({
        id: 'external',
        name: 'External skill',
        description: 'Not managed by the app',
        perTarget: [{ target: '~/.claude/skills', state: 'external' }],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Managed install')

    fireEvent.click(viewButton('Installed'))
    expect(screen.getByText('Managed install')).toBeInTheDocument()
    expect(screen.getByText('Catalogue update')).toBeInTheDocument()
    expect(screen.getByText('Repair needed')).toBeInTheDocument()
    expect(screen.queryByText('External skill')).not.toBeInTheDocument()

    fireEvent.click(viewButton('Updates'))
    expect(screen.getByText('Catalogue update')).toBeInTheDocument()
    expect(screen.queryByText('Managed install')).not.toBeInTheDocument()
    expect(screen.queryByText('Repair needed')).not.toBeInTheDocument()
    expect(screen.queryByText('External skill')).not.toBeInTheDocument()
  })

  it('does not offer Remove for an unmanaged external skill', async () => {
    const skills = [
      skill({
        id: 'external',
        name: 'External skill',
        description: 'Installed outside this app',
        perTarget: [{ target: '~/.claude/skills', state: 'external' }],
      }),
    ]
    const uninstall = vi.fn()
    const api = fakeApi(syncStatus({ registries: [reg()] }), skills, { uninstall })

    render(<App api={api} />)
    await screen.findByText('External skill')
    fireEvent.click(screen.getByText('External skill'))

    expect(within(screen.getByRole('option')).getByText('—')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(uninstall).not.toHaveBeenCalled()
  })

  it('soft-deleted installed skill shows dimmed Removed row with Remove action', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'Gone from registry',
        softDeleted: true,
        perTarget: [
          {
            target: '~/.claude/skills',
            state: 'removed-from-registry',
            installedVersion: 'abc1234',
          },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
    ]
    const uninstall = vi.fn().mockResolvedValue({
      registryId: REG,
      folderName: 'alpha',
      skillId: `${REG}/alpha`,
      perTarget: [{ target: '~/.claude/skills', outcome: 'installed', paths: [] }],
    })
    const api = fakeApi(
      syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg()] }),
      skills,
      {
        uninstall,
        detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET])),
        getCatalogue: vi
          .fn()
          .mockResolvedValueOnce({
            skills,
            syncStatus: syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg()] }),
          })
          .mockResolvedValue({
            skills: [],
            syncStatus: syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg()] }),
          }),
      }
    )
    render(<App api={api} />)
    await screen.findByText('Alpha')
    const row = screen.getByRole('option')
    expect(
      within(row).getByText('Installed in Claude Code. Removed in Claude Code')
    ).toBeInTheDocument()
    expect(row.className).toMatch(/soft-deleted/)

    await act(async () => {
      screen.getByText('Alpha').click()
    })
    expect(screen.queryByRole('button', { name: 'Install to all' })).not.toBeInTheDocument()
    const removeBtn = await screen.findByRole('button', { name: 'Remove' })
    await act(async () => {
      removeBtn.click()
    })
    expect(uninstall).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'Cancel' }).click()
    })
    expect(uninstall).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    await act(async () => {
      screen.getByRole('button', { name: 'Remove' }).click()
    })
    await act(async () => {
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }).click()
    })
    expect(uninstall).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
    })
  })

  it('makes the main button an Update of only the targets that are behind', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'Update available',
        perTarget: [
          { target: '~/.claude/skills', state: 'update-available', installedVersion: 'abc1234' },
          { target: '~/.agents/skills', state: 'installed', installedVersion: 'deadbee' },
        ],
      }),
    ]
    const repair = vi.fn().mockResolvedValue({
      registryId: REG,
      folderName: 'alpha',
      skillId: `${REG}/alpha`,
      mirrorRevision: 'deadbeef',
      contentHash: 'hash',
      provenanceSha: 'deadbeef',
      cliVersion: '1.5.15',
      perTarget: [
        { target: '~/.claude/skills', outcome: 'installed', method: 'symlink', paths: [] },
      ],
      installedAt: new Date().toISOString(),
    })
    const api = fakeApi(
      syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg()] }),
      skills,
      {
        repair,
        detectTargets: vi
          .fn()
          .mockResolvedValue(detection([CLAUDE_CODE_TARGET, CURSOR_SHARED_TARGET])),
      }
    )

    render(<App api={api} />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('Alpha'))

    expect(await screen.findByRole('button', { name: 'Update' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install to all' })).not.toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'Update' }).click()
    })

    expect(repair).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'deadbeef',
    })
    expect(api.install).not.toHaveBeenCalled()
  })

  it('needs-repair surfaces Repair affordance', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'Broken install',
        perTarget: [
          { target: '~/.claude/skills', state: 'needs-repair', installedVersion: 'abc1234' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
    ]
    const repair = vi.fn().mockResolvedValue({
      registryId: REG,
      folderName: 'alpha',
      skillId: `${REG}/alpha`,
      mirrorRevision: 'deadbeef',
      contentHash: 'hash',
      provenanceSha: 'abc1234',
      cliVersion: '1.5.15',
      perTarget: [
        { target: '~/.claude/skills', outcome: 'installed', method: 'symlink', paths: [] },
      ],
      installedAt: new Date().toISOString(),
    })
    const api = fakeApi(
      syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg()] }),
      skills,
      {
        repair,
        detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET])),
      }
    )
    render(<App api={api} />)
    await screen.findByText('Alpha')
    await act(async () => {
      screen.getByText('Alpha').click()
    })
    const repairBtn = await screen.findByRole('button', { name: 'Repair' })
    await act(async () => {
      repairBtn.click()
    })
    expect(repair).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'deadbeef',
    })
  })
})

describe('Console sidebar', () => {
  it('holds the brand, the views, the sync status and the Settings entry', async () => {
    render(<App api={fakeApi(syncStatus({ lastSyncedAt: new Date().toISOString() }))} />)
    const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' })

    expect(within(sidebar).getByText('Got Skills')).toBeInTheDocument()
    expect(viewButton('Catalogue')).toBeInTheDocument()
    expect(viewButton('Installed')).toBeInTheDocument()
    expect(viewButton('Updates')).toBeInTheDocument()
    expect(sidebar).toContainElement(viewButton('Catalogue'))

    const status = screen.getByRole('status')
    expect(sidebar).toContainElement(status)
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('Synced')
    const settings = within(sidebar).getByRole('button', { name: 'Settings' })
    expect(within(settings).getByText('⌘,')).toBeInTheDocument()
  })

  it('marks the current view and titles the toolbar with its name', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')

    expect(screen.getByRole('heading', { level: 1, name: 'Catalogue' })).toBeInTheDocument()
    expect(viewButton('Catalogue')).toHaveAttribute('aria-current', 'page')

    fireEvent.click(viewButton('Installed'))
    expect(screen.getByRole('heading', { level: 1, name: 'Installed' })).toBeInTheDocument()
    expect(viewButton('Installed')).toHaveAttribute('aria-current', 'page')
    expect(viewButton('Catalogue')).not.toHaveAttribute('aria-current')

    fireEvent.click(viewButton('Updates'))
    expect(screen.getByRole('heading', { level: 1, name: 'Updates' })).toBeInTheDocument()
    expect(viewButton('Updates')).toHaveAttribute('aria-current', 'page')
  })

  it('counts the whole catalogue in each view, ignoring search and registry, and badges Updates', async () => {
    const skills = [
      skill({
        id: 'a',
        name: 'Alpha',
        description: 'Up to date',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
      skill({
        id: 'b',
        name: 'Beta',
        description: 'Behind',
        perTarget: [{ target: '~/.claude/skills', state: 'update-available' }],
      }),
      skill({
        id: 'c',
        name: 'Gamma',
        description: 'Available',
        registryId: 'reg-2',
        perTarget: [{ target: '~/.claude/skills', state: 'not-installed' }],
      }),
      skill({
        id: 'd',
        name: 'Delta',
        description: 'Installed elsewhere',
        perTarget: [{ target: '~/.claude/skills', state: 'external' }],
      }),
    ]
    const secondRegistry = registryRecord({
      id: 'reg-2',
      url: 'https://github.com/example/skills',
      githubOwner: 'example',
      githubRepo: 'skills',
    })
    render(
      <App
        api={fakeApi(syncStatus(), skills, {
          listRegistries: vi.fn().mockResolvedValue([DEFAULT_REGISTRY_RECORD, secondRegistry]),
        })}
      />
    )
    await screen.findByText('Alpha')

    expect(viewButton('Catalogue')).toHaveAccessibleName('Catalogue 4')
    expect(viewButton('Installed')).toHaveAccessibleName('Installed 2')
    expect(viewButton('Updates')).toHaveAccessibleName('Updates 1')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: 'Gamma' },
    })
    fireEvent.click(registryButton('example/skills'))
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(viewButton('Catalogue')).toHaveAccessibleName('Catalogue 4')
    expect(viewButton('Installed')).toHaveAccessibleName('Installed 2')
    expect(viewButton('Updates')).toHaveAccessibleName('Updates 1')
  })

  it('shows no Updates badge when nothing is behind', async () => {
    const skills = [
      skill({
        id: 'a',
        name: 'Alpha',
        description: 'Up to date',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')

    expect(viewButton('Installed')).toHaveAccessibleName('Installed 1')
    expect(viewButton('Updates')).toHaveAccessibleName('Updates')
  })

  it('opens Settings in the main area while the sidebar stays, and a view returns to the catalogue', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')

    await openSettings()
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    expect(viewButton('Catalogue')).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('status')).toHaveTextContent('Synced')
    expect(screen.queryByRole('region', { name: 'Catalogue' })).not.toBeInTheDocument()
    expect(screen.queryByRole('searchbox', { name: 'Search skills' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close settings' })).not.toBeInTheDocument()

    fireEvent.click(viewButton('Installed'))
    expect(screen.queryByRole('main', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Catalogue' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Installed' })).toBeInTheDocument()
  })

  it('lists every supported agent in Settings with its folder and whether it is detected', async () => {
    const agents: SupportedAgent[] = [
      { id: 'claude-code', displayName: 'Claude Code', target: '~/.claude/skills', detected: true },
      { id: 'cursor', displayName: 'Cursor', target: '~/.agents/skills', detected: false },
    ]
    render(
      <App
        api={fakeApi(syncStatus(), [], {
          detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET], agents)),
        })}
      />
    )
    await screen.findByText('Synced')

    await openSettings()
    const section = screen.getByRole('region', { name: 'Agents' })
    const claude = within(section).getByRole('listitem', { name: 'Claude Code' })
    expect(claude).toHaveTextContent('~/.claude/skills')
    expect(claude).toHaveTextContent('Detected')
    fireEvent.click(within(section).getByRole('button', { name: /^All/ }))
    const cursor = within(section).getByRole('listitem', { name: 'Cursor' })
    expect(cursor).toHaveTextContent('~/.agents/skills')
    expect(cursor).toHaveTextContent('Not detected')
    expect(within(section).queryAllByRole('switch')).toEqual([])
  })

  it('searches and filters the Settings agent list by detection', async () => {
    const agents: SupportedAgent[] = [
      { id: 'claude-code', displayName: 'Claude Code', target: '~/.claude/skills', detected: true },
      { id: 'codex', displayName: 'Codex', target: '~/.agents/skills', detected: true },
      { id: 'cursor', displayName: 'Cursor', target: '~/.agents/skills', detected: false },
      { id: 'goose', displayName: 'Goose', target: '~/.config/goose/skills', detected: false },
    ]
    render(
      <App
        api={fakeApi(syncStatus(), [], {
          detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET], agents)),
        })}
      />
    )
    await screen.findByText('Synced')
    await openSettings()
    const section = screen.getByRole('region', { name: 'Agents' })
    const listed = () =>
      within(section)
        .queryAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label'))
    const filter = (name: RegExp) => within(section).getByRole('button', { name })

    expect(listed()).toEqual(['Claude Code', 'Codex'])
    expect(filter(/^Detected/)).toHaveAttribute('aria-pressed', 'true')
    expect(filter(/^All/)).toHaveTextContent('All4')
    expect(filter(/^Detected/)).toHaveTextContent('Detected2')
    expect(filter(/^Not detected/)).toHaveTextContent('Not detected2')

    fireEvent.click(filter(/^All/))
    expect(listed()).toEqual(['Claude Code', 'Codex', 'Cursor', 'Goose'])
    fireEvent.click(filter(/^Not detected/))
    expect(listed()).toEqual(['Cursor', 'Goose'])

    fireEvent.change(within(section).getByRole('searchbox', { name: 'Search agents' }), {
      target: { value: '.agents' },
    })
    expect(listed()).toEqual(['Cursor'])
    expect(filter(/^All/)).toHaveTextContent('All2')
    expect(filter(/^Detected/)).toHaveTextContent('Detected1')

    fireEvent.click(filter(/^All/))
    expect(listed()).toEqual(['Codex', 'Cursor'])

    fireEvent.change(within(section).getByRole('searchbox', { name: 'Search agents' }), {
      target: { value: 'zzz' },
    })
    expect(listed()).toEqual([])
    expect(within(section).getByText('No agents match.')).toBeInTheDocument()
  })

  it('shows each On this Mac target with its state and versions on their own line', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        latestVersion: 'abc1234',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed', installedVersion: 'abc1234' },
          { target: '~/.agents/skills', state: 'update-available', installedVersion: 'deadbee' },
        ],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    fireEvent.click(await screen.findByText('Alpha'))
    const onThisMac = await screen.findByRole('region', { name: 'On this Mac' })

    const claude = within(onThisMac).getByText('Claude Code')
    const claudeState = claude.nextElementSibling
    expect(claudeState?.textContent).toMatch(/Installed · abc1234$/)
    const cursorState = within(onThisMac).getByText('Cursor').nextElementSibling
    expect(cursorState?.textContent).toMatch(/deadbee → abc1234$/)
  })

  it('offers Sync all on the Settings page in place of Refresh, and it refreshes', async () => {
    const api = fakeApi(syncStatus())
    render(<App api={api} />)
    await screen.findByText('Synced')

    await openSettings()
    expect(screen.queryByRole('button', { name: 'Refresh catalogue' })).not.toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'Sync all' }).click()
    })
    expect(api.refresh).toHaveBeenCalledOnce()

    fireEvent.click(viewButton('Catalogue'))
    expect(screen.queryByRole('button', { name: 'Sync all' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh catalogue' })).toBeInTheDocument()
  })

  it('clears an edit in progress and the add form each time Settings opens', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')

    await openSettings()
    await act(async () => {
      screen.getByRole('button', { name: 'Edit anthropics/skills' }).click()
    })
    fireEvent.change(screen.getByLabelText('New registry URL'), {
      target: { value: 'https://github.com/example/new-skills' },
    })
    expect(screen.getByRole('form', { name: 'Edit anthropics/skills' })).toBeInTheDocument()

    fireEvent.click(viewButton('Catalogue'))
    await openSettings()

    expect(screen.queryByRole('form', { name: 'Edit anthropics/skills' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('New registry URL')).toHaveValue('')
  })

  it('opens Settings with ⌘, and does not toggle it closed', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')

    fireEvent.keyDown(document, { key: ',' })
    expect(screen.queryByRole('main', { name: 'Settings' })).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: ',', metaKey: true })
    expect(screen.getByRole('main', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: ',', metaKey: true })
    expect(screen.getByRole('main', { name: 'Settings' })).toBeInTheDocument()
  })

  it('focuses the search field with ⌘K, which the field hints at', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')
    const search = screen.getByRole('searchbox', { name: 'Search skills' })
    expect(screen.getByText('⌘K')).toBeInTheDocument()
    expect(search).not.toHaveFocus()

    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(search).toHaveFocus()
  })

  it('returns to the catalogue before focusing search when ⌘K is pressed in Settings', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')
    await openSettings()

    fireEvent.keyDown(document, { key: 'k', metaKey: true })

    expect(screen.queryByRole('main', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Catalogue' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search skills' })).toHaveFocus()
  })

  it('ignores ⌘, and ⌘K while the Remove confirmation is open', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'Installed',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed', installedVersion: 'abc1234' },
        ],
      }),
    ]
    const api = fakeApi(syncStatus(), skills, {
      detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET])),
    })
    render(<App api={api} />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('Alpha'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    fireEvent.keyDown(document, { key: ',', metaKey: true })

    expect(screen.getByRole('searchbox', { name: 'Search skills' })).not.toHaveFocus()
    expect(screen.queryByRole('main', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })
})

function registryButton(label: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Registries' })).getByRole('button', {
    name: new RegExp(`^${label}`),
  })
}

describe('Sidebar Registries', () => {
  it('lists a single Registry with the number of catalogue skills it supplies', async () => {
    const skills = [
      skill({ id: 'a', name: 'Alpha', description: 'One', registryId: 'default' }),
      skill({ id: 'b', name: 'Beta', description: 'Two', registryId: 'default' }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')

    const registries = screen.getByRole('navigation', { name: 'Registries' })
    expect(screen.getByRole('complementary', { name: 'Sidebar' })).toContainElement(registries)
    expect(within(registries).getAllByRole('button')).toHaveLength(1)
    expect(registryButton('anthropics/skills')).toHaveAccessibleName('anthropics/skills 2')
  })

  it('filters the current view to a selected Registry and clears it when selected again', async () => {
    const secondRegistry = registryRecord({
      id: 'reg-2',
      url: 'https://github.com/example-org/skills',
      githubOwner: 'example-org',
      githubRepo: 'skills',
    })
    const skills = [
      skill({
        id: 'alpha',
        registryId: 'default',
        name: 'Alpha',
        description: 'Default, installed',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
      skill({
        id: 'beta',
        registryId: 'reg-2',
        registryLabel: 'example-org/skills',
        name: 'Beta',
        description: 'Second, installed',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
      skill({
        id: 'gamma',
        registryId: 'reg-2',
        registryLabel: 'example-org/skills',
        name: 'Gamma',
        description: 'Second, available',
      }),
    ]
    render(
      <App
        api={fakeApi(syncStatus(), skills, {
          listRegistries: vi.fn().mockResolvedValue([DEFAULT_REGISTRY_RECORD, secondRegistry]),
        })}
      />
    )
    await screen.findByText('Alpha')
    expect(registryButton('anthropics/skills')).toHaveAccessibleName('anthropics/skills 1')
    expect(registryButton('example-org/skills')).toHaveAccessibleName('example-org/skills 2')

    fireEvent.click(registryButton('example-org/skills'))
    expect(registryButton('example-org/skills')).toHaveAttribute('aria-pressed', 'true')
    expect(registryButton('anthropics/skills')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()

    fireEvent.click(viewButton('Installed'))
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument()

    fireEvent.click(registryButton('example-org/skills'))
    expect(registryButton('example-org/skills')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument()
  })

  it('shows a failed Registry as Sync failed instead of a count', async () => {
    const failedRegistry = registryRecord({
      id: 'reg-2',
      url: 'https://github.com/example-org/private-skills',
      githubOwner: 'example-org',
      githubRepo: 'private-skills',
      syncStatus: {
        registryId: 'reg-2',
        phase: 'failed',
        reason: 'access-required',
        lastSyncedAt: null,
      },
    })
    const skills = [
      skill({ id: 'alpha', registryId: 'default', name: 'Alpha', description: 'One' }),
    ]
    render(
      <App
        api={fakeApi(syncStatus({ phase: 'partial' }), skills, {
          listRegistries: vi.fn().mockResolvedValue([DEFAULT_REGISTRY_RECORD, failedRegistry]),
        })}
      />
    )
    await screen.findByText('Alpha')

    const failed = registryButton('example-org/private-skills')
    expect(failed).toHaveAccessibleName('example-org/private-skills Sync failed')
    expect(within(failed).getByText('×')).toBeInTheDocument()
    expect(within(failed).queryByText('0')).not.toBeInTheDocument()
    expect(registryButton('anthropics/skills')).toHaveAccessibleName('anthropics/skills 1')
  })

  it('shows a Disabled Registry as off and filters to its installed-only skills', async () => {
    const disabledRegistry = registryRecord({
      id: 'reg-2',
      url: 'https://github.com/example-org/old-skills',
      githubOwner: 'example-org',
      githubRepo: 'old-skills',
      enabled: false,
      syncStatus: { registryId: 'reg-2', phase: 'failed', reason: 'offline', lastSyncedAt: null },
    })
    const skills = [
      skill({ id: 'alpha', registryId: 'default', name: 'Alpha', description: 'Available' }),
      skill({
        id: 'legacy',
        registryId: 'reg-2',
        registryLabel: 'example-org/old-skills',
        name: 'Legacy',
        description: 'Left behind',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
    ]
    render(
      <App
        api={fakeApi(syncStatus(), skills, {
          listRegistries: vi.fn().mockResolvedValue([DEFAULT_REGISTRY_RECORD, disabledRegistry]),
        })}
      />
    )
    await screen.findByText('Alpha')

    const disabled = registryButton('example-org/old-skills')
    expect(disabled).toHaveAccessibleName('example-org/old-skills off')
    expect(disabled).toBeEnabled()

    fireEvent.click(disabled)
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Legacy')).toBeInTheDocument()
  })

  it('titles the toolbar with the view followed by the selected Registry', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')

    fireEvent.click(registryButton('anthropics/skills'))
    expect(
      screen.getByRole('heading', { level: 1, name: 'Catalogue · anthropics/skills' })
    ).toBeInTheDocument()

    fireEvent.click(viewButton('Updates'))
    expect(
      screen.getByRole('heading', { level: 1, name: 'Updates · anthropics/skills' })
    ).toBeInTheDocument()

    fireEvent.click(registryButton('anthropics/skills'))
    expect(screen.getByRole('heading', { level: 1, name: 'Updates' })).toBeInTheDocument()
  })

  it('returns from Settings to the filtered view when a Registry is selected', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')
    await openSettings()

    fireEvent.click(registryButton('anthropics/skills'))
    expect(screen.queryByRole('main', { name: 'Settings' })).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 1, name: 'Catalogue · anthropics/skills' })
    ).toBeInTheDocument()
  })
})

describe('Catalogue table', () => {
  it('has one Installed column header and no per-target headers', async () => {
    const skills = [skill({ id: 'alpha', name: 'Alpha', description: 'First skill' })]
    render(
      <App
        api={fakeApi(syncStatus(), skills, {
          detectTargets: vi
            .fn()
            .mockResolvedValue(detection([CLAUDE_CODE_TARGET, GOOSE_TARGET, WIDE_SHARED_TARGET])),
        })}
      />
    )
    await screen.findByText('Alpha')

    const header = document.querySelector('.catalogue-head')!
    expect(Array.from(header.children).map((cell) => cell.textContent)).toEqual([
      'Skill',
      'Installed',
    ])
  })

  it('counts the visible targets that have the skill and names them on hover', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed' },
          { target: '~/.config/goose/skills', state: 'not-installed' },
          { target: '~/.agents/skills', state: 'removed-from-registry' },
        ],
      }),
    ]
    render(
      <App
        api={fakeApi(syncStatus(), skills, {
          detectTargets: vi
            .fn()
            .mockResolvedValue(detection([CLAUDE_CODE_TARGET, GOOSE_TARGET, WIDE_SHARED_TARGET])),
        })}
      />
    )
    await screen.findByText('Alpha')
    const row = screen.getByRole('option')

    expect(within(row).getByText('2')).toBeInTheDocument()
    expect(within(row).getByRole('tooltip', { hidden: true })).toHaveTextContent(
      'Claude Code, Cline, Codex, Cursor, Zed'
    )
    expect(
      within(row).getByText(
        'Installed in Claude Code, Cline, Codex, Cursor, Zed. Removed in Cline, Codex, Cursor, Zed'
      )
    ).toBeInTheDocument()
  })

  it('shows a dash for a skill installed nowhere and keeps an update visible on its row', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [
          { target: '~/.claude/skills', state: 'external' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
      skill({
        id: 'beta',
        name: 'Beta',
        description: 'Second skill',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed' },
          { target: '~/.agents/skills', state: 'update-available' },
        ],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')
    const [alpha, beta] = screen.getAllByRole('option')

    expect(within(alpha).getByText('—')).toBeInTheDocument()
    expect(within(alpha).getByText('Not installed')).toBeInTheDocument()
    expect(within(beta).getByText('2')).toBeInTheDocument()
    expect(within(beta).getByText('Update')).toBeInTheDocument()
    expect(
      within(beta).getByText('Installed in Claude Code, Cursor. Update ready in Cursor')
    ).toBeInTheDocument()
  })

  it('marks a row whose skill was removed from its registry', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        softDeleted: true,
        perTarget: [
          { target: '~/.claude/skills', state: 'installed' },
          { target: '~/.agents/skills', state: 'removed-from-registry' },
        ],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')
    const row = screen.getByRole('option')

    expect(within(row).getByText('2')).toBeInTheDocument()
    expect(within(row).getByText('Removed')).toBeInTheDocument()
    expect(within(row).getByText('×')).toBeInTheDocument()
    expect(
      within(row).getByText('Installed in Claude Code, Cursor. Removed in Cursor')
    ).toBeInTheDocument()
  })

  it("marks a row whose skill's registry was deleted", async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        orphaned: true,
        perTarget: [
          { target: '~/.claude/skills', state: 'installed' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')
    const row = screen.getByRole('option')

    expect(within(row).getByText('1')).toBeInTheDocument()
    expect(within(row).getByText('Orphaned')).toBeInTheDocument()
    expect(within(row).getByText('⊘')).toBeInTheDocument()
    expect(
      within(row).getByText('Installed in Claude Code. Orphaned in Claude Code')
    ).toBeInTheDocument()
  })

  it('shows Repair over Update when a row has both', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [
          { target: '~/.claude/skills', state: 'update-available' },
          { target: '~/.agents/skills', state: 'needs-repair' },
        ],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')
    const row = screen.getByRole('option')

    expect(within(row).getByText('Repair')).toBeInTheDocument()
    expect(within(row).queryByText('Update')).not.toBeInTheDocument()
    expect(
      within(row).getByText('Installed in Claude Code, Cursor. Needs repair in Cursor')
    ).toBeInTheDocument()
  })

  it('hides the column header from assistive tech', async () => {
    const skills = [skill({ id: 'alpha', name: 'Alpha', description: 'First skill' })]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')

    expect(isInaccessible(document.querySelector('.catalogue-head')!)).toBe(true)
  })

  it('counts and lists only the visible targets from detection results', async () => {
    const hidden: InstallTargetStatus = {
      id: '~/.codeium/windsurf/skills',
      label: 'Windsurf',
      shared: false,
      visible: false,
      agents: [{ id: 'windsurf', displayName: 'Windsurf', detected: false }],
    }
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed' },
          { target: '~/.agents/skills', state: 'not-installed' },
          { target: '~/.codeium/windsurf/skills', state: 'installed' },
        ],
      }),
    ]
    render(
      <App
        api={fakeApi(syncStatus({ registries: [reg()] }), skills, {
          detectTargets: vi
            .fn()
            .mockResolvedValue(detection([CLAUDE_CODE_TARGET, CURSOR_SHARED_TARGET, hidden])),
        })}
      />
    )
    await screen.findByText('Alpha')

    const row = screen.getByRole('option')
    expect(within(row).getByText('1')).toBeInTheDocument()
    expect(within(row).getByRole('tooltip', { hidden: true })).toHaveTextContent(/^Claude Code$/)

    fireEvent.click(screen.getByText('Alpha'))
    const onThisMac = await screen.findByRole('region', { name: 'On this Mac' })
    expect(within(onThisMac).getByText('Claude Code')).toBeInTheDocument()
    expect(within(onThisMac).getByText('Cursor')).toBeInTheDocument()
    expect(within(onThisMac).queryByText('Windsurf')).not.toBeInTheDocument()

    const detail = screen.getByRole('region', { name: 'Skill detail' })
    expect(within(detail).queryByRole('button', { name: /Choose .* target/ })).toBeNull()
    expect(within(detail).queryByRole('menu')).toBeNull()
    expect(detail.textContent).not.toMatch(/\bapps\b/)
  })

  it('makes the main button Install to all for the lacking targets no one else holds', async () => {
    const zencoder: InstallTargetStatus = {
      id: '~/.zencoder/skills',
      label: 'Zencoder',
      shared: false,
      visible: true,
      agents: [],
    }
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [
          { target: '~/.claude/skills', state: 'other-registry' },
          { target: '~/.config/goose/skills', state: 'external' },
          { target: '~/.agents/skills', state: 'not-installed' },
          { target: '~/.zencoder/skills', state: 'update-available', installedVersion: 'abc1234' },
        ],
      }),
    ]
    const api = fakeApi(syncStatus({ registries: [reg()] }), skills, {
      install: vi.fn().mockResolvedValue({
        registryId: REG,
        folderName: 'alpha',
        skillId: `${REG}/alpha`,
        mirrorRevision: 'deadbeef',
        contentHash: 'hash',
        provenanceSha: 'deadbeef',
        cliVersion: '1.7.0',
        perTarget: [],
        installedAt: new Date().toISOString(),
      }),
      detectTargets: vi
        .fn()
        .mockResolvedValue(
          detection([CLAUDE_CODE_TARGET, GOOSE_TARGET, WIDE_SHARED_TARGET, zencoder])
        ),
    })
    render(<App api={api} />)
    fireEvent.click(await screen.findByText('Alpha'))

    const actions = document.querySelector('.detail-actions') as HTMLElement
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Install to all', 'Remove'])
    await act(async () => {
      within(actions).getByRole('button', { name: 'Install to all' }).click()
    })
    expect(api.install).toHaveBeenLastCalledWith({
      registryId: REG,
      folderName: 'alpha',
      mirrorRevision: 'deadbeef',
      targets: ['~/.agents/skills'],
    })
    expect(api.repair).not.toHaveBeenCalled()
  })

  it('shows a target held by another registry and leaves it out of Install to all', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [
          { target: '~/.claude/skills', state: 'other-registry' },
          { target: '~/.config/goose/skills', state: 'not-installed' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
    ]
    const api = fakeApi(syncStatus({ registries: [reg()] }), skills, {
      install: vi.fn().mockResolvedValue({
        registryId: REG,
        folderName: 'alpha',
        skillId: `${REG}/alpha`,
        mirrorRevision: 'deadbeef',
        contentHash: 'hash',
        provenanceSha: 'deadbeef',
        cliVersion: '1.7.0',
        perTarget: [],
        installedAt: new Date().toISOString(),
      }),
      detectTargets: vi
        .fn()
        .mockResolvedValue(detection([CLAUDE_CODE_TARGET, GOOSE_TARGET, WIDE_SHARED_TARGET])),
    })
    render(<App api={api} />)
    fireEvent.click(await screen.findByText('Alpha'))

    expect(within(screen.getByRole('option')).getByText('—')).toBeInTheDocument()
    const onThisMac = await screen.findByRole('region', { name: 'On this Mac' })
    expect(within(onThisMac).getByText('Held by another registry')).toBeInTheDocument()
    expect(
      within(onThisMac).queryByRole('button', { name: 'Install to Claude Code' })
    ).not.toBeInTheDocument()

    await act(async () => {
      screen.getByRole('button', { name: 'Install to all' }).click()
    })
    expect(api.install).toHaveBeenLastCalledWith({
      registryId: REG,
      folderName: 'alpha',
      mirrorRevision: 'deadbeef',
      targets: ['~/.config/goose/skills', '~/.agents/skills'],
    })
  })

  it('gives every visible target its own actions in the detail panel, plus Install to all', async () => {
    const zencoder: InstallTargetStatus = {
      id: '~/.zencoder/skills',
      label: 'Zencoder, Zenflow',
      shared: false,
      visible: true,
      agents: [],
    }
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed' },
          { target: '~/.config/goose/skills', state: 'update-available' },
          { target: '~/.agents/skills', state: 'not-installed' },
          { target: '~/.zencoder/skills', state: 'not-installed' },
        ],
      }),
    ]
    const result = {
      registryId: REG,
      folderName: 'alpha',
      skillId: `${REG}/alpha`,
      mirrorRevision: 'deadbeef',
      contentHash: 'hash',
      provenanceSha: 'deadbeef',
      cliVersion: '1.7.0',
      perTarget: [],
      installedAt: new Date().toISOString(),
    }
    const api = fakeApi(syncStatus({ registries: [reg()] }), skills, {
      install: vi.fn().mockResolvedValue(result),
      repair: vi.fn().mockResolvedValue(result),
      uninstall: vi
        .fn()
        .mockResolvedValue({ registryId: REG, folderName: 'alpha', skillId: '', perTarget: [] }),
      detectTargets: vi
        .fn()
        .mockResolvedValue(
          detection([CLAUDE_CODE_TARGET, GOOSE_TARGET, WIDE_SHARED_TARGET, zencoder])
        ),
    })
    render(<App api={api} />)
    fireEvent.click(await screen.findByText('Alpha'))
    const onThisMac = await screen.findByRole('region', { name: 'On this Mac' })

    expect(
      within(onThisMac)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    ).toEqual([
      'Remove from Claude Code',
      'Update Goose',
      'Remove from Goose',
      'Install to Cline, Codex, Cursor, Zed',
      'Install to Zencoder, Zenflow',
    ])

    const request = { registryId: REG, folderName: 'alpha', mirrorRevision: 'deadbeef' }
    await act(async () => {
      screen.getByRole('button', { name: 'Install to all' }).click()
    })
    expect(api.install).toHaveBeenLastCalledWith({
      ...request,
      targets: ['~/.agents/skills', '~/.zencoder/skills'],
    })

    await act(async () => {
      within(onThisMac).getByRole('button', { name: 'Install to Zencoder, Zenflow' }).click()
    })
    expect(api.install).toHaveBeenLastCalledWith({ ...request, targets: ['~/.zencoder/skills'] })

    await act(async () => {
      within(onThisMac).getByRole('button', { name: 'Update Goose' }).click()
    })
    expect(api.repair).toHaveBeenLastCalledWith({ ...request, targets: ['~/.config/goose/skills'] })

    await act(async () => {
      within(onThisMac).getByRole('button', { name: 'Remove from Goose' }).click()
    })
    expect(api.uninstall).not.toHaveBeenCalled()
    await act(async () => {
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }).click()
    })
    expect(api.uninstall).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.config/goose/skills'],
    })
  })

  it('stops counting a target once removing its last install hides it', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [{ target: '~/.config/goose/skills', state: 'installed' }],
      }),
    ]
    const undetectedGoose = { ...GOOSE_TARGET, label: 'Goose' }
    const api = fakeApi(syncStatus({ registries: [reg()] }), skills, {
      uninstall: vi
        .fn()
        .mockResolvedValue({ registryId: REG, folderName: 'alpha', skillId: '', perTarget: [] }),
      detectTargets: vi
        .fn()
        .mockResolvedValueOnce(detection([CLAUDE_CODE_TARGET, undetectedGoose]))
        .mockResolvedValue(detection([CLAUDE_CODE_TARGET, { ...undetectedGoose, visible: false }])),
    })
    render(<App api={api} />)
    fireEvent.click(await screen.findByText('Alpha'))
    const row = screen.getByRole('option')
    expect(within(row).getByText('Installed in Goose')).toBeInTheDocument()

    await act(async () => {
      screen.getByRole('button', { name: 'Remove from Goose' }).click()
    })
    await act(async () => {
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }).click()
    })

    expect(within(row).getByText('Not installed')).toBeInTheDocument()
  })

  it('names the Shared Target by its detected label', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [{ target: '~/.agents/skills', state: 'installed' }],
      }),
    ]
    render(
      <App
        api={fakeApi(syncStatus(), skills, {
          detectTargets: vi
            .fn()
            .mockResolvedValue(
              detection([CLAUDE_CODE_TARGET, { ...CURSOR_SHARED_TARGET, label: 'Shared folder' }])
            ),
        })}
      />
    )
    await screen.findByText('Alpha')

    expect(
      within(screen.getByRole('option')).getByRole('tooltip', { hidden: true })
    ).toHaveTextContent(/^Shared folder$/)
  })

  it.each([
    ['installed', '2'],
    ['update-available', '2'],
    ['needs-repair', '2'],
    ['removed-from-registry', '2'],
    ['external', '—'],
    ['orphaned', '—'],
    ['other-registry', '—'],
    ['not-installed', '—'],
  ] as const)('shows %s on both targets as %s', async (state, shown) => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [
          { target: '~/.claude/skills', state },
          { target: '~/.agents/skills', state },
        ],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')

    expect(within(screen.getByRole('option')).getByText(shown)).toBeInTheDocument()
  })

  it('treats a target with no reported state as not installed', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')

    expect(within(screen.getByRole('option')).getByText('1')).toBeInTheDocument()
  })

  it('has no Revision column', async () => {
    const skills = [
      skill({ id: 'alpha', name: 'Alpha', description: 'First skill', latestVersion: '9f8e7d6' }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')

    expect(screen.queryByText('Revision')).not.toBeInTheDocument()
    expect(within(screen.getByRole('option')).queryByText('9f8e7d6')).not.toBeInTheDocument()
  })

  it('shows the Registry colour dot, named for the Registry, on each row', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        registryLabel: 'team/skills',
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')

    expect(
      within(screen.getByRole('option')).getByRole('img', { name: 'team/skills' })
    ).toBeInTheDocument()
  })

  it('shows a chosen Registry Colour on the sidebar and catalogue dots', async () => {
    const skills = [
      skill({ id: 'alpha', name: 'Alpha', description: 'First skill', registryId: 'default' }),
    ]
    render(
      <App
        api={fakeApi(syncStatus(), skills, {
          listRegistries: vi.fn().mockResolvedValue([registryRecord({ colour: '#aabbcc' })]),
        })}
      />
    )
    await screen.findByText('Alpha')

    expect(registryButton('anthropics/skills').querySelector('.dot')).toHaveStyle({
      background: '#aabbcc',
    })
    expect(
      within(screen.getByRole('option')).getByRole('img', { name: 'anthropics/skills' })
    ).toHaveStyle({ background: '#aabbcc' })
  })

  it('shows a disabled Registry grey even when it has a chosen colour', async () => {
    render(
      <App
        api={fakeApi(syncStatus(), [], {
          listRegistries: vi
            .fn()
            .mockResolvedValue([registryRecord({ enabled: false, colour: '#aabbcc' })]),
        })}
      />
    )
    await screen.findByRole('navigation', { name: 'Registries' })

    expect(registryButton('anthropics/skills').querySelector('.dot')).toHaveStyle({
      background: '#5b5b64',
    })
    await openSettings()
    const [row] = within(screen.getByRole('main', { name: 'Settings' })).getAllByRole('listitem')
    expect(row.querySelector('.dot')).toHaveStyle({ background: '#5b5b64' })
  })
})

describe('Catalogue empty states', () => {
  const installedSkill = skill({
    id: 'alpha',
    name: 'Alpha',
    description: 'Up to date',
    perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
  })
  const availableSkill = skill({
    id: 'beta',
    name: 'Beta',
    description: 'Not installed yet',
    perTarget: [{ target: '~/.claude/skills', state: 'not-installed' }],
  })

  it('says there are no updates in the Updates view', async () => {
    render(<App api={fakeApi(syncStatus(), [installedSkill])} />)
    await screen.findByText('Alpha')

    fireEvent.click(viewButton('Updates'))
    expect(screen.getByText('No updates available.')).toBeInTheDocument()
  })

  it('says there are no installed skills in the Installed view', async () => {
    render(<App api={fakeApi(syncStatus(), [availableSkill])} />)
    await screen.findByText('Beta')

    fireEvent.click(viewButton('Installed'))
    expect(screen.getByText('No installed skills.')).toBeInTheDocument()
  })

  it('says there are no skills yet for an empty catalogue', async () => {
    render(<App api={fakeApi(syncStatus(), [])} />)
    expect(await screen.findByText('No skills yet.')).toBeInTheDocument()
  })

  it('says the catalogue is syncing while a sync is in flight', async () => {
    render(<App api={fakeApi(syncStatus({ phase: 'syncing' }), [])} />)
    expect(await screen.findByText('Syncing catalogue…')).toBeInTheDocument()
  })

  it('points at Settings when the registry has no skills', async () => {
    render(<App api={fakeApi(syncStatus({ phase: 'failed', reason: 'empty' }), [])} />)
    expect(
      await screen.findByText('No skills found — check the repo URL in Settings')
    ).toBeInTheDocument()
  })

  it('says there are no skills from a registry that supplies none', async () => {
    const secondRegistry = registryRecord({
      id: 'reg-2',
      url: 'https://github.com/example/skills',
      githubOwner: 'example',
      githubRepo: 'skills',
    })
    render(
      <App
        api={fakeApi(syncStatus(), [installedSkill], {
          listRegistries: vi.fn().mockResolvedValue([DEFAULT_REGISTRY_RECORD, secondRegistry]),
        })}
      />
    )
    await screen.findByText('Alpha')

    fireEvent.click(registryButton('example/skills'))
    expect(screen.getByText('No skills from this registry.')).toBeInTheDocument()
  })
})

const BOTH_TARGETS = [CLAUDE_CODE_TARGET, CURSOR_SHARED_TARGET]

function registryRecord(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return { ...DEFAULT_REGISTRY_RECORD, ...overrides }
}

async function openSettings(): Promise<void> {
  await act(async () => {
    screen.getByRole('button', { name: 'Settings' }).click()
  })
  await screen.findByRole('main', { name: 'Settings' })
}

describe('Settings registry list', () => {
  it('lists each registry as a row with url, branch, skill count, and sync state', async () => {
    const registries = [
      registryRecord({
        id: 'default',
        syncStatus: {
          registryId: 'default',
          phase: 'synced',
          lastSyncedAt: new Date().toISOString(),
          visibleSkillCount: 5,
        },
      }),
      registryRecord({
        id: 'team',
        url: 'https://github.com/team/skills',
        branch: 'release',
        enabled: false,
        githubOwner: 'team',
        githubRepo: 'skills',
        syncStatus: { registryId: 'team', phase: 'synced', lastSyncedAt: null },
      }),
    ]
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockResolvedValue(registries),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()
    const settings = screen.getByRole('main', { name: 'Settings' })

    expect(
      within(settings).getByText(/Registries supply skills to the combined catalogue/)
    ).toBeInTheDocument()
    const [anthropics, team] = within(settings).getAllByRole('listitem')

    expect(within(anthropics).getByText('anthropics/skills')).toBeInTheDocument()
    expect(within(anthropics).getByText(DEFAULT_REGISTRY_RECORD.url)).toBeInTheDocument()
    expect(within(anthropics).getByText('main')).toBeInTheDocument()
    expect(within(anthropics).getByText('5 skills')).toBeInTheDocument()
    expect(within(anthropics).getByText('Synced')).toBeInTheDocument()

    expect(within(team).getByText('team/skills')).toBeInTheDocument()
    expect(within(team).getByText('https://github.com/team/skills')).toBeInTheDocument()
    expect(within(team).getByText('release')).toBeInTheDocument()
    expect(within(team).getByText(/^Disabled/)).toBeInTheDocument()
    expect(within(team).getByRole('button', { name: 'Sync team/skills' })).toBeDisabled()
    expect(within(team).getByRole('button', { name: 'Edit team/skills' })).toBeEnabled()
  })

  it('calls out an access-required failure with its guidance and keeps Sync available', async () => {
    const registries = [
      registryRecord({ id: 'default' }),
      registryRecord({
        id: 'team',
        url: 'https://github.com/team/skills',
        githubOwner: 'team',
        githubRepo: 'skills',
        syncStatus: {
          registryId: 'team',
          phase: 'failed',
          lastSyncedAt: null,
          reason: 'access-required',
          stale: true,
        },
      }),
    ]
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockResolvedValue(registries),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()
    const [anthropics, team] = within(screen.getByRole('main', { name: 'Settings' })).getAllByRole(
      'listitem'
    )

    expect(within(team).getByText('Repository not found or access required')).toBeInTheDocument()
    expect(
      within(team).getByText(/Verify you can clone it over HTTPS using system Git/)
    ).toBeInTheDocument()
    expect(within(team).getByText('Sync failed — showing last snapshot')).toBeInTheDocument()
    expect(
      within(anthropics).queryByText('Repository not found or access required')
    ).not.toBeInTheDocument()

    await act(async () => {
      within(team).getByRole('button', { name: 'Sync team/skills' }).click()
    })
    expect(api.syncRegistry).toHaveBeenCalledWith('team')
  })

  it('offers an add card whose Add is disabled until a URL is entered and whose branch auto-detects', async () => {
    render(<App api={fakeApi(syncStatus())} />)
    await screen.findByText('Synced')
    await openSettings()
    const add = screen.getByRole('region', { name: 'Add registry' })

    expect(within(add).getByLabelText('New registry branch')).toHaveAttribute(
      'placeholder',
      'auto-detect'
    )
    expect(
      within(add).getByText('Branch is detected automatically when possible.')
    ).toBeInTheDocument()
    expect(within(add).getByRole('button', { name: 'Add registry' })).toBeDisabled()

    fireEvent.change(within(add).getByLabelText('New registry URL'), {
      target: { value: 'https://github.com/example/team-skills' },
    })
    expect(within(add).getByRole('button', { name: 'Add registry' })).toBeEnabled()
  })

  it('adds a registry with an optional branch', async () => {
    const added = registryRecord({ id: 'new', url: 'https://github.com/example/team-skills' })
    const api = fakeApi(syncStatus(), [], {
      addRegistry: vi.fn().mockResolvedValue(added),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()

    fireEvent.change(screen.getByLabelText('New registry URL'), {
      target: { value: 'https://github.com/example/team-skills' },
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Add registry' }).click()
    })
    expect(api.addRegistry).toHaveBeenCalledWith({
      url: 'https://github.com/example/team-skills',
    })
  })

  it('surfaces a credential-bearing url rejection from the backend', async () => {
    const api = fakeApi(syncStatus(), [], {
      addRegistry: vi
        .fn()
        .mockRejectedValue(new Error('Registry URL must not contain embedded credentials')),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()

    fireEvent.change(screen.getByLabelText('New registry URL'), {
      target: { value: 'https://user:tok@github.com/example/secret' },
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Add registry' }).click()
    })
    expect(
      await screen.findByText(/Registry URL must not contain embedded credentials/)
    ).toBeInTheDocument()
  })

  it('shows a branch-required add error while keeping the branch field available', async () => {
    const api = fakeApi(syncStatus(), [], {
      addRegistry: vi
        .fn()
        .mockRejectedValue(
          new Error('Could not detect the default branch; specify a branch for this registry.')
        ),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()

    fireEvent.change(screen.getByLabelText('New registry URL'), {
      target: { value: 'https://example.com/private/skills' },
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Add registry' }).click()
    })
    expect(await screen.findByText(/specify a branch for this registry/)).toBeInTheDocument()
    expect(screen.getByLabelText('New registry branch')).toBeInTheDocument()
  })

  it('shows stored Auto Update switches and saves either flipped value before reloading', async () => {
    const registries = [registryRecord({ autoUpdate: false })]
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockImplementation(async () => registries),
      updateRegistry: vi.fn().mockImplementation(async (req) => {
        registries[0] = registryRecord({ autoUpdate: req.autoUpdate })
        return registries[0]
      }),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()
    const toggle = screen.getByRole('switch', { name: 'anthropics/skills auto update' })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText('Auto-update')).toBeVisible()
    const catalogueReads = vi.mocked(api.getCatalogue).mock.calls.length
    const registryReads = vi.mocked(api.listRegistries).mock.calls.length
    await act(async () => {
      toggle.click()
    })
    expect(api.updateRegistry).toHaveBeenCalledWith({ id: 'default', autoUpdate: true })
    expect(toggle).toBeChecked()
    expect(vi.mocked(api.getCatalogue).mock.calls.length).toBeGreaterThan(catalogueReads)
    expect(vi.mocked(api.listRegistries).mock.calls.length).toBeGreaterThan(registryReads)
    await act(async () => {
      toggle.click()
    })
    expect(api.updateRegistry).toHaveBeenLastCalledWith({ id: 'default', autoUpdate: false })
    expect(toggle).not.toBeChecked()
  })

  it('previews a picked Registry Colour on the Settings dot without saving it', async () => {
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockResolvedValue([registryRecord({ colour: '#aabbcc' })]),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()
    const button = screen.getByRole('button', { name: 'Change colour for anthropics/skills' })
    const input = screen.getByLabelText<HTMLInputElement>('Colour for anthropics/skills')
    const opened = vi.fn()
    input.addEventListener('click', opened)

    fireEvent.click(button)
    expect(opened).toHaveBeenCalledOnce()
    expect(input).toHaveValue('#aabbcc')

    fireEvent.input(input, { target: { value: '#112233' } })
    expect(button.querySelector('.dot')).toHaveStyle({ background: '#112233' })
    expect(api.updateRegistry).not.toHaveBeenCalled()
  })

  it('saves a picked Registry Colour once when the picker closes and shows it everywhere', async () => {
    const registries = [registryRecord()]
    const skills = [
      skill({ id: 'alpha', name: 'Alpha', description: 'First skill', registryId: 'default' }),
    ]
    const api = fakeApi(syncStatus(), skills, {
      listRegistries: vi.fn().mockImplementation(async () => registries),
      updateRegistry: vi.fn().mockImplementation(async (req) => {
        registries[0] = registryRecord({ colour: req.colour })
        return registries[0]
      }),
    })
    render(<App api={api} />)
    await screen.findByText('Alpha')
    await openSettings()
    const input = screen.getByLabelText('Colour for anthropics/skills')
    const registryReads = vi.mocked(api.listRegistries).mock.calls.length

    fireEvent.input(input, { target: { value: '#112233' } })
    fireEvent.input(input, { target: { value: '#445566' } })
    await act(async () => {
      fireEvent.change(input, { target: { value: '#445566' } })
    })

    expect(api.updateRegistry).toHaveBeenCalledOnce()
    expect(api.updateRegistry).toHaveBeenCalledWith({ id: 'default', colour: '#445566' })
    expect(vi.mocked(api.listRegistries).mock.calls.length).toBeGreaterThan(registryReads)
    expect(
      screen
        .getByRole('button', { name: 'Change colour for anthropics/skills' })
        .querySelector('.dot')
    ).toHaveStyle({ background: '#445566' })
    expect(registryButton('anthropics/skills').querySelector('.dot')).toHaveStyle({
      background: '#445566',
    })
    fireEvent.click(viewButton('Catalogue'))
    expect(
      within(await screen.findByRole('option')).getByRole('img', { name: 'anthropics/skills' })
    ).toHaveStyle({ background: '#445566' })
  })

  it('shows a rejected Registry Colour save and puts the saved colour back', async () => {
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockResolvedValue([registryRecord({ colour: '#aabbcc' })]),
      updateRegistry: vi.fn().mockRejectedValue(new Error('Colour must be #rrggbb hex')),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()
    const input = screen.getByLabelText('Colour for anthropics/skills')

    fireEvent.input(input, { target: { value: '#112233' } })
    await act(async () => {
      fireEvent.change(input, { target: { value: '#112233' } })
    })

    expect(
      within(screen.getByRole('region', { name: 'Registries' })).getByRole('alert')
    ).toHaveTextContent('Colour must be #rrggbb hex')
    expect(
      screen
        .getByRole('button', { name: 'Change colour for anthropics/skills' })
        .querySelector('.dot')
    ).toHaveStyle({ background: '#aabbcc' })
    expect(input).toHaveValue('#aabbcc')
  })

  it('offers no colour button on a disabled Registry or the edit row', async () => {
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockResolvedValue([
        registryRecord({ id: 'default', colour: '#aabbcc' }),
        registryRecord({
          id: 'team',
          url: 'https://github.com/team/skills',
          enabled: false,
          colour: '#aabbcc',
          githubOwner: 'team',
          githubRepo: 'skills',
        }),
      ]),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()

    expect(screen.queryByRole('button', { name: 'Change colour for team/skills' })).toBeNull()
    expect(screen.queryByLabelText('Colour for team/skills')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit anthropics/skills' }))
    expect(screen.queryByRole('button', { name: /^Change colour for/ })).toBeNull()
    expect(screen.queryByLabelText(/^Colour for/)).toBeNull()
  })

  it('keeps a disabled Registry Auto Update value visible and unchangeable', async () => {
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi
        .fn()
        .mockResolvedValue([registryRecord({ enabled: false, autoUpdate: true })]),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()
    const toggle = screen.getByRole('switch', { name: 'anthropics/skills auto update' })
    expect(toggle).toBeChecked()
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(api.updateRegistry).not.toHaveBeenCalled()
  })

  it('disables Auto Update switches while a Registry operation is pending', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockResolvedValue([registryRecord({ autoUpdate: true })]),
      syncRegistry: vi.fn().mockImplementation(async () => {
        await pending
        return DEFAULT_REGISTRY_RECORD.syncStatus
      }),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Sync anthropics/skills' }))
    const toggle = screen.getByRole('switch', { name: 'anthropics/skills auto update' })
    expect(toggle).toBeChecked()
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(api.updateRegistry).not.toHaveBeenCalled()
    await act(async () => {
      finish()
    })
    expect(toggle).toBeEnabled()
  })

  it('shows an enabled switch per registry that toggles it through the registry update', async () => {
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockResolvedValue([
        registryRecord({ id: 'default', enabled: true }),
        registryRecord({
          id: 'team',
          url: 'https://github.com/team/skills',
          enabled: false,
          githubOwner: 'team',
          githubRepo: 'skills',
        }),
      ]),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()

    const enabledSwitch = screen.getByRole('switch', { name: 'anthropics/skills enabled' })
    const disabledSwitch = screen.getByRole('switch', { name: 'team/skills enabled' })
    expect(enabledSwitch).toBeChecked()
    expect(disabledSwitch).not.toBeChecked()
    expect(screen.getAllByText('Enabled')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^(Enable|Disable) / })).not.toBeInTheDocument()

    await act(async () => {
      disabledSwitch.click()
    })
    expect(api.updateRegistry).toHaveBeenCalledWith({ id: 'team', enabled: true })
  })

  it('disables, syncs, and removes a registry through the seam', async () => {
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockResolvedValue([registryRecord({ id: 'default', enabled: true })]),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()

    await act(async () => {
      screen.getByRole('switch', { name: 'anthropics/skills enabled' }).click()
    })
    expect(api.updateRegistry).toHaveBeenCalledWith({ id: 'default', enabled: false })

    await act(async () => {
      screen.getByRole('button', { name: 'Sync anthropics/skills' }).click()
    })
    expect(api.syncRegistry).toHaveBeenCalledWith('default')

    await act(async () => {
      screen.getByRole('button', { name: 'Remove anthropics/skills' }).click()
    })
    await act(async () => {
      within(screen.getByRole('alertdialog'))
        .getByRole('button', { name: 'Remove registry' })
        .click()
    })
    expect(api.removeRegistry).toHaveBeenCalledWith('default')
  })

  it('asks for confirmation before removing a registry', async () => {
    const api = fakeApi(syncStatus(), [], {
      listRegistries: vi.fn().mockResolvedValue([registryRecord({ id: 'default' })]),
    })
    render(<App api={api} />)
    await screen.findByText('Synced')
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Remove anthropics/skills' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Remove registry?' })
    expect(dialog).toHaveAccessibleDescription(/anthropics\/skills/)
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove anthropics/skills' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove anthropics/skills' }))
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(screen.getByRole('main', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    expect(api.removeRegistry).not.toHaveBeenCalled()

    await act(async () => {
      within(screen.getByRole('alertdialog'))
        .getByRole('button', { name: 'Remove registry' })
        .click()
    })
    expect(api.removeRegistry).toHaveBeenCalledWith('default')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('warns before a branch change when the registry supplied installed skills', async () => {
    const skills = [
      skill({
        registryId: 'default',
        id: 'default/alpha',
        folderName: 'alpha',
        name: 'Alpha',
        description: 'Installed from default',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
    ]
    const api = fakeApi(syncStatus(), skills, {
      listRegistries: vi.fn().mockResolvedValue([registryRecord({ id: 'default' })]),
    })
    render(<App api={api} />)
    await screen.findByText('Alpha')
    await openSettings()

    await act(async () => {
      screen.getByRole('button', { name: 'Edit anthropics/skills' }).click()
    })
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'next' } })
    await act(async () => {
      screen.getByRole('button', { name: 'Save' }).click()
    })
    expect(api.updateRegistry).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/update source/i)

    await act(async () => {
      screen.getByRole('button', { name: /Change branch anyway/i }).click()
    })
    expect(api.updateRegistry).toHaveBeenCalledWith({
      id: 'default',
      url: DEFAULT_REGISTRY_RECORD.url,
      branch: 'next',
    })
  })

  it('cancelling the branch-change warning leaves the registry untouched', async () => {
    const skills = [
      skill({
        registryId: 'default',
        id: 'default/alpha',
        folderName: 'alpha',
        name: 'Alpha',
        description: 'Installed from default',
        perTarget: [{ target: '~/.claude/skills', state: 'installed' }],
      }),
    ]
    const api = fakeApi(syncStatus(), skills, {
      listRegistries: vi.fn().mockResolvedValue([registryRecord({ id: 'default' })]),
    })
    render(<App api={api} />)
    await screen.findByText('Alpha')
    await openSettings()

    await act(async () => {
      screen.getByRole('button', { name: 'Edit anthropics/skills' }).click()
    })
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'next' } })
    await act(async () => {
      screen.getByRole('button', { name: 'Save' }).click()
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/update source/i)
    expect(api.updateRegistry).not.toHaveBeenCalled()

    await act(async () => {
      screen.getByRole('button', { name: 'Cancel' }).click()
    })
    expect(api.updateRegistry).not.toHaveBeenCalled()
    expect(screen.queryByText(/update source/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Branch')).not.toBeInTheDocument()
  })
})

describe('Catalogue provenance and conflict', () => {
  it('shows registry provenance on skill rows', async () => {
    const skills = [
      skill({
        id: 'r1/alpha',
        folderName: 'alpha',
        name: 'Alpha',
        description: 'A',
        registryLabel: 'team/skills',
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Alpha')
    expect(screen.getByRole('img', { name: 'team/skills' })).toBeInTheDocument()
  })

  it('marks same-name skills from different registries as a Skill Conflict', async () => {
    const skills = [
      skill({
        registryId: 'r1',
        id: 'r1/dup',
        folderName: 'dup',
        name: 'Duplicate',
        description: 'from one',
        registryLabel: 'org/one',
        conflict: true,
      }),
      skill({
        registryId: 'r2',
        id: 'r2/dup',
        folderName: 'dup',
        name: 'Duplicate',
        description: 'from two',
        registryLabel: 'org/two',
        conflict: true,
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findAllByText('Duplicate')
    expect(screen.getAllByTitle('Skill Conflict').length).toBeGreaterThan(0)
  })

  it('names the registry as visible text on each conflict row, and not on other rows', async () => {
    const skills = [
      skill({
        registryId: 'r1',
        id: 'r1/dup',
        folderName: 'dup',
        name: 'Duplicate',
        description: 'from one',
        registryLabel: 'org/one',
        conflict: true,
      }),
      skill({
        registryId: 'r2',
        id: 'r2/dup',
        folderName: 'dup',
        name: 'Duplicate',
        description: 'from two',
        registryLabel: 'org/two',
        conflict: true,
      }),
      skill({
        registryId: 'r3',
        id: 'r3/solo',
        folderName: 'solo',
        name: 'Solo',
        description: 'only here',
        registryLabel: 'org/three',
      }),
    ]
    render(<App api={fakeApi(syncStatus(), skills)} />)
    await screen.findByText('Solo')
    const rows = within(screen.getByRole('region', { name: 'Catalogue' })).getAllByRole('option')
    const rowFor = (description: string): HTMLElement =>
      rows.find((row) => within(row).queryByText(description) !== null)!
    expect(within(rowFor('from one')).getByText('org/one')).toBeVisible()
    expect(within(rowFor('from one')).queryByText('org/two')).not.toBeInTheDocument()
    expect(within(rowFor('from two')).getByText('org/two')).toBeVisible()
    expect(within(rowFor('from two')).queryByText('org/one')).not.toBeInTheDocument()
    expect(within(rowFor('only here')).queryByText('org/three')).not.toBeInTheDocument()
  })

  it('gates install of a stale skill behind acknowledgement', async () => {
    const skills = [
      skill({
        id: 'r1/alpha',
        folderName: 'alpha',
        name: 'Alpha',
        description: 'Stale snapshot',
        stale: true,
        latestVersion: 'abc1234',
        updatedAt: '2026-07-10T00:00:00Z',
        perTarget: [
          { target: '~/.claude/skills', state: 'not-installed' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
    ]
    const api = fakeApi(
      syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg({ stale: true })] }),
      skills,
      { detectTargets: vi.fn().mockResolvedValue(detection(BOTH_TARGETS)) }
    )
    render(<App api={api} />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('Alpha'))

    expect(await screen.findByText(/Stale snapshot after a failed sync/)).toBeInTheDocument()
    const install = await screen.findByRole('button', { name: 'Install to all' })
    expect(install).toBeDisabled()

    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Acknowledge/i))
    })
    const enabledInstall = screen.getByRole('button', { name: 'Install to all' })
    expect(enabledInstall).toBeEnabled()
    await act(async () => {
      enabledInstall.click()
    })
    expect(api.install).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.claude/skills', '~/.agents/skills'],
      mirrorRevision: 'deadbeef',
      acknowledgeStale: true,
    })
  })

  it('explains an installation collision and how to resolve it', async () => {
    const skills = [
      skill({
        id: 'r1/alpha',
        folderName: 'alpha',
        name: 'Alpha',
        description: 'Collides',
        latestVersion: 'abc1234',
        perTarget: [{ target: '~/.agents/skills', state: 'not-installed' }],
      }),
    ]
    const install = vi
      .fn()
      .mockRejectedValue(
        new InstallationCollisionError(
          '"alpha" is already installed for cursor from another registry. Uninstall it first.',
          'managed',
          'alpha',
          '~/.agents/skills'
        )
      )
    const api = fakeApi(
      syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg()] }),
      skills,
      {
        install,
        detectTargets: vi.fn().mockResolvedValue(detection([CURSOR_SHARED_TARGET])),
      }
    )
    render(<App api={api} />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('Alpha'))
    await act(async () => {
      ;(await screen.findByRole('button', { name: 'Install to all' })).click()
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Uninstall it first/i)
  })

  it('offers uninstall but not install or update for an orphaned installation', async () => {
    const skills = [
      skill({
        registryId: 'gone',
        id: 'gone/alpha',
        folderName: 'alpha',
        name: 'Alpha',
        description: 'Orphaned',
        registryLabel: 'gone/repo',
        orphaned: true,
        perTarget: [
          { target: '~/.claude/skills', state: 'installed', installedVersion: 'abc1234' },
        ],
      }),
    ]
    const api = fakeApi(syncStatus(), skills, {
      listRegistries: vi.fn().mockResolvedValue([]),
      detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET])),
    })
    render(<App api={api} />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('Alpha'))

    expect(screen.queryByRole('button', { name: 'Install to all' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('treats a disabled registry’s installed skill as installed-only', async () => {
    const skills = [
      skill({
        registryId: 'default',
        id: 'default/alpha',
        folderName: 'alpha',
        name: 'Alpha',
        description: 'From disabled source',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed', installedVersion: 'abc1234' },
        ],
      }),
    ]
    const api = fakeApi(syncStatus(), skills, {
      listRegistries: vi
        .fn()
        .mockResolvedValue([registryRecord({ id: 'default', enabled: false })]),
      detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET])),
    })
    render(<App api={api} />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByText('Alpha'))

    expect(screen.queryByRole('button', { name: 'Install to all' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })
})

function installResult(overrides: Partial<InstallResult> = {}): InstallResult {
  return {
    registryId: REG,
    folderName: 'alpha',
    skillId: `${REG}/alpha`,
    mirrorRevision: 'deadbeef',
    contentHash: 'hash',
    provenanceSha: 'deadbeef',
    cliVersion: '1.5.15',
    perTarget: [{ target: '~/.claude/skills', outcome: 'installed', method: 'symlink', paths: [] }],
    installedAt: new Date().toISOString(),
    ...overrides,
  }
}

/** A promise plus its resolvers, for driving a mocked `repair` call by hand. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Update all', () => {
  it('is absent when nothing is behind', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'Up to date',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed', installedVersion: 'abc1234' },
        ],
      }),
    ]
    render(<App api={fakeApi(syncStatus({ registries: [reg()] }), skills)} />)
    await screen.findByText('Alpha')
    expect(screen.queryByRole('region', { name: 'Update all' })).not.toBeInTheDocument()
  })

  it('renders grammatical singular copy when exactly one Skill is behind', async () => {
    const skills = [
      skill({
        id: 'alpha',
        registryId: REG,
        name: 'Alpha',
        description: 'Behind',
        perTarget: [
          { target: '~/.claude/skills', state: 'update-available', installedVersion: 'a1' },
        ],
      }),
    ]
    render(<App api={fakeApi(syncStatus({ registries: [reg()] }), skills)} />)
    await screen.findByText('Alpha')
    expect(screen.getByText('1 skill has an update')).toBeInTheDocument()
  })

  it('shows the count and an enabled action when Skills are behind, unaffected by search, registry filter, or view', async () => {
    const secondRegistry: RegistryRecord = {
      id: 'reg-2',
      url: 'https://github.com/example-org/skills',
      branch: 'main',
      enabled: true,
      autoUpdate: false,
      githubOwner: 'example-org',
      githubRepo: 'skills',
      colour: null,
      syncStatus: { registryId: 'reg-2', phase: 'synced', lastSyncedAt: null },
    }
    const skills = [
      skill({
        id: 'alpha',
        registryId: REG,
        name: 'Alpha',
        description: 'Behind',
        perTarget: [
          { target: '~/.claude/skills', state: 'update-available', installedVersion: 'a1' },
        ],
      }),
      skill({
        id: 'beta',
        registryId: 'reg-2',
        registryLabel: 'example-org/skills',
        name: 'Beta',
        description: 'Current',
        perTarget: [{ target: '~/.claude/skills', state: 'installed', installedVersion: 'b1' }],
      }),
    ]
    render(
      <App
        api={fakeApi(syncStatus({ registries: [reg()] }), skills, {
          listRegistries: vi.fn().mockResolvedValue([DEFAULT_REGISTRY_RECORD, secondRegistry]),
        })}
      />
    )
    await screen.findByText('Alpha')

    expect(screen.getByRole('button', { name: 'Update all (1)' })).toBeEnabled()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: 'Beta' },
    })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update all (1)' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: '' },
    })

    fireEvent.click(registryButton('example-org/skills'))
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update all (1)' })).toBeInTheDocument()
    fireEvent.click(registryButton('example-org/skills'))

    fireEvent.click(viewButton('Installed'))
    expect(screen.getByRole('button', { name: 'Update all (1)' })).toBeInTheDocument()
  })

  it('refreshes and re-derives the work set before dispatching, runs sequentially against only the behind targets, suppresses catalogue reloads mid-run, disables per-Skill controls, and reports a partial-failure summary that leaves the failed Skill update-available', async () => {
    const alpha = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind on claude-code only',
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'a1' },
        { target: '~/.agents/skills', state: 'installed', installedVersion: 'a1' },
      ],
    })
    const gamma = skill({
      id: 'gamma',
      registryId: REG,
      name: 'Gamma',
      description: 'Behind on cursor',
      perTarget: [
        { target: '~/.agents/skills', state: 'update-available', installedVersion: 'g1' },
      ],
    })
    const alphaUpdated = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind on claude-code only',
      perTarget: [
        { target: '~/.claude/skills', state: 'installed', installedVersion: 'a2' },
        { target: '~/.agents/skills', state: 'installed', installedVersion: 'a1' },
      ],
    })

    let catalogueCalls = 0
    const getCatalogue = vi.fn(() => {
      catalogueCalls += 1
      const skills = catalogueCalls <= 2 ? [alpha, gamma] : [alphaUpdated, gamma]
      return Promise.resolve({ skills, syncStatus: syncStatus({ registries: [reg()] }) })
    })

    let pushCatalogueUpdated: (() => void) | undefined
    const refresh = deferred<SyncAllResult>()
    const first = deferred<InstallResult>()
    const second = deferred<InstallResult>()
    const repair = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const api = fakeApi(syncStatus({ registries: [reg()] }), [], {
      getCatalogue,
      repair,
      refresh: vi.fn().mockReturnValue(refresh.promise),
      detectTargets: vi.fn().mockResolvedValue(detection(BOTH_TARGETS)),
      onCatalogueUpdated: vi.fn((cb: () => void) => {
        pushCatalogueUpdated = cb
        return () => {}
      }),
    })

    render(<App api={api} />)
    await screen.findByText('Alpha')
    expect(catalogueCalls).toBe(1)

    fireEvent.click(screen.getByText('Alpha'))
    const alphaUpdateBtn = await screen.findByRole('button', { name: 'Update' })
    expect(alphaUpdateBtn).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Update all (2)' }))

    expect(await screen.findByText('Checking for updates…')).toBeInTheDocument()
    expect(repair).not.toHaveBeenCalled()
    expect(catalogueCalls).toBe(1)
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled()

    await act(async () => {
      refresh.resolve({ registries: [reg()] })
      await refresh.promise
    })

    expect(await screen.findByText('Updating Alpha — 1 of 2')).toBeInTheDocument()
    expect(repair).toHaveBeenNthCalledWith(1, {
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'deadbeef',
    })
    expect(catalogueCalls).toBe(2)

    act(() => pushCatalogueUpdated?.())
    expect(catalogueCalls).toBe(2)

    await act(async () => {
      first.resolve(installResult({ folderName: 'alpha' }))
      await first.promise
    })

    expect(await screen.findByText('Updating Gamma — 2 of 2')).toBeInTheDocument()
    expect(repair).toHaveBeenNthCalledWith(2, {
      registryId: REG,
      folderName: 'gamma',
      targets: ['~/.agents/skills'],
      mirrorRevision: 'deadbeef',
    })

    act(() => pushCatalogueUpdated?.())
    expect(catalogueCalls).toBe(2)

    await act(async () => {
      second.reject(new Error('collision: external skill occupies this folder'))
      try {
        await second.promise
      } catch {}
    })

    expect(await screen.findByText('1 updated · 1 failed')).toBeInTheDocument()
    expect(
      screen.getByText('Gamma: collision: external skill occupies this folder')
    ).toBeInTheDocument()

    expect(catalogueCalls).toBe(3)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByRole('button', { name: 'Update all (1)' })).toBeInTheDocument()
  })

  it('includes a Skill that only became behind during the refresh, and excludes one that stopped being behind, even though the button showed a different count at click time', async () => {
    const alpha = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind at click time',
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'a1' },
      ],
    })
    const alphaResolved = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind at click time',
      perTarget: [{ target: '~/.claude/skills', state: 'installed', installedVersion: 'a2' }],
    })
    const beta = skill({
      id: 'beta',
      registryId: REG,
      name: 'Beta',
      description: 'Newly behind after refresh',
      perTarget: [{ target: '~/.claude/skills', state: 'installed', installedVersion: 'b1' }],
    })
    const betaBehind = skill({
      id: 'beta',
      registryId: REG,
      name: 'Beta',
      description: 'Newly behind after refresh',
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'b1' },
      ],
    })

    let catalogueCalls = 0
    const getCatalogue = vi.fn(() => {
      catalogueCalls += 1
      const skills = catalogueCalls === 1 ? [alpha, beta] : [alphaResolved, betaBehind]
      return Promise.resolve({ skills, syncStatus: syncStatus({ registries: [reg()] }) })
    })
    const repair = vi.fn().mockResolvedValue(installResult({ folderName: 'beta' }))
    const api = fakeApi(syncStatus({ registries: [reg()] }), [], {
      getCatalogue,
      repair,
      detectTargets: vi.fn().mockResolvedValue(detection(BOTH_TARGETS)),
    })

    render(<App api={api} />)
    await screen.findByText('Alpha')
    expect(screen.getByRole('button', { name: 'Update all (1)' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Update all (1)' }))

    expect(await screen.findByText('1 updated')).toBeInTheDocument()
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'beta',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'deadbeef',
    })
  })

  it('recovers to an offer-to-run state, surfacing the error, when the refresh call itself rejects', async () => {
    const alpha = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind',
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'a1' },
      ],
    })

    const refresh = deferred<SyncAllResult>()
    const repair = vi.fn()
    const api = fakeApi(syncStatus({ registries: [reg()] }), [alpha], {
      repair,
      refresh: vi.fn().mockReturnValue(refresh.promise),
      detectTargets: vi.fn().mockResolvedValue(detection(BOTH_TARGETS)),
    })

    render(<App api={api} />)
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Update all (1)' }))
    expect(await screen.findByText('Checking for updates…')).toBeInTheDocument()

    await act(async () => {
      refresh.reject(new Error('network down'))
      try {
        await refresh.promise
      } catch {}
    })

    expect(screen.getByRole('alert')).toHaveTextContent('network down')
    expect(screen.queryByText('Checking for updates…')).not.toBeInTheDocument()
    expect(repair).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Update all (1)' })).toBeEnabled()
  })

  it('offers Cancel only while a run is in flight, and cancelling during the refresh phase dispatches nothing', async () => {
    const alpha = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind',
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'a1' },
      ],
    })

    const refresh = deferred<SyncAllResult>()
    const repair = vi.fn()
    const api = fakeApi(syncStatus({ registries: [reg()] }), [alpha], {
      repair,
      refresh: vi.fn().mockReturnValue(refresh.promise),
      detectTargets: vi.fn().mockResolvedValue(detection(BOTH_TARGETS)),
    })

    render(<App api={api} />)
    await screen.findByText('Alpha')

    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Update all (1)' }))
    expect(await screen.findByText('Checking for updates…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))

    await act(async () => {
      refresh.resolve({ registries: [reg()] })
      await refresh.promise
    })

    expect(await screen.findByText('Run cancelled')).toBeInTheDocument()
    expect(screen.getByText('0 updated')).toBeInTheDocument()
    expect(repair).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument()
  })

  it('cancelling during an item lets it finish, dispatches nothing further, and leaves the undispatched Skill behind for the next run', async () => {
    const alpha = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind',
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'a1' },
      ],
    })
    const gamma = skill({
      id: 'gamma',
      registryId: REG,
      name: 'Gamma',
      description: 'Also behind',
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'g1' },
      ],
    })
    const alphaUpdated = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind',
      perTarget: [{ target: '~/.claude/skills', state: 'installed', installedVersion: 'a2' }],
    })

    let catalogueCalls = 0
    const getCatalogue = vi.fn(() => {
      catalogueCalls += 1
      const skills = catalogueCalls <= 2 ? [alpha, gamma] : [alphaUpdated, gamma]
      return Promise.resolve({ skills, syncStatus: syncStatus({ registries: [reg()] }) })
    })

    const first = deferred<InstallResult>()
    const repair = vi.fn().mockImplementationOnce(() => first.promise)
    const api = fakeApi(syncStatus({ registries: [reg()] }), [], {
      getCatalogue,
      repair,
      detectTargets: vi.fn().mockResolvedValue(detection(BOTH_TARGETS)),
    })

    render(<App api={api} />)
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Update all (2)' }))
    expect(await screen.findByText('Updating Alpha — 1 of 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))

    await act(async () => {
      first.resolve(installResult({ folderName: 'alpha' }))
      await first.promise
    })

    expect(await screen.findByText('Run cancelled')).toBeInTheDocument()
    expect(screen.getByText('1 updated')).toBeInTheDocument()
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'deadbeef',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByRole('button', { name: 'Update all (1)' })).toBeInTheDocument()
  })

  it('holds back stale-Registry Skills by default: discloses the Registry, dispatches none of them, and reports them held back in the summary', async () => {
    const lastSynced = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const alpha = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind, healthy registry',
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'a1' },
      ],
    })
    const gamma = skill({
      id: 'gamma',
      registryId: 'reg-stale',
      registryLabel: 'example-org/skills',
      name: 'Gamma',
      description: 'Behind, stale registry',
      stale: true,
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'g1' },
      ],
    })
    const alphaUpdated = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind, healthy registry',
      perTarget: [{ target: '~/.claude/skills', state: 'installed', installedVersion: 'a2' }],
    })

    const staleReg: RegistrySyncStatus = {
      registryId: 'reg-stale',
      phase: 'failed',
      stale: true,
      lastSyncedAt: lastSynced,
      revision: 'cafebabe',
      reason: 'offline',
    }
    const status = syncStatus({ registries: [reg(), staleReg] })

    let catalogueCalls = 0
    const getCatalogue = vi.fn(() => {
      catalogueCalls += 1
      const skills = catalogueCalls <= 2 ? [alpha, gamma] : [alphaUpdated, gamma]
      return Promise.resolve({ skills, syncStatus: status })
    })
    const repair = vi.fn((req: InstallRequest) =>
      Promise.resolve(installResult({ registryId: req.registryId, folderName: req.folderName }))
    )
    const api = fakeApi(status, [], {
      getCatalogue,
      repair,
      detectTargets: vi.fn().mockResolvedValue(detection(BOTH_TARGETS)),
    })

    render(<App api={api} />)
    await screen.findByText('Alpha')

    const region = screen.getByRole('region', { name: 'Update all' })
    expect(within(region).getByRole('button', { name: 'Update all (2)' })).toBeInTheDocument()
    expect(
      within(region).getByText(/example-org\/skills — last synced 3h ago — 1 skill held back/)
    ).toBeInTheDocument()
    const ack = within(region).getByRole('checkbox', {
      name: 'Include held-back skills from stale registries',
    })
    expect(ack).not.toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Update all (2)' }))

    expect(await screen.findByText('1 updated · 1 held back')).toBeInTheDocument()
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'deadbeef',
    })
    expect(screen.getByText(/Gamma: held back — stale Registry snapshot/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByRole('button', { name: 'Update all (1)' })).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: 'Include held-back skills from stale registries' })
    ).not.toBeChecked()
  })

  it('does not carry the acknowledgement invisibly into a retry after the run fails outright', async () => {
    const gamma = skill({
      id: 'gamma',
      registryId: 'reg-stale',
      registryLabel: 'example-org/skills',
      name: 'Gamma',
      description: 'Behind, stale registry',
      stale: true,
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'g1' },
      ],
    })
    const staleReg: RegistrySyncStatus = {
      registryId: 'reg-stale',
      phase: 'failed',
      stale: true,
      lastSyncedAt: new Date().toISOString(),
      revision: 'cafebabe',
      reason: 'offline',
    }
    const status = syncStatus({ registries: [staleReg] })
    const getCatalogue = vi.fn(() => Promise.resolve({ skills: [gamma], syncStatus: status }))
    const repair = vi.fn()
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ registries: [staleReg] })
    const api = fakeApi(status, [], {
      getCatalogue,
      repair,
      refresh,
      detectTargets: vi.fn().mockResolvedValue(detection(BOTH_TARGETS)),
    })

    render(<App api={api} />)
    await screen.findByText('Gamma')

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Include held-back skills from stale registries' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update all (1)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
    expect(
      screen.queryByRole('checkbox', { name: 'Include held-back skills from stale registries' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Update all (1)' }))
    expect(await screen.findByText('0 updated · 1 held back')).toBeInTheDocument()
    expect(repair).not.toHaveBeenCalled()
  })

  it('with the run-level acknowledgement on, dispatches held-back Skills carrying the stale flag — and healthy items never carry it', async () => {
    const alpha = skill({
      id: 'alpha',
      registryId: REG,
      name: 'Alpha',
      description: 'Behind, healthy registry',
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'a1' },
      ],
    })
    const gamma = skill({
      id: 'gamma',
      registryId: 'reg-stale',
      registryLabel: 'example-org/skills',
      name: 'Gamma',
      description: 'Behind, stale registry',
      stale: true,
      perTarget: [
        { target: '~/.claude/skills', state: 'update-available', installedVersion: 'g1' },
      ],
    })

    const staleReg: RegistrySyncStatus = {
      registryId: 'reg-stale',
      phase: 'failed',
      stale: true,
      lastSyncedAt: new Date().toISOString(),
      revision: 'cafebabe',
      reason: 'offline',
    }
    const status = syncStatus({ registries: [reg(), staleReg] })
    const getCatalogue = vi.fn(() =>
      Promise.resolve({ skills: [alpha, gamma], syncStatus: status })
    )
    const repair = vi.fn((req: InstallRequest) =>
      Promise.resolve(installResult({ registryId: req.registryId, folderName: req.folderName }))
    )
    const api = fakeApi(status, [], {
      getCatalogue,
      repair,
      detectTargets: vi.fn().mockResolvedValue(detection(BOTH_TARGETS)),
    })

    render(<App api={api} />)
    await screen.findByText('Alpha')

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Include held-back skills from stale registries' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update all (2)' }))

    expect(await screen.findByText('2 updated')).toBeInTheDocument()
    expect(repair).toHaveBeenCalledTimes(2)
    expect(repair).toHaveBeenNthCalledWith(1, {
      registryId: REG,
      folderName: 'alpha',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'deadbeef',
    })
    expect(repair).toHaveBeenNthCalledWith(2, {
      registryId: 'reg-stale',
      folderName: 'gamma',
      targets: ['~/.claude/skills'],
      mirrorRevision: 'cafebabe',
      acknowledgeStale: true,
    })
  })
})

describe('Skill files section', () => {
  const FILES = [
    { path: 'SKILL.md', sizeBytes: 512, viewable: true },
    { path: 'scripts/run.sh', sizeBytes: 64, viewable: true },
    { path: 'logo.png', sizeBytes: 2048, viewable: false },
  ]

  function filesApi(
    skills: SkillSummary[],
    listSkillFiles: RendererApi['listSkillFiles']
  ): RendererApi {
    return fakeApi(syncStatus(), skills, { listSkillFiles })
  }

  it('shows every listed file as a relative path with its size in the detail pane', async () => {
    const skills = [skill({ id: 'alpha', name: 'Alpha', description: 'First skill' })]
    const api = filesApi(skills, vi.fn().mockResolvedValue({ files: FILES }))
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Alpha'))
    const section = screen.getByRole('region', { name: 'Files' })
    expect(await within(section).findByText('SKILL.md')).toBeInTheDocument()
    expect(within(section).getByText('512 B')).toBeInTheDocument()
    expect(within(section).getByText('scripts/run.sh')).toBeInTheDocument()
    expect(within(section).getByText('64 B')).toBeInTheDocument()
    expect(within(section).getByText('logo.png')).toBeInTheDocument()
    expect(within(section).getByText('2.0 KB')).toBeInTheDocument()
    expect(api.listSkillFiles).toHaveBeenCalledWith({ registryId: REG, folderName: 'alpha' })
  })

  it('renders nested paths with visible directory indentation', async () => {
    const skills = [skill({ id: 'alpha', name: 'Alpha', description: 'First skill' })]
    const api = filesApi(skills, vi.fn().mockResolvedValue({ files: FILES }))
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Alpha'))
    const nested = await screen.findByText('scripts/run.sh')
    expect(nested.closest('li')?.style.paddingLeft).toBe('1.25rem')
    expect(screen.getByText('SKILL.md').closest('li')?.style.paddingLeft).toBe('0rem')
  })

  it('marks binary files as not viewable', async () => {
    const skills = [skill({ id: 'alpha', name: 'Alpha', description: 'First skill' })]
    const api = filesApi(skills, vi.fn().mockResolvedValue({ files: FILES }))
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Alpha'))
    const binary = await screen.findByText('logo.png')
    const row = binary.closest('li')!
    expect(within(row).getByText('not viewable')).toBeInTheDocument()
    expect(
      within(screen.getByText('SKILL.md').closest('li')!).queryByText('not viewable')
    ).toBeNull()
  })

  it('shows an explicit "Files unavailable" state for a missing listing', async () => {
    const skills = [skill({ id: 'ghost', name: 'Ghost', description: 'Gone skill' })]
    const api = filesApi(skills, vi.fn().mockResolvedValue({ files: [], unavailable: 'missing' }))
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Ghost'))
    const section = screen.getByRole('region', { name: 'Files' })
    expect(await within(section).findByText('Files unavailable')).toBeInTheDocument()
    expect(within(section).queryByRole('list')).toBeNull()
  })

  it('shows the current-mirror notice alongside the list for a stale entry', async () => {
    const skills = [skill({ id: 'alpha', name: 'Alpha', description: 'First skill', stale: true })]
    const api = filesApi(skills, vi.fn().mockResolvedValue({ files: FILES }))
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Alpha'))
    const section = screen.getByRole('region', { name: 'Files' })
    expect(await within(section).findByText('SKILL.md')).toBeInTheDocument()
    expect(
      within(section).getByText(
        'Files reflect the current mirror and may be newer than the catalogue entry.'
      )
    ).toBeInTheDocument()
  })

  it('shows the current-mirror notice for an installed-only entry', async () => {
    const skills = [
      skill({ id: 'alpha', name: 'Alpha', description: 'First skill', orphaned: true }),
    ]
    const api = filesApi(skills, vi.fn().mockResolvedValue({ files: FILES }))
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Alpha'))
    const section = screen.getByRole('region', { name: 'Files' })
    expect(await within(section).findByText('SKILL.md')).toBeInTheDocument()
    expect(
      within(section).getByText(
        'Files reflect the current mirror and may be newer than the catalogue entry.'
      )
    ).toBeInTheDocument()
  })

  it('clears and reloads the file list when the selected skill changes', async () => {
    const skills = [
      skill({ id: 'alpha', name: 'Alpha', description: 'First skill' }),
      skill({ id: 'beta', name: 'Beta', description: 'Second skill' }),
    ]
    const listSkillFiles = vi
      .fn()
      .mockResolvedValueOnce({ files: FILES })
      .mockResolvedValueOnce({
        files: [{ path: 'OTHER.md', sizeBytes: 10, viewable: true }],
      })
    const api = filesApi(skills, listSkillFiles)
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Alpha'))
    expect(await screen.findByText('SKILL.md')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Beta'))
    expect(await screen.findByText('OTHER.md')).toBeInTheDocument()
    expect(screen.queryByText('SKILL.md')).toBeNull()
    expect(listSkillFiles).toHaveBeenNthCalledWith(1, { registryId: REG, folderName: 'alpha' })
    expect(listSkillFiles).toHaveBeenNthCalledWith(2, { registryId: REG, folderName: 'beta' })
  })
})

describe('Skill file viewer', () => {
  const FILES = [
    { path: 'SKILL.md', sizeBytes: 512, viewable: true },
    { path: 'scripts/run.sh', sizeBytes: 64, viewable: true },
    { path: 'logo.png', sizeBytes: 2048, viewable: false },
  ]

  function viewerApi(readSkillFile: RendererApi['readSkillFile'], files = FILES): RendererApi {
    return fakeApi(
      syncStatus(),
      [skill({ id: 'alpha', name: 'Alpha', description: 'First skill' })],
      { listSkillFiles: vi.fn().mockResolvedValue({ files }), readSkillFile }
    )
  }

  async function openFile(path: string): Promise<void> {
    fireEvent.click(await screen.findByText('Alpha'))
    fireEvent.click(await screen.findByText(path))
  }

  it('clicking a file swaps the section into a viewer showing the file name and size', async () => {
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'SKILL.md',
      sizeBytes: 512,
      kind: 'text',
      content: '# Hello\n',
    })
    render(<App api={viewerApi(readSkillFile)} />)

    await openFile('SKILL.md')
    const section = screen.getByRole('region', { name: 'Files' })
    expect(await within(section).findByRole('heading', { name: 'Hello' })).toBeInTheDocument()
    expect(within(section).getByText('SKILL.md')).toBeInTheDocument()
    expect(within(section).getByText('512 B')).toBeInTheDocument()
    expect(within(section).queryByRole('list')).toBeNull()
    expect(readSkillFile).toHaveBeenCalledWith({
      registryId: REG,
      folderName: 'alpha',
      path: 'SKILL.md',
    })
  })

  it('renders markdown as sanitised HTML by default; a script in source never appears', async () => {
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'SKILL.md',
      sizeBytes: 512,
      kind: 'text',
      content: '# Title\n\nSome **bold** text.\n\n<script>alert(1)</script>\n',
    })
    const { container } = render(<App api={viewerApi(readSkillFile)} />)

    await openFile('SKILL.md')
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('.skill-file-markdown')?.innerHTML).not.toContain('<script>')
  })

  it('toggles between rendered markdown and raw source in a preformatted block', async () => {
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'SKILL.md',
      sizeBytes: 512,
      kind: 'text',
      content: '---\nname: alpha\n---\n\n# Title\n',
    })
    render(<App api={viewerApi(readSkillFile)} />)

    await openFile('SKILL.md')
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    const section = screen.getByRole('region', { name: 'Files' })
    const source = section.querySelector('pre.skill-file-source')
    expect(source).not.toBeNull()
    expect(source?.textContent).toContain('name: alpha')
    expect(within(section).queryByRole('heading', { name: 'Title' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Rendered' }))
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument()
  })

  it('shows non-markdown text files as plain preformatted source without a toggle', async () => {
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'scripts/run.sh',
      sizeBytes: 64,
      kind: 'text',
      content: '#!/bin/sh\necho hi\n',
    })
    render(<App api={viewerApi(readSkillFile)} />)

    await openFile('scripts/run.sh')
    const section = screen.getByRole('region', { name: 'Files' })
    const source = await within(section).findByText(/echo hi/)
    expect(source.closest('pre')).not.toBeNull()
    expect(within(section).queryByRole('button', { name: 'Raw' })).toBeNull()
  })

  it('shows a not viewable message for binary files instead of content', async () => {
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'logo.png',
      sizeBytes: 2048,
      kind: 'binary',
    })
    render(<App api={viewerApi(readSkillFile)} />)

    await openFile('logo.png')
    const section = screen.getByRole('region', { name: 'Files' })
    expect(await within(section).findByText('This file is not viewable.')).toBeInTheDocument()
    expect(section.querySelector('pre')).toBeNull()
  })

  it('shows the unavailable state for a missing content outcome', async () => {
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'SKILL.md',
      sizeBytes: 0,
      kind: 'missing',
    })
    render(<App api={viewerApi(readSkillFile)} />)

    await openFile('SKILL.md')
    const section = screen.getByRole('region', { name: 'Files' })
    expect(await within(section).findByText('Files unavailable')).toBeInTheDocument()
  })

  it('shows an explicit truncation indicator for truncated content', async () => {
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'SKILL.md',
      sizeBytes: 600000,
      kind: 'text',
      content: '# Big\n',
      truncated: true,
    })
    render(<App api={viewerApi(readSkillFile)} />)

    await openFile('SKILL.md')
    expect(await screen.findByText(/File truncated/)).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Big' })).toBeInTheDocument()
  })

  it('returns to the file list with the same skill still selected via the back control', async () => {
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'SKILL.md',
      sizeBytes: 512,
      kind: 'text',
      content: '# Hello\n',
    })
    render(<App api={viewerApi(readSkillFile)} />)

    await openFile('SKILL.md')
    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    const section = screen.getByRole('region', { name: 'Files' })
    expect(await within(section).findByRole('list')).toBeInTheDocument()
    expect(within(section).getByText('scripts/run.sh')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeInTheDocument()
  })
})

describe('Full-pane file preview', () => {
  const FILES = [{ path: 'SKILL.md', sizeBytes: 512, viewable: true }]

  async function openFile(skillName: string, path: string): Promise<void> {
    fireEvent.click(await screen.findByText(skillName))
    fireEvent.click(await screen.findByText(path))
  }

  it('keeps the hero header but hides the file list, On this Mac, and the stale/installed-only notices while a file is open', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        stale: true,
        orphaned: true,
      }),
    ]
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'SKILL.md',
      sizeBytes: 512,
      kind: 'text',
      content: '# Hello\n',
    })
    const api = fakeApi(syncStatus(), skills, {
      listSkillFiles: vi.fn().mockResolvedValue({ files: FILES }),
      readSkillFile,
    })
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Alpha'))
    expect(screen.getByRole('region', { name: 'On this Mac' })).toBeInTheDocument()
    expect(screen.getByText(/registry was removed/)).toBeInTheDocument()

    const detailBeforeOpen = screen.getByRole('region', { name: 'Skill detail' })
    expect(
      within(detailBeforeOpen).getByLabelText('Acknowledge stale snapshot')
    ).toBeInTheDocument()
    expect(within(detailBeforeOpen).getByLabelText('Skill identity')).toBeInTheDocument()
    expect(
      within(detailBeforeOpen).queryByRole('button', { name: /install|update/i })
    ).not.toBeInTheDocument()

    fireEvent.click(await screen.findByText('SKILL.md'))
    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeInTheDocument()

    const detail = screen.getByRole('region', { name: 'Skill detail' })
    expect(within(detail).getByRole('heading', { name: 'Alpha' })).toBeInTheDocument()
    expect(within(detail).getByText('First skill')).toBeInTheDocument()
    expect(within(detail).queryByRole('region', { name: 'On this Mac' })).not.toBeInTheDocument()
    expect(within(detail).queryByText(/registry was removed/)).not.toBeInTheDocument()
    expect(within(detail).queryByLabelText('Acknowledge stale snapshot')).not.toBeInTheDocument()
    expect(within(detail).getByLabelText('Skill identity')).toBeInTheDocument()
    expect(
      within(detail).queryByRole('button', { name: /install|update/i })
    ).not.toBeInTheDocument()
    const section = screen.getByRole('region', { name: 'Files' })
    expect(within(section).queryByRole('list')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(await screen.findByRole('region', { name: 'On this Mac' })).toBeInTheDocument()
    expect(screen.getByText(/registry was removed/)).toBeInTheDocument()
  })

  it('hides the install-result notice while a file is open and restores it on back', async () => {
    const skills = [
      skill({
        id: 'alpha',
        name: 'Alpha',
        description: 'First skill',
        perTarget: [{ target: '~/.claude/skills', state: 'not-installed' }],
      }),
    ]
    const install = vi.fn().mockResolvedValue({
      registryId: REG,
      folderName: 'alpha',
      skillId: `${REG}/alpha`,
      mirrorRevision: 'deadbeef',
      contentHash: 'hash',
      provenanceSha: 'deadbeef',
      cliVersion: '1.5.15',
      perTarget: [
        { target: '~/.claude/skills', outcome: 'installed', method: 'symlink', paths: [] },
      ],
      installedAt: new Date().toISOString(),
    })
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'SKILL.md',
      sizeBytes: 512,
      kind: 'text',
      content: '# Hello\n',
    })
    const api = fakeApi(
      syncStatus({ lastSyncedAt: new Date().toISOString(), registries: [reg()] }),
      skills,
      {
        install,
        detectTargets: vi.fn().mockResolvedValue(detection([CLAUDE_CODE_TARGET])),
        listSkillFiles: vi.fn().mockResolvedValue({ files: FILES }),
        readSkillFile,
      }
    )
    render(<App api={api} />)

    fireEvent.click(await screen.findByText('Alpha'))
    await act(async () => {
      screen.getByRole('button', { name: 'Install to all' }).click()
    })
    expect(await screen.findByRole('list', { name: 'Install results' })).toBeInTheDocument()

    const detailBeforeOpen = screen.getByRole('region', { name: 'Skill detail' })
    const installButtonBeforeOpen = detailBeforeOpen.querySelector('.install-primary')
    expect(installButtonBeforeOpen).not.toBeNull()
    const installLabelBeforeOpen = installButtonBeforeOpen?.textContent
    const installDisabledBeforeOpen = installButtonBeforeOpen?.hasAttribute('disabled')

    fireEvent.click(screen.getByText('SKILL.md'))
    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Install results' })).not.toBeInTheDocument()

    const detail = screen.getByRole('region', { name: 'Skill detail' })
    const installButtonWhileOpen = detail.querySelector('.install-primary')
    expect(installButtonWhileOpen).not.toBeNull()
    expect(installButtonWhileOpen?.textContent).toBe(installLabelBeforeOpen)
    expect(installButtonWhileOpen?.hasAttribute('disabled')).toBe(installDisabledBeforeOpen)

    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(await screen.findByRole('list', { name: 'Install results' })).toBeInTheDocument()
  })

  it('returns to the full detail view for the newly selected skill when switching while a file is open', async () => {
    const skills = [
      skill({ id: 'alpha', name: 'Alpha', description: 'First skill' }),
      skill({ id: 'beta', name: 'Beta', description: 'Second skill' }),
    ]
    const listSkillFiles = vi
      .fn()
      .mockResolvedValueOnce({ files: FILES })
      .mockResolvedValueOnce({
        files: [{ path: 'OTHER.md', sizeBytes: 10, viewable: true }],
      })
    const readSkillFile = vi.fn().mockResolvedValue({
      path: 'SKILL.md',
      sizeBytes: 512,
      kind: 'text',
      content: '# Hello\n',
    })
    const api = fakeApi(syncStatus(), skills, { listSkillFiles, readSkillFile })
    render(<App api={api} />)

    await openFile('Alpha', 'SKILL.md')
    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeInTheDocument()

    fireEvent.click(screen.getByText('Beta'))
    expect(await screen.findByRole('heading', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Hello' })).not.toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'On this Mac' })).toBeInTheDocument()
    const section = screen.getByRole('region', { name: 'Files' })
    expect(await within(section).findByText('OTHER.md')).toBeInTheDocument()
  })
})

describe('Auto update notices', () => {
  function renderWithAutoUpdates(): (result: AutoUpdateResult) => void {
    let receive: (result: AutoUpdateResult) => void = () => {}
    render(
      <App
        api={fakeApi(syncStatus(), [], {
          onAutoUpdateResult: vi.fn((cb) => {
            receive = cb
            return () => {}
          }),
        })}
      />
    )
    return (result) => act(() => receive(result))
  }

  it('shows the Registry, updated skill count and failure reasons above the Catalogue rows', async () => {
    const receive = renderWithAutoUpdates()
    await screen.findByText('Synced')
    receive({
      registryId: 'r1',
      registryLabel: 'owner/skills',
      updated: [
        { folderName: 'alpha', name: 'Alpha', targets: ['~/.claude/skills', '~/.agents/skills'] },
        { folderName: 'beta', name: 'Beta', targets: ['~/.agents/skills'] },
      ],
      failed: [{ folderName: 'gamma', name: 'Gamma', reason: 'Permission denied' }],
    })
    const notice = screen.getByRole('region', { name: 'Auto update from owner/skills' })
    expect(within(notice).getByText('Auto-updated 2 skills from owner/skills')).toBeInTheDocument()
    expect(within(notice).getByText('Gamma: Permission denied')).toBeInTheDocument()
    const catalogue = screen.getByRole('region', { name: 'Catalogue' })
    expect(
      notice.compareDocumentPosition(catalogue) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('shows a failure-only notice and removes it when Dismiss is clicked', async () => {
    const receive = renderWithAutoUpdates()
    await screen.findByText('Synced')
    receive({
      registryId: 'r1',
      registryLabel: 'owner/skills',
      updated: [],
      failed: [{ folderName: 'alpha', name: 'Alpha', reason: 'Disk full' }],
    })
    const notice = screen.getByRole('region', { name: 'Auto update from owner/skills' })
    expect(within(notice).getByText('Auto-updated 0 skills from owner/skills')).toBeInTheDocument()
    expect(within(notice).getByText('Alpha: Disk full')).toBeInTheDocument()
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }))
    expect(
      screen.queryByRole('region', { name: 'Auto update from owner/skills' })
    ).not.toBeInTheDocument()
  })

  it('keeps runs from different Registries newest first and dismisses only the chosen notice', async () => {
    const receive = renderWithAutoUpdates()
    await screen.findByText('Synced')
    receive({
      registryId: 'r1',
      registryLabel: 'owner/first',
      failed: [],
      updated: [{ folderName: 'alpha', name: 'Alpha', targets: ['~/.agents/skills'] }],
    })
    receive({
      registryId: 'r2',
      registryLabel: 'owner/second',
      failed: [],
      updated: [{ folderName: 'beta', name: 'Beta', targets: ['~/.claude/skills'] }],
    })
    const notices = screen.getAllByRole('region', { name: /^Auto update from/ })
    expect(notices).toHaveLength(2)
    expect(
      within(notices[0]).getByText('Auto-updated 1 skill from owner/second')
    ).toBeInTheDocument()
    expect(
      within(notices[1]).getByText('Auto-updated 1 skill from owner/first')
    ).toBeInTheDocument()
    fireEvent.click(within(notices[0]).getByRole('button', { name: 'Dismiss' }))
    expect(
      screen.queryByRole('region', { name: 'Auto update from owner/second' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Auto update from owner/first' })).toBeInTheDocument()
  })

  it('keeps repeated runs from the same Registry as separate notices', async () => {
    const receive = renderWithAutoUpdates()
    await screen.findByText('Synced')
    const result: AutoUpdateResult = {
      registryId: 'r1',
      registryLabel: 'owner/skills',
      failed: [],
      updated: [{ folderName: 'alpha', name: 'Alpha', targets: ['~/.agents/skills'] }],
    }
    receive(result)
    receive(result)
    const notices = screen.getAllByRole('region', { name: 'Auto update from owner/skills' })
    expect(notices).toHaveLength(2)
    fireEvent.click(within(notices[1]).getByRole('button', { name: 'Dismiss' }))
    expect(screen.getAllByRole('region', { name: 'Auto update from owner/skills' })).toHaveLength(1)
  })

  it('unsubscribes when the renderer closes and starts with no notices on remount', async () => {
    let receive: (result: AutoUpdateResult) => void = () => {}
    const unsubscribe = vi.fn()
    const api = fakeApi(syncStatus(), [], {
      onAutoUpdateResult: vi.fn((cb) => {
        receive = cb
        return unsubscribe
      }),
    })
    const first = render(<App api={api} />)
    await screen.findByText('Synced')
    act(() =>
      receive({
        registryId: 'r1',
        registryLabel: 'owner/skills',
        failed: [],
        updated: [{ folderName: 'alpha', name: 'Alpha', targets: ['~/.agents/skills'] }],
      })
    )
    expect(screen.getByText('Auto-updated 1 skill from owner/skills')).toBeInTheDocument()
    first.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
    render(<App api={api} />)
    await screen.findByText('Synced')
    expect(screen.queryByRole('region', { name: /^Auto update from/ })).not.toBeInTheDocument()
  })
})
describe('App Update banner', () => {
  it('offers restart when a release is ready', () => {
    const restart = vi.fn()
    render(<AppUpdateBanner state={ready()} onRestart={restart} onDownload={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Version 0.0.7 is ready — Restart to update'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(restart).toHaveBeenCalledOnce()
  })
  it('shows download progress', () => {
    render(
      <AppUpdateBanner
        state={{ kind: 'downloading', currentVersion: '0.0.6', version: '0.0.7', percent: 42 }}
        onRestart={vi.fn()}
        onDownload={vi.fn()}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Downloading version 0.0.7: 42%')
    expect(screen.getByRole('progressbar', { name: 'App Update download' })).toHaveAttribute(
      'value',
      '42'
    )
  })
  it('shows nothing while idle', () => {
    const { container } = render(
      <AppUpdateBanner
        state={{ kind: 'idle', currentVersion: '0.0.6' }}
        onRestart={vi.fn()}
        onDownload={vi.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
  it('offers Download for an available update and Retry for a failed download', () => {
    const download = vi.fn()
    const { rerender } = render(
      <AppUpdateBanner
        state={{ kind: 'available', currentVersion: '0.0.6', version: '0.0.7' }}
        onRestart={vi.fn()}
        onDownload={download}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(download).toHaveBeenCalledOnce()
    rerender(
      <AppUpdateBanner
        state={{
          kind: 'download-failed',
          currentVersion: '0.0.6',
          version: '0.0.7',
          message: 'Offline',
        }}
        onRestart={vi.fn()}
        onDownload={download}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Offline')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(download).toHaveBeenCalledTimes(2)
  })
  it('receives App Update state independently of registry Auto Update and calls restart', async () => {
    const api = fakeApi(syncStatus())
    const callbacks = captureAppUpdateState(api)
    await act(async () => {
      render(<App api={api} />)
    })
    act(() => callbacks[0](ready()))
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(api.restartForAppUpdate).toHaveBeenCalledOnce()
    expect(screen.getByRole('region', { name: 'App Update' })).toBeInTheDocument()
  })
})

describe('Settings App Update', () => {
  it('shows the running version and checks for updates', async () => {
    const api = fakeApi(syncStatus())
    render(<App api={api} />)
    await openSettings()
    const section = screen.getByRole('region', { name: 'App Update settings' })
    expect(within(section).getByText('Current version: 0.0.6')).toBeInTheDocument()
    await act(async () => {
      within(section).getByRole('button', { name: 'Check for updates' }).click()
    })
    expect(api.checkAppUpdate).toHaveBeenCalledOnce()
  })
})

describe('Settings App Update availability', () => {
  it.each([
    { kind: 'downloading', currentVersion: '0.0.6', version: '0.0.7', percent: 10 },
    ready(),
  ] as const)('disables the manual check while a release is %#', async (state) => {
    const api = fakeApi(syncStatus(), [], {
      getAppUpdateState: vi.fn().mockResolvedValue(state),
    })
    render(<App api={api} />)
    await openSettings()
    const section = screen.getByRole('region', { name: 'App Update settings' })
    expect(await within(section).findByRole('button', { name: 'Check for updates' })).toBeDisabled()
  })

  it('allows a manual check while a release waits to be downloaded', async () => {
    const api = fakeApi(syncStatus(), [], {
      getAppUpdateState: vi
        .fn()
        .mockResolvedValue({ kind: 'available', currentVersion: '0.0.6', version: '0.0.7' }),
    })
    render(<App api={api} />)
    await screen.findByRole('button', { name: 'Download' })
    await openSettings()
    const section = screen.getByRole('region', { name: 'App Update settings' })
    expect(within(section).getByRole('button', { name: 'Check for updates' })).toBeEnabled()
  })
})

describe('Settings App Update results', () => {
  it('shows a manual check result beside its button', async () => {
    let publish: ((state: import('../../shared/ipc').AppUpdateState) => void) | undefined
    const api = fakeApi(syncStatus(), [], {
      onAppUpdateState: vi.fn((callback) => {
        publish = callback
        return () => {}
      }),
    })
    render(<App api={api} />)
    await openSettings()
    await act(async () => {
      publish?.({
        kind: 'idle',
        currentVersion: '0.0.6',
        lastCheck: { at: '2026-10-06', result: 'up-to-date' },
      })
    })
    expect(
      within(screen.getByRole('region', { name: 'App Update settings' })).getByRole('status')
    ).toHaveTextContent('You’re up to date')
  })
})

describe('Settings App Update errors', () => {
  it('shows a manual check error next to the button', async () => {
    const api = fakeApi(syncStatus(), [], {
      getAppUpdateState: vi.fn().mockResolvedValue({
        kind: 'idle',
        currentVersion: '0.0.6',
        lastCheck: { at: '2026-10-06', result: 'error', message: 'Offline' },
      }),
    })
    render(<App api={api} />)
    await openSettings()
    expect(
      within(screen.getByRole('region', { name: 'App Update settings' })).getByRole('status')
    ).toHaveTextContent('Offline')
  })
  it('remembers the automatic download preference when Settings reopens', async () => {
    const api = fakeApi(syncStatus())
    vi.mocked(api.setAutoDownloadAppUpdates).mockImplementation(async (enabled) => {
      vi.mocked(api.getAutoDownloadAppUpdates).mockResolvedValue(enabled)
    })
    render(<App api={api} />)
    await openSettings()
    const toggle = await screen.findByRole('switch', { name: 'Download app updates automatically' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await act(async () => {
      toggle.click()
    })
    expect(api.setAutoDownloadAppUpdates).toHaveBeenCalledWith(false)
    await act(async () => {
      screen.getByRole('button', { name: 'Catalogue 0' }).click()
    })
    await openSettings()
    expect(
      await screen.findByRole('switch', { name: 'Download app updates automatically' })
    ).toHaveAttribute('aria-checked', 'false')
  })
})

describe('App Update manual download', () => {
  it('downloads an available release when its banner action is clicked', async () => {
    const api = fakeApi(syncStatus(), [], {
      getAppUpdateState: vi
        .fn()
        .mockResolvedValue({ kind: 'available', currentVersion: '0.0.6', version: '0.0.7' }),
    })
    render(<App api={api} />)
    const button = await screen.findByRole('button', { name: 'Download' })
    fireEvent.click(button)
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce()
  })
})

describe('App Update busy guard', () => {
  it('waits for the App Update restart guard to clear before offering restart', async () => {
    const api = fakeApi(syncStatus())
    const callbacks = captureAppUpdateState(api)
    await act(async () => {
      render(<App api={api} />)
    })
    act(() => callbacks[0](ready({ waiting: true })))
    const waiting = screen.getByRole('button', { name: 'Finishing current task…' })
    expect(waiting).toBeDisabled()
    fireEvent.click(waiting)
    expect(api.restartForAppUpdate).not.toHaveBeenCalled()
    act(() => callbacks[0](ready()))
    const restart = screen.getByRole('button', { name: 'Restart to update' })
    expect(restart).toBeEnabled()
    fireEvent.click(restart)
    expect(api.restartForAppUpdate).toHaveBeenCalledOnce()
  })

  it('waits for a sync to finish before offering restart', async () => {
    let receive: (status: SyncStatus) => void = () => {}
    const api = fakeApi(syncStatus({ phase: 'syncing' }), [], {
      getAppUpdateState: vi.fn().mockResolvedValue(ready()),
      onSyncStatus: vi.fn((callback) => {
        receive = callback
        return () => {}
      }),
    })
    render(<App api={api} />)
    const waiting = await screen.findByRole('button', { name: 'Finishing current task…' })
    expect(waiting).toBeDisabled()
    act(() => receive(syncStatus()))
    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeEnabled()
  })
})

it('keeps catalogue controls available while only the App Update restart waits', async () => {
  const api = fakeApi(syncStatus(), [], {
    getAppUpdateState: vi.fn().mockResolvedValue(ready({ waiting: true })),
  })
  render(<App api={api} />)
  expect(await screen.findByRole('button', { name: 'Finishing current task…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Refresh catalogue' })).toBeEnabled()
})

it('waits for registry addition to finish before allowing App Update restart', async () => {
  let complete!: (registry: RegistryRecord) => void
  const api = fakeApi(syncStatus(), [], {
    getAppUpdateState: vi.fn().mockResolvedValue(ready()),
    addRegistry: vi.fn(
      () =>
        new Promise<RegistryRecord>((resolve) => {
          complete = resolve
        })
    ),
  })
  render(<App api={api} />)
  await screen.findByRole('button', { name: 'Restart to update' })
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  fireEvent.change(screen.getByLabelText('New registry URL'), {
    target: { value: 'https://github.com/example/skills' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add registry' }))
  expect(screen.getByRole('button', { name: 'Finishing current task…' })).toBeDisabled()
  await act(async () => complete(DEFAULT_REGISTRY_RECORD))
  expect(screen.getByRole('button', { name: 'Restart to update' })).toBeEnabled()
})

it('waits for a skill install to finish before allowing App Update restart', async () => {
  let complete!: (result: InstallResult) => void
  const api = fakeApi(
    syncStatus({ registries: [reg()] }),
    [skill({ id: 'alpha', name: 'Alpha', description: 'First skill' })],
    {
      getAppUpdateState: vi.fn().mockResolvedValue(ready()),
      install: vi.fn(
        () =>
          new Promise<InstallResult>((resolve) => {
            complete = resolve
          })
      ),
    }
  )
  render(<App api={api} />)
  fireEvent.click(await screen.findByText('Alpha'))
  fireEvent.click(screen.getByRole('button', { name: 'Install to all' }))
  expect(screen.getByRole('button', { name: 'Finishing current task…' })).toBeDisabled()
  await act(async () =>
    complete({
      registryId: REG,
      folderName: 'alpha',
      skillId: `${REG}/alpha`,
      mirrorRevision: 'deadbeef',
      contentHash: 'hash',
      provenanceSha: 'deadbeef',
      cliVersion: '1.5.15',
      perTarget: [],
      installedAt: '2026-10-07T00:00:00.000Z',
    })
  )
  expect(screen.getByRole('button', { name: 'Restart to update' })).toBeEnabled()
})

describe('Catalogue multi-selection', () => {
  const FIVE = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((name) =>
    skill({ id: name.toLowerCase(), name, description: `${name} skill` })
  )
  const BEHIND = skill({
    id: 'zeta',
    name: 'Zeta',
    description: 'Behind',
    perTarget: [{ target: '~/.claude/skills', state: 'update-available', installedVersion: 'z1' }],
  })

  function row(name: string): HTMLElement {
    const match = screen
      .getAllByRole('option')
      .find((option) => within(option).queryByText(name, { selector: '.skill-name' }))
    if (!match) throw new Error(`No row for ${name}`)
    return match
  }

  function selectionCount(): HTMLElement {
    return within(screen.getByRole('region', { name: 'Selection' })).getByRole('status')
  }

  async function renderList(skills: SkillSummary[] = FIVE, overrides: Partial<RendererApi> = {}) {
    const api = fakeApi(syncStatus({ registries: [reg()] }), skills, overrides)
    render(<App api={api} />)
    await screen.findByText('Alpha')
    return api
  }

  it('declares a multi-selectable list and shows no bar for zero or one selected', async () => {
    await renderList()
    expect(screen.getByRole('listbox', { name: 'Skills' })).toHaveAttribute(
      'aria-multiselectable',
      'true'
    )
    fireEvent.click(row('Alpha'), { metaKey: true })
    expect(row('Alpha')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument()
  })

  it('⌘-click takes the open skill in first, shows the bar with the count, and hides Update all', async () => {
    await renderList([...FIVE, BEHIND])
    expect(screen.getByRole('region', { name: 'Update all' })).toBeInTheDocument()
    fireEvent.click(row('Alpha'))
    expect(await screen.findByRole('region', { name: 'Skill detail' })).toBeInTheDocument()
    fireEvent.click(row('Gamma'), { metaKey: true })

    const bar = screen.getByRole('region', { name: 'Selection' })
    expect(within(bar).getByRole('status')).toHaveTextContent('2 selected')
    expect(row('Alpha')).toHaveAttribute('aria-selected', 'true')
    expect(row('Gamma')).toHaveAttribute('aria-selected', 'true')
    expect(row('Beta')).toHaveAttribute('aria-selected', 'false')
    expect(screen.queryByRole('region', { name: 'Update all' })).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Skill detail' })).getByRole('heading', {
        name: 'Gamma',
      })
    ).toBeInTheDocument()
  })

  it('⇧-click selects a range and ⌘⇧-click adds another', async () => {
    await renderList()
    fireEvent.click(row('Alpha'))
    fireEvent.click(row('Gamma'), { shiftKey: true })
    expect(selectionCount()).toHaveTextContent('3 selected')
    fireEvent.click(row('Epsilon'), { metaKey: true })
    fireEvent.click(row('Delta'), { metaKey: true, shiftKey: true })
    expect(selectionCount()).toHaveTextContent('5 selected')
  })

  it('Clear, Esc, a plain click and a view change each clear the selection', async () => {
    await renderList([...FIVE, BEHIND])
    const select = (): void => {
      fireEvent.click(row('Alpha'))
      fireEvent.click(row('Beta'), { shiftKey: true })
      expect(screen.getByRole('region', { name: 'Selection' })).toBeInTheDocument()
    }

    select()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Update all' })).toBeInTheDocument()

    select()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument()

    select()
    fireEvent.click(row('Gamma'))
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument()

    select()
    fireEvent.click(viewButton('Installed'))
    fireEvent.click(viewButton('Catalogue'))
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument()

    select()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: 'a' },
    })
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument()
  })

  it('a catalogue reload keeps listed skills and drops vanished ones', async () => {
    let push: (() => void) | undefined
    let current = FIVE
    await renderList(FIVE, {
      getCatalogue: vi.fn(() =>
        Promise.resolve({ skills: current, syncStatus: syncStatus({ registries: [reg()] }) })
      ),
      onCatalogueUpdated: vi.fn((cb: () => void) => {
        push = cb
        return () => {}
      }),
    })
    fireEvent.click(row('Alpha'))
    fireEvent.click(row('Gamma'), { shiftKey: true })
    expect(selectionCount()).toHaveTextContent('3 selected')

    current = FIVE.filter((s) => s.id !== 'beta')
    await act(async () => {
      push?.()
    })
    await vi.waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument())
    expect(selectionCount()).toHaveTextContent('2 selected')
  })

  it('ignores ⌘ and ⇧ clicks while an Update all run is in flight', async () => {
    const refresh = deferred<SyncAllResult>()
    await renderList([...FIVE, BEHIND], { refresh: vi.fn().mockReturnValue(refresh.promise) })
    fireEvent.click(screen.getByRole('button', { name: 'Update all (1)' }))
    expect(await screen.findByText('Checking for updates…')).toBeInTheDocument()
    fireEvent.click(row('Alpha'), { metaKey: true })
    fireEvent.click(row('Gamma'), { shiftKey: true })
    expect(row('Alpha')).toHaveAttribute('aria-selected', 'false')
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument()
    await act(async () => {
      refresh.resolve({ registries: [reg()] })
      await refresh.promise
    })
  })

  describe('installing the selection', () => {
    const BOTH: SkillSummary['perTarget'] = [
      { target: '~/.claude/skills', state: 'not-installed' },
      { target: '~/.agents/skills', state: 'not-installed' },
    ]
    const INSTALLABLE = [
      skill({ id: 'alpha', name: 'Alpha', description: 'a', perTarget: BOTH }),
      skill({
        id: 'beta',
        name: 'Beta',
        description: 'b',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed' },
          { target: '~/.agents/skills', state: 'not-installed' },
        ],
      }),
      skill({
        id: 'gamma',
        name: 'Gamma',
        description: 'c',
        perTarget: [
          { target: '~/.claude/skills', state: 'installed' },
          { target: '~/.agents/skills', state: 'installed' },
        ],
      }),
      skill({ id: 'delta', name: 'Delta', description: 'd', perTarget: BOTH }),
    ]

    function bar(): HTMLElement {
      return screen.getByRole('region', { name: 'Selection' })
    }

    function selectAlphaToGamma(): void {
      fireEvent.click(row('Alpha'))
      fireEvent.click(row('Gamma'), { shiftKey: true })
    }

    it('counts what will install and what is skipped, and chips change the requested targets', async () => {
      const install = vi.fn().mockResolvedValue({})
      const api = await renderList(INSTALLABLE, {
        install,
        repair: vi.fn(),
        refresh: vi.fn().mockResolvedValue({ registries: [] }),
      })
      selectAlphaToGamma()
      expect(selectionCount()).toHaveTextContent('3 selected · 1 already installed')
      expect(within(bar()).getByRole('button', { name: 'Install (2)' })).toBeEnabled()

      fireEvent.click(within(bar()).getByRole('checkbox', { name: 'Cursor' }))
      expect(selectionCount()).toHaveTextContent('3 selected · 2 already installed')
      await act(async () => {
        within(bar()).getByRole('button', { name: 'Install (1)' }).click()
      })

      expect(install.mock.calls.map(([req]) => req)).toEqual([
        {
          registryId: REG,
          folderName: 'alpha',
          targets: ['~/.claude/skills'],
          mirrorRevision: 'deadbeef',
        },
      ])
      expect(api.repair).not.toHaveBeenCalled()
      expect(api.refresh).not.toHaveBeenCalled()
    })

    it('disables Install with no chip on', async () => {
      await renderList(INSTALLABLE)
      selectAlphaToGamma()
      fireEvent.click(within(bar()).getByRole('checkbox', { name: 'Claude Code' }))
      fireEvent.click(within(bar()).getByRole('checkbox', { name: 'Cursor' }))
      expect(within(bar()).getByRole('button', { name: 'Install (0)' })).toBeDisabled()
    })

    it('runs one skill at a time with progress, then shows the summary and clears the selection', async () => {
      const first = deferred<InstallResult>()
      const install = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockRejectedValueOnce(new Error('Already exists'))
      await renderList(INSTALLABLE, { install })
      fireEvent.click(row('Alpha'))
      fireEvent.click(row('Delta'), { shiftKey: true })
      fireEvent.click(within(bar()).getByRole('button', { name: 'Install (3)' }))

      expect(await within(bar()).findByText('Installing Alpha — 1 of 3')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Refresh catalogue' })).toBeDisabled()
      await act(async () => {
        first.resolve({} as InstallResult)
        await first.promise
      })

      expect(
        await within(bar()).findByText('2 installed · 1 failed · 0 held back')
      ).toBeInTheDocument()
      expect(within(bar()).getByText('Beta: Already exists')).toBeInTheDocument()
      expect(install.mock.calls.map(([req]) => req.folderName)).toEqual(['alpha', 'beta', 'delta'])
      expect(row('Alpha')).toHaveAttribute('aria-selected', 'false')

      fireEvent.click(within(bar()).getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument()
    })

    it('names the stale Registry and its last sync for held-back skills in the summary', async () => {
      const lastSynced = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      const staleReg: RegistrySyncStatus = {
        registryId: 'reg-stale',
        phase: 'failed',
        stale: true,
        lastSyncedAt: lastSynced,
        revision: 'cafebabe',
        reason: 'offline',
      }
      const skills = [
        skill({ id: 'alpha', name: 'Alpha', description: 'a', perTarget: BOTH }),
        skill({
          id: 'gamma',
          registryId: 'reg-stale',
          registryLabel: 'example-org/skills',
          name: 'Gamma',
          description: 'c',
          stale: true,
          perTarget: BOTH,
        }),
      ]
      const api = fakeApi(syncStatus({ registries: [reg(), staleReg] }), skills, {
        install: vi.fn().mockResolvedValue({}),
      })
      render(<App api={api} />)
      await screen.findByText('Alpha')
      fireEvent.click(row('Alpha'))
      fireEvent.click(row('Gamma'), { shiftKey: true })
      await act(async () => {
        within(bar()).getByRole('button', { name: 'Install (1)' }).click()
      })

      expect(
        await within(bar()).findByText(
          'Gamma: held back — stale Registry snapshot (example-org/skills, last synced 3h ago)'
        )
      ).toBeInTheDocument()
    })

    it('a reload that marks a selected skill installed lowers the count', async () => {
      let push: (() => void) | undefined
      let current = INSTALLABLE
      await renderList(INSTALLABLE, {
        getCatalogue: vi.fn(() =>
          Promise.resolve({ skills: current, syncStatus: syncStatus({ registries: [reg()] }) })
        ),
        onCatalogueUpdated: vi.fn((cb: () => void) => {
          push = cb
          return () => {}
        }),
      })
      selectAlphaToGamma()
      expect(within(bar()).getByRole('button', { name: 'Install (2)' })).toBeInTheDocument()

      current = INSTALLABLE.map((s) =>
        s.id === 'alpha'
          ? { ...s, perTarget: BOTH.map((p) => ({ ...p, state: 'installed' as const })) }
          : s
      )
      await act(async () => {
        push?.()
      })
      expect(await within(bar()).findByRole('button', { name: 'Install (1)' })).toBeInTheDocument()
      expect(selectionCount()).toHaveTextContent('3 selected · 2 already installed')
    })
  })
})
