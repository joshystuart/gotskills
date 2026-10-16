import type { IpcMain } from 'electron'
import { IpcRequest, THEMES, type Appearance, type Theme } from '../shared/ipc'

/** The window background for each resolved scheme; matches the stylesheet's `--bg`. */
const BACKGROUND = { dark: '#09090b', light: '#ffffff' } as const

export interface ThemeControllerDeps {
  nativeTheme: { themeSource: Theme | string; readonly shouldUseDarkColors: boolean }
  getTheme: () => Theme
  setTheme: (theme: Theme) => void
}

export function createThemeController({ nativeTheme, getTheme, setTheme }: ThemeControllerDeps) {
  return {
    apply(): void {
      nativeTheme.themeSource = getTheme()
    },
    get(): Appearance {
      return { theme: getTheme() }
    },
    set(theme: Theme): void {
      if (!THEMES.includes(theme)) throw new Error('Theme must be system, light or dark')
      setTheme(theme)
      nativeTheme.themeSource = theme
    },
    backgroundColor(): string {
      return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light
    },
  }
}

export type ThemeController = ReturnType<typeof createThemeController>

export function registerAppearanceIpc(ipcMain: IpcMain, theme: ThemeController): void {
  ipcMain.handle(IpcRequest.getAppearance, () => theme.get())
  ipcMain.handle(IpcRequest.setTheme, (_event, value: Theme) => theme.set(value))
}
