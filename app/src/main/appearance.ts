import type { IpcMain } from 'electron'
import {
  FONT_SIZES,
  IpcRequest,
  THEMES,
  type Appearance,
  type FontSize,
  type Theme,
} from '../shared/ipc'

/** The window background for each resolved scheme; matches the stylesheet's `--bg`. */
const BACKGROUND = { dark: '#09090b', light: '#ffffff' } as const

export interface AppearanceControllerDeps {
  nativeTheme: { themeSource: Theme | string; readonly shouldUseDarkColors: boolean }
  store: AppearanceStore
}

/** Where the Theme and Font Size are kept. */
export interface AppearanceStore {
  getAppearance(): Appearance
  setAppearance(appearance: Partial<Appearance>): void
}

export function createAppearanceController({ nativeTheme, store }: AppearanceControllerDeps) {
  return {
    apply(): void {
      nativeTheme.themeSource = store.getAppearance().theme
    },
    get(): Appearance {
      return store.getAppearance()
    },
    setTheme(theme: Theme): void {
      if (!THEMES.includes(theme)) throw new Error('Theme must be system, light or dark')
      store.setAppearance({ theme })
      nativeTheme.themeSource = theme
    },
    setFontSize(fontSize: FontSize): void {
      if (!FONT_SIZES.includes(fontSize)) {
        throw new Error('Font size must be small, default, large or larger')
      }
      store.setAppearance({ fontSize })
    },
    backgroundColor(): string {
      return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light
    },
  }
}

export type AppearanceController = ReturnType<typeof createAppearanceController>

export function registerAppearanceIpc(ipcMain: IpcMain, appearance: AppearanceController): void {
  ipcMain.handle(IpcRequest.getAppearance, () => appearance.get())
  ipcMain.handle(IpcRequest.setTheme, (_event, value: Theme) => appearance.setTheme(value))
  ipcMain.handle(IpcRequest.setFontSize, (_event, value: FontSize) => appearance.setFontSize(value))
}
