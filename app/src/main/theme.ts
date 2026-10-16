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

export interface ThemeControllerDeps {
  nativeTheme: { themeSource: Theme | string; readonly shouldUseDarkColors: boolean }
  getTheme: () => Theme
  setTheme: (theme: Theme) => void
  getFontSize: () => FontSize
  setFontSize: (fontSize: FontSize) => void
}

export function createThemeController({
  nativeTheme,
  getTheme,
  setTheme,
  getFontSize,
  setFontSize,
}: ThemeControllerDeps) {
  return {
    apply(): void {
      nativeTheme.themeSource = getTheme()
    },
    get(): Appearance {
      return { theme: getTheme(), fontSize: getFontSize() }
    },
    set(theme: Theme): void {
      if (!THEMES.includes(theme)) throw new Error('Theme must be system, light or dark')
      setTheme(theme)
      nativeTheme.themeSource = theme
    },
    setFontSize(fontSize: FontSize): void {
      if (!FONT_SIZES.includes(fontSize)) {
        throw new Error('Font size must be small, default, large or larger')
      }
      setFontSize(fontSize)
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
  ipcMain.handle(IpcRequest.setFontSize, (_event, value: FontSize) => theme.setFontSize(value))
}
