import type { BrowserWindow, IpcMain, MenuItemConstructorOptions } from 'electron'
import {
  IpcRequest,
  type RegistryMenuAction,
  type RegistryMenuRequest,
  type RegistryRecord,
} from '../shared/ipc'

/** Every action the registry menu offers, including those main handles itself. */
export type RegistryMenuItemAction = RegistryMenuAction | 'open-github' | 'copy-url'

export type RegistryMenuItem =
  | { type: 'separator' }
  | {
      type: 'normal' | 'checkbox'
      label: string
      action: RegistryMenuItemAction
      enabled: boolean
      checked?: boolean
    }

const SEPARATOR: RegistryMenuItem = { type: 'separator' }

/** Build the sidebar registry menu items from the registry and the busy flag. */
export function registryMenuTemplate(registry: RegistryRecord, busy: boolean): RegistryMenuItem[] {
  const isGitHub = registry.githubOwner !== null && registry.githubRepo !== null
  return [
    { type: 'normal', label: 'Rename…', action: 'rename', enabled: !busy },
    SEPARATOR,
    { type: 'normal', label: 'Sync Now', action: 'sync', enabled: !busy && registry.enabled },
    SEPARATOR,
    {
      type: 'checkbox',
      label: 'Enabled',
      action: 'toggle-enabled',
      enabled: !busy,
      checked: registry.enabled,
    },
    {
      type: 'checkbox',
      label: 'Auto Update',
      action: 'toggle-auto-update',
      enabled: !busy && registry.enabled,
      checked: registry.autoUpdate,
    },
    SEPARATOR,
    ...(isGitHub
      ? [
          {
            type: 'normal',
            label: 'Open on GitHub',
            action: 'open-github',
            enabled: true,
          } as const,
        ]
      : []),
    { type: 'normal', label: 'Copy URL', action: 'copy-url', enabled: true },
    { type: 'normal', label: 'Show in Settings', action: 'show-settings', enabled: true },
    SEPARATOR,
    { type: 'normal', label: 'Remove…', action: 'remove', enabled: !busy },
  ]
}

interface PopupOptions {
  window: BrowserWindow
  x?: number
  y?: number
  callback?: () => void
}

export interface RegistryMenuDeps {
  Menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]): {
      popup(options: PopupOptions): void
    }
  }
  clipboard: { writeText(text: string): void }
  shell: { openExternal(url: string): Promise<void> }
  listRegistries(): Promise<RegistryRecord[]>
}

/** Show the registry menu natively; main runs Copy URL and Open on GitHub itself. */
export function createRegistryMenu(deps: RegistryMenuDeps) {
  function runInMain(registry: RegistryRecord, action: RegistryMenuItemAction): boolean {
    if (action === 'copy-url') {
      deps.clipboard.writeText(registry.url)
      return true
    }
    if (action === 'open-github') {
      void deps.shell.openExternal(
        `https://github.com/${registry.githubOwner}/${registry.githubRepo}`
      )
      return true
    }
    return false
  }

  async function show(
    window: BrowserWindow,
    req: RegistryMenuRequest
  ): Promise<RegistryMenuAction | null> {
    const registry = (await deps.listRegistries()).find((r) => r.id === req.registryId)
    if (!registry) throw new Error(`Registry "${req.registryId}" not found`)
    return new Promise((resolve) => {
      const template = registryMenuTemplate(registry, req.busy).map(
        (item): MenuItemConstructorOptions =>
          item.type === 'separator'
            ? { type: 'separator' }
            : {
                type: item.type,
                label: item.label,
                enabled: item.enabled,
                checked: item.checked,
                click: () =>
                  resolve(
                    runInMain(registry, item.action) ? null : (item.action as RegistryMenuAction)
                  ),
              }
      )
      deps.Menu.buildFromTemplate(template).popup({
        window,
        ...(req.position ? { x: Math.round(req.position.x), y: Math.round(req.position.y) } : {}),
        callback: () => setTimeout(() => resolve(null), 0),
      })
    })
  }

  return { show }
}

export function registerRegistryMenuIpc(
  ipcMain: IpcMain,
  menu: ReturnType<typeof createRegistryMenu>,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(IpcRequest.showRegistryMenu, (_event, req: RegistryMenuRequest) => {
    const window = getWindow()
    if (!window) return null
    return menu.show(window, req)
  })
}
