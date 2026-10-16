import { describe, expect, it } from 'vitest'
import { getTheme, setTheme } from './appSettings'
import { openDatabase } from './db/open'
import { createThemeController } from './theme'

function fakeNativeTheme(): { themeSource: string; shouldUseDarkColors: boolean } {
  const state = { source: 'system' }
  return {
    get themeSource() {
      return state.source
    },
    set themeSource(value: string) {
      state.source = value
    },
    get shouldUseDarkColors() {
      return state.source !== 'light'
    },
  }
}

function controller(stored?: string) {
  const db = openDatabase(':memory:')
  if (stored) db.prepare("INSERT INTO app_setting (key, value) VALUES ('theme', ?)").run(stored)
  const nativeTheme = fakeNativeTheme()
  const theme = createThemeController({
    nativeTheme,
    getTheme: () => getTheme(db),
    setTheme: (value) => setTheme(db, value),
  })
  return { db, nativeTheme, theme }
}

describe('theme controller', () => {
  it('applies the stored theme as the native theme source', () => {
    const { nativeTheme, theme } = controller('light')
    theme.apply()
    expect(nativeTheme.themeSource).toBe('light')
    expect(theme.backgroundColor()).toBe('#ffffff')
  })

  it.each([undefined, 'sepia'])('applies dark when the stored theme is %s', (stored) => {
    const { nativeTheme, theme } = controller(stored)
    theme.apply()
    expect(nativeTheme.themeSource).toBe('dark')
    expect(theme.backgroundColor()).toBe('#09090b')
  })

  it('saves a new theme and applies it at once', () => {
    const { db, nativeTheme, theme } = controller()
    theme.set('system')
    expect(nativeTheme.themeSource).toBe('system')
    expect(getTheme(db)).toBe('system')
    expect(theme.get()).toEqual({ theme: 'system' })
  })

  it('rejects an unknown theme without saving it', () => {
    const { db, theme } = controller()
    expect(() => theme.set('sepia' as never)).toThrow('Theme must be system, light or dark')
    expect(getTheme(db)).toBe('dark')
  })
})
