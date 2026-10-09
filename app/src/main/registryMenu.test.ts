import { describe, expect, it, vi } from 'vitest'
import type { RegistryRecord } from '../shared/ipc'
import { createRegistryMenu, registryMenuTemplate } from './registryMenu'

function record(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    id: 'team',
    url: 'https://github.com/team/skills',
    branch: 'main',
    enabled: true,
    autoUpdate: true,
    githubOwner: 'team',
    githubRepo: 'skills',
    colour: null,
    syncStatus: { registryId: 'team', phase: 'synced', lastSyncedAt: null },
    ...overrides,
  }
}

function summary(items: ReturnType<typeof registryMenuTemplate>) {
  return items.map((item) =>
    item.type === 'separator' ? '---' : [item.label, item.action, item.enabled, item.checked]
  )
}

describe('registry menu template', () => {
  it('lists every item in order for an enabled GitHub registry', () => {
    expect(summary(registryMenuTemplate(record(), false))).toEqual([
      ['Sync Now', 'sync', true, undefined],
      '---',
      ['Enabled', 'toggle-enabled', true, true],
      ['Auto Update', 'toggle-auto-update', true, true],
      '---',
      ['Open on GitHub', 'open-github', true, undefined],
      ['Copy URL', 'copy-url', true, undefined],
      ['Show in Settings', 'show-settings', true, undefined],
      '---',
      ['Remove…', 'remove', true, undefined],
    ])
  })

  it('leaves out Open on GitHub for a non-GitHub registry', () => {
    const items = registryMenuTemplate(
      record({ url: 'https://git.example.com/x/y', githubOwner: null, githubRepo: null }),
      false
    )
    expect(summary(items).map((item) => item[0])).toEqual([
      'Sync Now',
      '-',
      'Enabled',
      'Auto Update',
      '-',
      'Copy URL',
      'Show in Settings',
      '-',
      'Remove…',
    ])
  })

  it('disables Sync Now and Auto Update and unchecks Enabled for a disabled registry', () => {
    expect(
      summary(registryMenuTemplate(record({ enabled: false, autoUpdate: false }), false))
    ).toEqual([
      ['Sync Now', 'sync', false, undefined],
      '---',
      ['Enabled', 'toggle-enabled', true, false],
      ['Auto Update', 'toggle-auto-update', false, false],
      '---',
      ['Open on GitHub', 'open-github', true, undefined],
      ['Copy URL', 'copy-url', true, undefined],
      ['Show in Settings', 'show-settings', true, undefined],
      '---',
      ['Remove…', 'remove', true, undefined],
    ])
  })

  it('disables the changing items while busy and keeps the read-only ones enabled', () => {
    expect(summary(registryMenuTemplate(record(), true))).toEqual([
      ['Sync Now', 'sync', false, undefined],
      '---',
      ['Enabled', 'toggle-enabled', false, true],
      ['Auto Update', 'toggle-auto-update', false, true],
      '---',
      ['Open on GitHub', 'open-github', true, undefined],
      ['Copy URL', 'copy-url', true, undefined],
      ['Show in Settings', 'show-settings', true, undefined],
      '---',
      ['Remove…', 'remove', false, undefined],
    ])
  })
})

interface FakeItem {
  label?: string
  click?: () => void
}

function setup(registry: RegistryRecord = record()) {
  let shown: { items: FakeItem[]; options: { x?: number; y?: number; callback?: () => void } }
  const Menu = {
    buildFromTemplate: vi.fn((items: FakeItem[]) => ({
      popup: (options: { x?: number; y?: number; callback?: () => void }) => {
        shown = { items, options }
      },
    })),
  }
  const clipboard = { writeText: vi.fn() }
  const shell = { openExternal: vi.fn().mockResolvedValue(undefined) }
  const menu = createRegistryMenu({
    Menu: Menu as never,
    clipboard,
    shell,
    listRegistries: async () => [registry],
  })
  const window = {} as never
  return {
    clipboard,
    shell,
    open: (position?: { x: number; y: number }) =>
      menu.show(window, { registryId: registry.id, busy: false, position }),
    choose: (label: string) => {
      shown.items.find((item) => item.label === label)!.click!()
      shown.options.callback?.()
    },
    dismiss: () => shown.options.callback?.(),
    options: () => shown.options,
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('registry menu', () => {
  it('copies the registry URL and resolves null', async () => {
    const menu = setup()
    const result = menu.open()
    await flush()
    menu.choose('Copy URL')
    expect(await result).toBeNull()
    expect(menu.clipboard.writeText).toHaveBeenCalledWith('https://github.com/team/skills')
  })

  it('opens the GitHub repository built from the stored owner and repo', async () => {
    const menu = setup(record({ url: 'https://github.com/team/skills.git' }))
    const result = menu.open()
    await flush()
    menu.choose('Open on GitHub')
    expect(await result).toBeNull()
    expect(menu.shell.openExternal).toHaveBeenCalledWith('https://github.com/team/skills')
  })

  it('resolves the renderer action that was chosen', async () => {
    const menu = setup()
    const result = menu.open()
    await flush()
    menu.choose('Show in Settings')
    expect(await result).toBe('show-settings')
  })

  it('resolves null when the menu is dismissed', async () => {
    const menu = setup()
    const result = menu.open({ x: 12.4, y: 30.6 })
    await flush()
    expect(menu.options()).toMatchObject({ x: 12, y: 31 })
    menu.dismiss()
    expect(await result).toBeNull()
  })
})
